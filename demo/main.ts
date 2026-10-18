/**
 * Demo / browser-test harness: one widget per synthetic fixture.  The KMZ
 * is zipped in the page from `track.kml`, so no binary fixture is needed.
 */
import { strToU8, zipSync } from 'fflate';
import { createGeoMap, detectFormat, type GeoMapHandle } from '../src/index';
// Hosts import the stylesheet explicitly, as `@0k/geo-map/style.css`.
import 'leaflet/dist/leaflet.css';
import '../src/style.css';

declare global {
  interface Window {
    demoHandles: Record<string, GeoMapHandle>;
    demoReady: Promise<void>;
  }
}

async function bytes(name: string): Promise<Uint8Array> {
  if (name === 'track.kmz') {
    const kml = await (await fetch('./track.kml')).text();
    return zipSync({ 'doc.kml': strToU8(kml) });
  }
  const response = await fetch(`./${name}`);
  if (!response.ok) throw new Error(`File request failed: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

const names = ['track.kmz', 'places.kml', 'trip.gpx', 'shapes.geojson', 'missing.kml'];
const container = document.getElementById('maps')!;
window.demoHandles = {};
window.demoReady = Promise.all(names.map((name) => {
  const root = document.createElement('div');
  root.className = 'slot';
  root.dataset.file = name;
  container.appendChild(root);
  const handle = createGeoMap(root, {
    loadFile: () => bytes(name),
    renderDescription: (text) => text.replace(/</g, '&lt;'),
  }, { format: detectFormat(name)!, label: name });
  window.demoHandles[name] = handle;
  return handle.open();
})).then(() => undefined);
