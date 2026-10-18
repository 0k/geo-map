/**
 * The map descriptor: a small YAML file combining several sources on one
 * map — track / place files, photos, and hand-written pins.
 *
 * File and photo references are opaque strings to this package: the host
 * resolves them (typically relative to the descriptor's folder).  Unknown
 * keys are errors, so a typo never silently drops data.
 */

import { parse } from 'yaml';

export class MapDescriptorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MapDescriptorError';
  }
}

export type LatLon = [number, number];

export interface DescriptorLayer {
  file: string;
  /** Overrides the colour of every line / area / place of the file. */
  color: string | null;
  /** Overrides the name of the file's single track (if exactly one). */
  name: string | null;
}

export interface DescriptorPhoto {
  path: string;
  caption: string | null;
  /** Position to use instead of (or in absence of) the photo's GPS data. */
  at: LatLon | null;
}

export interface DescriptorPlace {
  name: string;
  at: LatLon;
  /** Markdown, rendered by the host. */
  note: string | null;
}

export interface MapDescriptor {
  title: string | null;
  basemap: string | null;
  layers: DescriptorLayer[];
  photos: DescriptorPhoto[];
  places: DescriptorPlace[];
}

type Raw = Record<string, unknown>;

function mapping(value: unknown, where: string): Raw {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MapDescriptorError(where ? `${where}: expected a mapping` : 'the descriptor must be a mapping');
  }
  return value as Raw;
}

function onlyKeys(value: Raw, keys: readonly string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      throw new MapDescriptorError(`${where ? `${where}: ` : ''}unknown key "${key}" (expected ${keys.join(', ')})`);
    }
  }
}

function required(value: unknown, where: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new MapDescriptorError(`${where}: a non-empty string is required`);
  return value.trim();
}

function optional(value: unknown, where: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new MapDescriptorError(`${where}: expected a string`);
  return value.trim() || null;
}

function latLon(value: unknown, where: string): LatLon {
  const ok = Array.isArray(value) && value.length === 2
    && value.every((v) => typeof v === 'number' && Number.isFinite(v))
    && Math.abs(value[0] as number) <= 90 && Math.abs(value[1] as number) <= 180;
  if (!ok) throw new MapDescriptorError(`${where}: expected [latitude, longitude] in degrees`);
  return [value[0] as number, value[1] as number];
}

function list(value: unknown, where: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new MapDescriptorError(`${where}: expected a list`);
  return value;
}

const TOP_KEYS = ['title', 'basemap', 'layers', 'photos', 'places'] as const;
const LAYER_KEYS = ['file', 'color', 'name'] as const;
const PHOTO_KEYS = ['path', 'caption', 'at'] as const;
const PLACE_KEYS = ['name', 'at', 'note'] as const;

export function parseMapDescriptor(text: string): MapDescriptor {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    throw new MapDescriptorError(`invalid YAML: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
  }
  const top = mapping(raw, '');
  onlyKeys(top, TOP_KEYS, '');

  const layers = list(top.layers, 'layers').map((value, i): DescriptorLayer => {
    const where = `layers[${i}]`;
    const layer = mapping(value, where);
    onlyKeys(layer, LAYER_KEYS, where);
    const color = optional(layer.color, `${where}.color`);
    if (color !== null && !/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(color)) {
      throw new MapDescriptorError(`${where}.color: expected a #rgb or #rrggbb colour`);
    }
    return { file: required(layer.file, `${where}.file`), color, name: optional(layer.name, `${where}.name`) };
  });

  const photos = list(top.photos, 'photos').map((value, i): DescriptorPhoto => {
    const where = `photos[${i}]`;
    const photo = mapping(value, where);
    onlyKeys(photo, PHOTO_KEYS, where);
    return {
      path: required(photo.path, `${where}.path`),
      caption: optional(photo.caption, `${where}.caption`),
      at: photo.at === undefined ? null : latLon(photo.at, `${where}.at`),
    };
  });

  const places = list(top.places, 'places').map((value, i): DescriptorPlace => {
    const where = `places[${i}]`;
    const place = mapping(value, where);
    onlyKeys(place, PLACE_KEYS, where);
    return {
      name: required(place.name, `${where}.name`),
      at: latLon(place.at, `${where}.at`),
      note: optional(place.note, `${where}.note`),
    };
  });

  if (!layers.length && !photos.length && !places.length) {
    throw new MapDescriptorError('nothing to show: add layers, photos or places');
  }
  return {
    title: optional(top.title, 'title'),
    basemap: optional(top.basemap, 'basemap'),
    layers,
    photos,
    places,
  };
}
