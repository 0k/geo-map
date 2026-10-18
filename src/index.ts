import 'leaflet/dist/leaflet.css';
import './style.css';

export { createGeoMap, ROOT_CLASS, summaryText, itemMeta } from './map';
export type { GeoMapHost, GeoMapHandle, GeoMapLayout, GeoMapOptions, GeoMapPhoto } from './map';
export {
  parseGeoFile,
  detectFormat,
  detectMapKind,
  mediaKind,
  GeoParseError,
  GEO_FORMATS,
  MAP_KINDS,
  DEFAULT_MAX_UNCOMPRESSED_BYTES,
} from './formats';
export type { GeoDocument, GeoFormat, GeoItem, GeoItemKind, GeoItemStyle, GeoMedia, GeoPhoto, MapKind, ParseOptions } from './formats';
export { parseMapDescriptor, MapDescriptorError } from './descriptor';
export type { MapDescriptor, DescriptorLayer, DescriptorPhoto, DescriptorPlace, LatLon } from './descriptor';
export { readPhotoMeta } from './exif';
export type { PhotoMeta } from './exif';
export { PHOTO_HEADER_BYTES } from './compose';
export { BASEMAPS, DEFAULT_BASEMAPS } from './basemaps';
export type { Basemap } from './basemaps';
export { haversine, formatLength, formatDuration } from './geometry';
export type { GeoBounds } from './geometry';
