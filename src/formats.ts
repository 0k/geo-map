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
import { boundsOf, itemLength, type GeoBounds } from './geometry';

export type GeoFormat = 'kmz' | 'kml' | 'gpx' | 'geojson';

export const GEO_FORMATS: readonly GeoFormat[] = ['kmz', 'kml', 'gpx', 'geojson'];

/** Ceiling on the inflated size of the `.kml` entry of a KMZ (zip-bomb guard). */
export const DEFAULT_MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;

export class GeoParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeoParseError';
  }
}

export type GeoItemKind = 'track' | 'place' | 'area';

export interface GeoItemStyle {
  color?: string;
  opacity?: number;
  weight?: number;
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
}

export interface GeoDocument {
  format: GeoFormat;
  name: string | null;
  description: string | null;
  items: GeoItem[];
  bounds: GeoBounds;
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

function asBytes(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
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

function toItems(features: readonly Feature<Geometry | null>[]): GeoItem[] {
  const items: GeoItem[] = [];
  for (const feature of features) {
    const geometry = feature.geometry;
    if (!geometry || !hasCoordinates(geometry)) continue;
    const props = (feature.properties ?? {}) as Record<string, unknown>;
    const kind = kindOf(geometry);
    items.push({
      id: items.length,
      kind,
      name: clean(props.name),
      description: textProp(props.description) ?? textProp(props.desc),
      geometry,
      lengthMeters: kind === 'track' ? itemLength(geometry) : null,
      ...timesOf(props),
      style: styleOf(props),
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
  return { format, name, description, items, bounds: boundsOf(items.map((item) => item.geometry)) };
}
