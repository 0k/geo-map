/**
 * File formats: bytes in, a normalised `GeoDocument` out.
 *
 * KMZ is unzipped with fflate, KML and GPX are converted to GeoJSON by
 * toGeoJSON, GeoJSON is read as is.  Every failure is a `GeoParseError`
 * whose message names the problem, so a host can show it verbatim.
 */

import { gpx, kml } from '@tmcw/togeojson';
import { unzipSync } from 'fflate';
import type { Feature, Geometry, Position } from 'geojson';
import { boundsOf, itemLength, toBytes, type GeoBounds } from './geometry';

export type GeoFormat = 'kmz' | 'kml' | 'gpx' | 'geojson';

export const GEO_FORMATS: readonly GeoFormat[] = ['kmz', 'kml', 'gpx', 'geojson'];

/** What a map can be built from: one geo file, or a YAML descriptor combining several sources. */
export type MapKind = GeoFormat | 'descriptor';

export const MAP_KINDS: readonly MapKind[] = [...GEO_FORMATS, 'descriptor'];

/** Ceiling on the inflated size of the `.kml` entry of a KMZ (zip-bomb guard). */
export const DEFAULT_MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;

export class GeoParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeoParseError';
  }
}

export type GeoItemKind = 'track' | 'place' | 'area' | 'photo';

export interface GeoItemStyle {
  color?: string;
  opacity?: number;
  weight?: number;
}

/**
 * A medium a feature links to: a GPX `<link href>`, or a local
 * `<a href>` / `<img src>` in a KML description.  `href` is as written
 * (usually relative to the map file); the host resolves it.
 */
export interface GeoMedia {
  href: string;
  text: string | null;
  /** `web`: an http(s) page, opened in a new tab. */
  kind: 'audio' | 'image' | 'web';
}

const AUDIO_EXTENSIONS = ['3gpp', '3gp', 'amr', 'ogg', 'oga', 'opus', 'mp3', 'm4a', 'aac', 'wav', 'webm', 'flac'];
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif'];

/** Media kind of a reference, from its extension (query / fragment ignored), or null. */
export function mediaKind(href: string): 'audio' | 'image' | null {
  const match = /\.([A-Za-z0-9]+)(?:[?#].*)?$/.exec(href);
  const ext = match?.[1]?.toLowerCase() ?? '';
  if (AUDIO_EXTENSIONS.includes(ext)) return 'audio';
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
  return null;
}

const REMOTE = /^[a-z][a-z0-9+.-]*:/i;

/** A GPX link: local media by extension, http(s) pages as web links, nothing else. */
function gpxMedia(href: string, text: string | null): GeoMedia | null {
  if (/^https?:/i.test(href)) return { href, text, kind: 'web' };
  if (REMOTE.test(href)) return null;
  const kind = mediaKind(href);
  return kind ? { href, text, kind } : null;
}

/** Local media referenced from description HTML (never remote: it would be fetched). */
function descriptionMedia(html: string): GeoMedia[] {
  if (!/<(a|img)\b/i.test(html)) return [];
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out: GeoMedia[] = [];
  for (const node of Array.from(doc.querySelectorAll('a[href], img[src]'))) {
    const href = (node.getAttribute(node.localName === 'a' ? 'href' : 'src') ?? '').trim();
    if (!href || REMOTE.test(href) || href.startsWith('//')) continue;
    const kind = mediaKind(href);
    if (!kind) continue;
    out.push({ href, text: node.localName === 'a' ? clean(node.textContent) : clean(node.getAttribute('alt')), kind });
  }
  return out;
}

function mediaOf(props: Record<string, unknown>, description: string | null): GeoMedia[] {
  const out: GeoMedia[] = [];
  if (Array.isArray(props.links)) {
    for (const link of props.links as { href?: unknown; text?: unknown }[]) {
      const href = clean(link?.href);
      const media = href ? gpxMedia(href, clean(link.text)) : null;
      if (media) out.push(media);
    }
  }
  if (description) out.push(...descriptionMedia(description));
  const seen = new Set<string>();
  return out.filter((media) => !seen.has(media.href) && (seen.add(media.href), true));
}

/** A photo shown on the map (descriptor maps only). */
export interface GeoPhoto {
  /** The host reference the descriptor gave (`photos[].path`). */
  ref: string;
  /** Full-size image URL from `host.photoUrl`, or null. */
  url: string | null;
  /** Small image for the marker: the embedded EXIF thumbnail, else `url`. */
  thumbUrl: string | null;
  /** True when `thumbUrl` is the raw EXIF thumbnail, whose pixels are not rotated. */
  thumbNeedsOrientation: boolean;
  orientation: number | null;
  caption: string | null;
}

export interface GeoItem {
  /** Index in `GeoDocument.items`. */
  id: number;
  kind: GeoItemKind;
  name: string | null;
  /** Raw description text (KML descriptions are usually HTML). */
  description: string | null;
  geometry: Geometry;
  /** Length along the line in metres; null for places and areas. */
  lengthMeters: number | null;
  /** ISO 8601 first / last timestamps, when the file records time. */
  start: string | null;
  end: string | null;
  /** Colours the file itself asks for. */
  style: GeoItemStyle;
  /** Set for `kind === 'photo'`. */
  photo?: GeoPhoto;
  /** Media the feature links to. */
  media: GeoMedia[];
  /**
   * The file the feature comes from, as the host named it (a descriptor
   * layer's `file`); null for the map's own file.  Media resolve against it.
   */
  source: string | null;
}

export interface GeoDocument {
  format: MapKind;
  name: string | null;
  description: string | null;
  items: GeoItem[];
  bounds: GeoBounds;
  /** Parts that could not be shown, each naming the source and the reason. */
  notes: string[];
}

export interface ParseOptions {
  maxUncompressedBytes?: number;
}

const EXTENSIONS: Record<string, GeoFormat> = {
  kmz: 'kmz',
  kml: 'kml',
  gpx: 'gpx',
  geojson: 'geojson',
};

/** Format from a file name's extension, or null when unsupported. */
export function detectFormat(name: string): GeoFormat | null {
  const match = /\.([A-Za-z0-9]+)$/.exec(name);
  return match ? EXTENSIONS[match[1]!.toLowerCase()] ?? null : null;
}

/** `detectFormat`, plus `.yml` / `.yaml` as a descriptor. */
export function detectMapKind(name: string): MapKind | null {
  return /\.ya?ml$/i.test(name) ? 'descriptor' : detectFormat(name);
}

function asBytes(data: ArrayBuffer | Uint8Array): Uint8Array {
  return toBytes(data);
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

/** The `.kml` entry a KMZ is about: `doc.kml` if present, else the shallowest one. */
function kmzEntry(bytes: Uint8Array, limit: number): Uint8Array {
  const names: string[] = [];
  const sizes = new Map<string, number>();
  try {
    unzipSync(bytes, {
      filter(file) {
        if (file.name.toLowerCase().endsWith('.kml')) {
          names.push(file.name);
          sizes.set(file.name, file.originalSize);
        }
        return false;
      },
    });
  } catch (error) {
    throw new GeoParseError(`not a valid KMZ (zip) archive: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!names.length) throw new GeoParseError('this KMZ archive contains no .kml document');
  const depth = (name: string): number => name.split('/').length;
  const chosen = names.find((name) => name.toLowerCase() === 'doc.kml')
    ?? [...names].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))[0]!;
  const size = sizes.get(chosen) ?? 0;
  if (size > limit) {
    throw new GeoParseError(`${chosen} inflates to ${size} bytes, which exceeds the ${limit}-byte limit`);
  }
  const files = unzipSync(bytes, { filter: (file) => file.name === chosen });
  const entry = files[chosen];
  if (!entry) throw new GeoParseError(`cannot read ${chosen} from this KMZ archive`);
  return entry;
}

function parseXml(text: string, root: 'kml' | 'gpx'): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    throw new GeoParseError('not well-formed XML');
  }
  const found = doc.documentElement?.localName ?? '';
  if (found !== root) throw new GeoParseError(`expected a <${root}> document, found <${found}>`);
  return doc;
}

/** Text of the first direct child `<tag>` of `parent`. */
function childText(parent: Element | null | undefined, tag: string): string | null {
  if (!parent) return null;
  for (const child of Array.from(parent.children)) {
    if (child.localName === tag) return clean(child.textContent);
  }
  return null;
}

function firstChild(parent: Element | null | undefined, tags: readonly string[]): Element | null {
  if (!parent) return null;
  return Array.from(parent.children).find((child) => tags.includes(child.localName)) ?? null;
}

function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** toGeoJSON gives descriptions either as strings or as `{ "@type": "html", value }`. */
function textProp(value: unknown): string | null {
  if (typeof value === 'object' && value !== null && 'value' in value) {
    return clean((value as { value: unknown }).value);
  }
  return clean(value);
}

function kindOf(geometry: Geometry): GeoItemKind {
  switch (geometry.type) {
    case 'Point':
    case 'MultiPoint':
      return 'place';
    case 'LineString':
    case 'MultiLineString':
      return 'track';
    case 'Polygon':
    case 'MultiPolygon':
      return 'area';
    case 'GeometryCollection': {
      const kinds = geometry.geometries.map(kindOf);
      if (kinds.includes('track')) return 'track';
      if (kinds.includes('area')) return 'area';
      return 'place';
    }
  }
}

function flatStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(flatStrings);
  return [];
}

function timesOf(props: Record<string, unknown>): { start: string | null; end: string | null } {
  const coordinate = props.coordinateProperties as Record<string, unknown> | undefined;
  const times = flatStrings(coordinate?.times).filter(Boolean);
  if (times.length) return { start: times[0]!, end: times[times.length - 1]! };
  const span = props.timespan as { begin?: unknown; end?: unknown } | undefined;
  if (span) return { start: clean(span.begin), end: clean(span.end) };
  const stamp = clean(props.timestamp) ?? clean(props.time);
  return { start: stamp, end: stamp };
}

function styleOf(props: Record<string, unknown>): GeoItemStyle {
  const style: GeoItemStyle = {};
  const color = clean(props.stroke) ?? clean(props['marker-color']) ?? clean(props['icon-color']);
  if (color && /^#[0-9a-f]{3,8}$/i.test(color)) style.color = color;
  const opacity = props['stroke-opacity'];
  if (typeof opacity === 'number' && Number.isFinite(opacity)) style.opacity = opacity;
  const weight = props['stroke-width'];
  if (typeof weight === 'number' && Number.isFinite(weight) && weight > 0) style.weight = weight;
  return style;
}

export function toItems(features: readonly Feature<Geometry | null>[]): GeoItem[] {
  const items: GeoItem[] = [];
  for (const feature of features) {
    const geometry = feature.geometry;
    if (!geometry || !hasCoordinates(geometry)) continue;
    const props = (feature.properties ?? {}) as Record<string, unknown>;
    const kind = kindOf(geometry);
    const description = textProp(props.description) ?? textProp(props.desc);
    items.push({
      id: items.length,
      kind,
      name: clean(props.name),
      description,
      geometry,
      lengthMeters: kind === 'track' ? itemLength(geometry) : null,
      ...timesOf(props),
      style: styleOf(props),
      media: mediaOf(props, description),
      source: null,
    });
  }
  return items;
}

function hasCoordinates(geometry: Geometry): boolean {
  if (geometry.type === 'GeometryCollection') return geometry.geometries.some(hasCoordinates);
  const walk = (value: unknown): boolean => Array.isArray(value)
    && (typeof value[0] === 'number' ? value.length >= 2 : value.some(walk));
  return walk((geometry as { coordinates: Position | unknown[] }).coordinates);
}

function readGeoJson(text: string): { name: string | null; features: Feature<Geometry | null>[] } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new GeoParseError(`not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const object = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const name = clean(object.name);
  if (object.type === 'FeatureCollection' && Array.isArray(object.features)) {
    return { name, features: object.features as Feature<Geometry | null>[] };
  }
  if (object.type === 'Feature') return { name, features: [object as unknown as Feature<Geometry | null>] };
  if (typeof object.type === 'string' && ('coordinates' in object || 'geometries' in object)) {
    return { name, features: [{ type: 'Feature', properties: {}, geometry: object as unknown as Geometry }] };
  }
  throw new GeoParseError('not GeoJSON: expected a FeatureCollection, a Feature or a Geometry');
}

/** Parse a whole file.  Throws `GeoParseError` on any problem. */
export function parseGeoFile(data: ArrayBuffer | Uint8Array, format: GeoFormat, options: ParseOptions = {}): GeoDocument {
  const bytes = asBytes(data);
  const limit = options.maxUncompressedBytes ?? DEFAULT_MAX_UNCOMPRESSED_BYTES;
  let name: string | null = null;
  let description: string | null = null;
  let features: Feature<Geometry | null>[];
  if (format === 'geojson') {
    ({ name, features } = readGeoJson(decode(bytes)));
  } else if (format === 'gpx') {
    const doc = parseXml(decode(bytes), 'gpx');
    const metadata = firstChild(doc.documentElement, ['metadata']);
    name = childText(metadata, 'name');
    description = childText(metadata, 'desc');
    features = gpx(doc).features;
  } else {
    const doc = parseXml(decode(format === 'kmz' ? kmzEntry(bytes, limit) : bytes), 'kml');
    const container = firstChild(doc.documentElement, ['Document', 'Folder']);
    name = childText(container, 'name');
    description = childText(container, 'description');
    features = kml(doc, { skipNullGeometry: true }).features;
  }
  const items = toItems(features);
  if (!items.length) throw new GeoParseError('no tracks or places in this file');
  return { format, name, description, items, bounds: boundsOf(items.map((item) => item.geometry)), notes: [] };
}
