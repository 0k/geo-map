/**
 * Free basemaps.  Every preset is built from OpenStreetMap data (ODbL)
 * and served by a community tile service whose usage policy permits
 * light interactive use with attribution:
 *
 * - osm: https://operations.osmfoundation.org/policies/tiles/
 * - opentopomap: https://opentopomap.org/about (CC-BY-SA)
 * - cyclosm / osm-hot: hosted by OpenStreetMap France
 *   (https://www.openstreetmap.fr/fonds-de-carte/)
 *
 * The widget honours those policies by construction: it shows the
 * attribution at all times, never prefetches or bulk-downloads tiles,
 * never requests beyond `maxZoom`, and lets the browser send its normal
 * User-Agent and Referer.
 */

export interface Basemap {
  id: string;
  label: string;
  /** Leaflet URL template. */
  url: string;
  /** HTML; shown in the attribution control at all times. */
  attribution: string;
  maxZoom: number;
  subdomains?: string;
}

const OSM_DATA = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

export const BASEMAPS = {
  osm: {
    id: 'osm',
    label: 'OpenStreetMap',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: OSM_DATA,
    maxZoom: 19,
  },
  opentopomap: {
    id: 'opentopomap',
    label: 'OpenTopoMap',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    subdomains: 'abc',
    attribution: `Map data: ${OSM_DATA}, SRTM | Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)`,
    maxZoom: 17,
  },
  cyclosm: {
    id: 'cyclosm',
    label: 'CyclOSM',
    url: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
    subdomains: 'abc',
    attribution: `<a href="https://github.com/cyclosm/cyclosm-cartocss-style/releases">CyclOSM</a> hosted by <a href="https://openstreetmap.fr/">OpenStreetMap France</a> | Map data: ${OSM_DATA}`,
    maxZoom: 20,
  },
  'osm-hot': {
    id: 'osm-hot',
    label: 'Humanitarian',
    url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
    subdomains: 'abc',
    attribution: `${OSM_DATA}, Tiles style by <a href="https://www.hotosm.org/">Humanitarian OpenStreetMap Team</a> hosted by <a href="https://openstreetmap.fr/">OpenStreetMap France</a>`,
    maxZoom: 19,
  },
} as const satisfies Record<string, Basemap>;

export const DEFAULT_BASEMAPS: readonly Basemap[] = [BASEMAPS.osm, BASEMAPS.opentopomap, BASEMAPS.cyclosm, BASEMAPS['osm-hot']];
