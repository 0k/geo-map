/**
 * Demo / browser-test harness: one widget per synthetic fixture.  The KMZ
 * is zipped in the page from `track.kml`, so no binary fixture is needed.
 */
import { strToU8, zipSync } from 'fflate';
import { syntheticJpeg } from '../test/jpeg';
import { createGeoMap, detectMapKind, type GeoMapHandle, type GeoMapPhoto } from '../src/index';
// Hosts import the stylesheet explicitly, as `@0k/geo-map/style.css`.
import 'leaflet/dist/leaflet.css';
import '../src/style.css';

declare global {
  interface Window {
    demoHandles: Record<string, GeoMapHandle>;
    demoReady: Promise<void>;
    demoOpened: { list: GeoMapPhoto[]; index: number } | null;
  }
}

/** A real, decodable little JPEG of one colour (for photo thumbnails). */
async function solidJpeg(color: string): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 48;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 64, 48);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 64, 8); // a white band on top shows the rotation
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/jpeg', 0.9));
  return new Uint8Array(await blob.arrayBuffer());
}

/** A 0.5 s, 8 kHz mono WAV tone: a playable stand-in for a linked recording. */
function toneWavUrl(): string {
  const rate = 8000;
  const samples = rate / 2;
  const view = new DataView(new ArrayBuffer(44 + samples * 2));
  const ascii = (at: number, text: string): void => { for (let i = 0; i < text.length; i += 1) view.setUint8(at + i, text.charCodeAt(i)); };
  ascii(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, 'data'); view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i += 1) view.setInt16(44 + i * 2, Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)), true);
  return URL.createObjectURL(new Blob([view.buffer], { type: 'audio/wav' }));
}

const TONE = toneWavUrl();

const DESCRIPTOR = `title: Ridge trip
layers:
  - file: track.kmz
    color: '#2f7fe0'
photos:
  - path: geo.jpg
    caption: Steps
  - path: placed.jpg
    at: [44.999, 10.014]
  - path: missing.jpg
places:
  - name: Hut
    at: [45.004, 10.002]
    note: Slept **here**
`;

const photos: Record<string, () => Promise<Uint8Array>> = {
  'geo.jpg': async () => syntheticJpeg({ lat: 45.008, lon: 10.008, takenAt: '2020:05:17 08:04:02', orientation: 6, thumbnail: await solidJpeg('#c0392b') }),
  'placed.jpg': async () => syntheticJpeg({ thumbnail: await solidJpeg('#27ae60') }),
};

async function bytes(name: string): Promise<Uint8Array> {
  if (name === 'map.yml') return strToU8(DESCRIPTOR);
  if (photos[name]) return photos[name]!();
  if (name === 'track.kmz') {
    const kml = await (await fetch('./track.kml')).text();
    return zipSync({ 'doc.kml': strToU8(kml) });
  }
  const response = await fetch(`./${name}`);
  if (!response.ok) throw new Error(`File request failed: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

const names = ['map.yml', 'track.kmz', 'places.kml', 'trip.gpx', 'shapes.geojson', 'missing.kml'];
const container = document.getElementById('maps')!;
window.demoHandles = {};
window.demoOpened = null;
window.demoReady = Promise.all(names.map((name) => {
  const root = document.createElement('div');
  root.className = 'slot';
  root.dataset.file = name;
  container.appendChild(root);
  const handle = createGeoMap(root, {
    loadFile: () => bytes(name),
    loadRef: (ref) => bytes(ref),
    photoUrl: (ref) => `./${ref}`,
    // The recording plays; the linked picture does not exist (error path).
    mediaUrl: (href) => (href === 'note.3gpp' ? TONE : `./${href}`),
    openPhoto: (list, index) => { window.demoOpened = { list, index }; },
    renderDescription: (text) => text.replace(/</g, '&lt;'),
  }, { format: detectMapKind(name)!, label: name === 'map.yml' ? '' : name });
  window.demoHandles[name] = handle;
  return handle.open();
})).then(() => undefined);
