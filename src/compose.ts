/**
 * Build one `GeoDocument` from a map descriptor: every layer file, photo
 * and hand-written place, fetched through the host.
 *
 * A part that fails (missing file, unreadable track, photo without a
 * position) becomes a note naming it and the reason; the map still shows
 * the rest.  Only a descriptor with nothing showable fails as a whole.
 */

import { parseMapDescriptor, type DescriptorLayer, type DescriptorPhoto } from './descriptor';
import { detectFormat, GeoParseError, parseGeoFile, type GeoDocument, type GeoItem } from './formats';
import { readPhotoMeta } from './exif';
import { boundsOf } from './geometry';

/** Bytes of a photo read for its EXIF block: far more than the 64 KiB EXIF limit plus a JFIF header. */
export const PHOTO_HEADER_BYTES = 256 * 1024;

export interface RefLoader {
  loadRef?(ref: string, signal: AbortSignal, options?: { maxBytes?: number }): Promise<ArrayBuffer | Uint8Array>;
  photoUrl?(ref: string): string;
}

export interface ComposedMap {
  doc: GeoDocument;
  /** Requested basemap id, if the descriptor names one. */
  basemap: string | null;
  /** Object URLs this document owns (revoke on teardown). */
  blobUrls: string[];
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function basename(ref: string): string {
  return ref.split('/').pop() || ref;
}

type Part = { items: Omit<GeoItem, 'id'>[]; notes: string[]; blobUrls: string[] };

async function layerPart(layer: DescriptorLayer, host: RefLoader, signal: AbortSignal): Promise<Part> {
  const format = detectFormat(layer.file);
  if (!format) return { items: [], notes: [`${layer.file}: unsupported file type (expected .kmz, .kml, .gpx or .geojson)`], blobUrls: [] };
  try {
    const bytes = await host.loadRef!(layer.file, signal);
    const items: Omit<GeoItem, 'id'>[] = parseGeoFile(bytes, format).items;
    if (layer.color) for (const item of items) item.style = { ...item.style, color: layer.color, opacity: 1 };
    const tracks = items.filter((item) => item.kind === 'track');
    if (layer.name && tracks.length === 1) tracks[0]!.name = layer.name;
    return { items, notes: [], blobUrls: [] };
  } catch (error) {
    return { items: [], notes: [`${layer.file}: ${reason(error)}`], blobUrls: [] };
  }
}

async function photoPart(photo: DescriptorPhoto, host: RefLoader, signal: AbortSignal): Promise<Part> {
  let meta = readPhotoMeta(new Uint8Array(0));
  let loadError: string | null = null;
  try {
    meta = readPhotoMeta(await host.loadRef!(photo.path, signal, { maxBytes: PHOTO_HEADER_BYTES }));
  } catch (error) {
    loadError = reason(error);
  }
  if (loadError && !photo.at) return { items: [], notes: [`${photo.path}: ${loadError}`], blobUrls: [] };
  const position = photo.at ?? (meta.lat !== null && meta.lon !== null ? [meta.lat, meta.lon] : null);
  if (!position) return { items: [], notes: [`${photo.path}: no GPS position in the photo (add \`at:\`)`], blobUrls: [] };
  const url = host.photoUrl?.(photo.path) ?? null;
  const blobUrls: string[] = [];
  let thumbUrl = url;
  if (meta.thumbnail) {
    thumbUrl = URL.createObjectURL(new Blob([meta.thumbnail], { type: 'image/jpeg' }));
    blobUrls.push(thumbUrl);
  }
  const item: Omit<GeoItem, 'id'> = {
    kind: 'photo',
    name: photo.caption ?? basename(photo.path),
    description: null,
    geometry: { type: 'Point', coordinates: [position[1], position[0]] },
    lengthMeters: null,
    start: meta.takenAt,
    end: meta.takenAt,
    style: {},
    photo: {
      ref: photo.path,
      url,
      thumbUrl,
      thumbNeedsOrientation: meta.thumbnail !== null,
      orientation: meta.orientation,
      caption: photo.caption,
    },
  };
  return { items: [item], notes: [], blobUrls };
}

export async function composeDescriptor(text: string, host: RefLoader, signal: AbortSignal): Promise<ComposedMap> {
  const descriptor = parseMapDescriptor(text);
  if ((descriptor.layers.length || descriptor.photos.length) && !host.loadRef) {
    throw new GeoParseError('this host cannot load the files a descriptor refers to');
  }
  const parts = await Promise.all([
    ...descriptor.layers.map((layer) => layerPart(layer, host, signal)),
    ...descriptor.photos.map((photo) => photoPart(photo, host, signal)),
  ]);
  const placeItems: Omit<GeoItem, 'id'>[] = descriptor.places.map((place) => ({
    kind: 'place',
    name: place.name,
    description: place.note,
    geometry: { type: 'Point', coordinates: [place.at[1], place.at[0]] },
    lengthMeters: null,
    start: null,
    end: null,
    style: {},
  }));
  const blobUrls = parts.flatMap((part) => part.blobUrls);
  const notes = parts.flatMap((part) => part.notes);
  const items: GeoItem[] = [...parts.flatMap((part) => part.items), ...placeItems].map((item, id) => ({ ...item, id }));
  if (!items.length) {
    for (const url of blobUrls) URL.revokeObjectURL(url);
    throw new GeoParseError(`nothing could be shown (${notes.join('; ')})`);
  }
  return {
    doc: {
      format: 'descriptor',
      name: descriptor.title,
      description: null,
      items,
      bounds: boundsOf(items.map((item) => item.geometry)),
      notes,
    },
    basemap: descriptor.basemap,
    blobUrls,
  };
}
