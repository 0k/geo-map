import 'leaflet/dist/leaflet.css';
import './style.css';

export { createGeoMap, ROOT_CLASS, summaryText, itemMeta } from './map.js';
export type { GeoMapHost, GeoMapHandle, GeoMapLayout, GeoMapOptions, GeoMapPhoto } from './map.js';
export {
  parseGeoFile,
  detectFormat,
  detectMapKind,
  mediaKind,
  GeoParseError,
  GEO_FORMATS,
  MAP_KINDS,
  DEFAULT_MAX_UNCOMPRESSED_BYTES,
} from './formats.js';
export type { GeoDocument, GeoFormat, GeoItem, GeoItemKind, GeoItemStyle, GeoMedia, GeoPhoto, MapKind, ParseOptions } from './formats.js';
export { parseMapDescriptor, MapDescriptorError } from './descriptor.js';
export type { MapDescriptor, DescriptorLayer, DescriptorPhoto, DescriptorPlace, LatLon } from './descriptor.js';
export { readPhotoMeta } from './exif.js';
export type { PhotoMeta } from './exif.js';
export { PHOTO_HEADER_BYTES } from './compose.js';
export { BASEMAPS, DEFAULT_BASEMAPS } from './basemaps.js';
export type { Basemap } from './basemaps.js';
export { haversine, formatLength, formatDuration } from './geometry.js';
export type { GeoBounds } from './geometry.js';
