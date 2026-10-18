/** Pure geometry helpers over GeoJSON positions (`[lon, lat, …]`). */

import type { Geometry, Position } from 'geojson';

export interface GeoBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** Mean Earth radius (IUGG), metres. */
const EARTH_RADIUS_M = 6371008.8;

const rad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance between two positions, metres. */
export function haversine(a: Position, b: Position): number {
  const [lon1, lat1] = a as [number, number];
  const [lon2, lat2] = b as [number, number];
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function lineLength(line: readonly Position[]): number {
  let total = 0;
  for (let i = 1; i < line.length; i += 1) total += haversine(line[i - 1]!, line[i]!);
  return total;
}

/** Total length of the line parts of a geometry, metres. */
export function itemLength(geometry: Geometry): number {
  switch (geometry.type) {
    case 'LineString':
      return lineLength(geometry.coordinates);
    case 'MultiLineString':
      return geometry.coordinates.reduce((sum, line) => sum + lineLength(line), 0);
    case 'GeometryCollection':
      return geometry.geometries.reduce((sum, part) => sum + itemLength(part), 0);
    default:
      return 0;
  }
}

/** Every position of a geometry, in order. */
export function positions(geometry: Geometry): Position[] {
  switch (geometry.type) {
    case 'Point':
      return [geometry.coordinates];
    case 'MultiPoint':
    case 'LineString':
      return geometry.coordinates;
    case 'MultiLineString':
    case 'Polygon':
      return geometry.coordinates.flat();
    case 'MultiPolygon':
      return geometry.coordinates.flat(2);
    case 'GeometryCollection':
      return geometry.geometries.flatMap(positions);
  }
}

/** The line parts of a geometry (for start / end markers). */
export function lines(geometry: Geometry): Position[][] {
  switch (geometry.type) {
    case 'LineString':
      return [geometry.coordinates];
    case 'MultiLineString':
      return geometry.coordinates;
    case 'GeometryCollection':
      return geometry.geometries.flatMap(lines);
    default:
      return [];
  }
}

export function boundsOf(geometries: readonly Geometry[]): GeoBounds {
  const bounds: GeoBounds = { south: Infinity, west: Infinity, north: -Infinity, east: -Infinity };
  for (const geometry of geometries) {
    for (const [lon, lat] of positions(geometry) as [number, number][]) {
      if (lat < bounds.south) bounds.south = lat;
      if (lat > bounds.north) bounds.north = lat;
      if (lon < bounds.west) bounds.west = lon;
      if (lon > bounds.east) bounds.east = lon;
    }
  }
  return bounds;
}

/** "850 m", "1.9 km", "42 km". */
export function formatLength(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  const km = meters / 1000;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

/** "45 min", "1 h 05". */
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * Bytes as a `Uint8Array`, from either a typed array (of any realm: an
 * iframe's or a test environment's `Uint8Array` fails `instanceof`) or an
 * `ArrayBuffer`.
 */
export function toBytes(data: ArrayBuffer | Uint8Array): Uint8Array {
  return ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
}
