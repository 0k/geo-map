# @0k/geo-map

Reusable, framework-free TypeScript map widget (Leaflet 1.9.4, exact-pinned
dependency) that shows KMZ / KML / GPX / GeoJSON tracks and places over
free OpenStreetMap-based basemaps.  Hosts own fetching, authorisation,
description rendering (sanitised HTML) and theme; the package owns
parsing, Leaflet, layout, popups, the item list and teardown.

## Blocking rules

- The package never sees a URL, a file path, or a transport for the DATA.
  Every byte of the file comes through `GeoMapHost.loadFile`.  The only
  network traffic the widget may cause is basemap tiles.
- NEVER fetch the icons or images a KML references (Google-hosted icon
  URLs): markers are drawn as SVG.  Descriptions go through
  `host.renderDescription`, which must return SAFE HTML; without it they
  are shown as plain text.
- Basemaps are free sources only (OpenStreetMap data and community tile
  services).  Every preset keeps its attribution visible, its native
  `maxZoom`, and HTTPS.  Never add prefetching, bulk download, or a tile
  URL from a proprietary provider (Google, Bing, Mapbox, Esri, HERE...);
  `test/basemaps.spec.ts` enforces this.
- The runtime libraries (Leaflet, `@tmcw/togeojson`, `fflate`, `yaml`, plus
  `@types/leaflet` and `@types/geojson`, which the published declarations
  import) are `dependencies` pinned EXACTLY; nothing is bundled and there
  is no peer dependency.  `tsc` emits ES2020 ESM only; the host's bundler
  targets Chrome 91, and `npm run check:chrome91` audits `dist/` and each
  pinned library's browser entry (Android WebView 91).
- KMZ inflation is bounded (`maxUncompressedBytes`) BEFORE inflating.
- Every widget style hangs from `.gm-root`; colours are `--gm-*` variables
  declared on `.gm-root`.  `src/index.ts` imports Leaflet's own stylesheet
  unmodified.
- Teardown (`destroy()`) is idempotent and releases the fetch, the Leaflet
  map, observers, listeners and the full-screen portal.
- Tests use the synthetic fixtures in `test/fixtures/` only; never commit
  real personal tracks.
- Verify with `npm run check` (unit tests, typecheck, build, Chrome 91
  audit, demo build, real-Chrome acceptance with tiles stubbed).

## Delivery

Published to npm as `@0k/geo-map` with `pkg`, from a git tag.  To review
an unreleased change in a host, run `npm install --no-save
<path-to-checkout>` there.
