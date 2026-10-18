import { describe, expect, it } from 'vitest';
import { BASEMAPS, DEFAULT_BASEMAPS } from '../src/basemaps';

describe('basemaps', () => {
  it('only offers free, OpenStreetMap-based tile services, over https, with attribution', () => {
    expect(DEFAULT_BASEMAPS.map((b) => b.id)).toEqual(['osm', 'opentopomap', 'cyclosm', 'osm-hot']);
    for (const basemap of Object.values(BASEMAPS)) {
      expect(basemap.url).toMatch(/^https:\/\//);
      expect(basemap.url).not.toMatch(/google|gstatic|bing|virtualearth|mapbox|arcgis|here\.com/i);
      expect(basemap.attribution).toMatch(/OpenStreetMap/);
      expect(basemap.maxZoom).toBeGreaterThan(10);
    }
  });

  it('uses the canonical OSM tile URL with its native zoom ceiling', () => {
    expect(BASEMAPS.osm).toMatchObject({ url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19 });
    expect(BASEMAPS.osm.attribution).toContain('https://www.openstreetmap.org/copyright');
  });
});
