import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGeoMap, type GeoMapHandle, type GeoMapHost } from '../src/map';
import { fixture, fixtureText, kmz } from './helpers';
import { syntheticJpeg, THUMB } from './jpeg';

const handles: GeoMapHandle[] = [];
let blobs = 0;

beforeEach(() => {
  blobs = 0;
  vi.stubGlobal('URL', Object.assign(globalThis.URL, {
    createObjectURL: vi.fn(() => `blob:thumb-${++blobs}`),
    revokeObjectURL: vi.fn(),
  }));
});

afterEach(() => {
  for (const handle of handles.splice(0)) handle.destroy();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const DESCRIPTOR = `
title: Ridge trip
layers:
  - file: ridge.kmz
  - file: ride.gpx
    color: '#2f7fe0'
photos:
  - path: geo.jpg
    caption: Steps
  - path: placed.jpg
    at: [45.005, 10.005]
places:
  - name: Hut
    at: [45.002, 10.002]
    note: Slept here
`;

const FILES: Record<string, () => Uint8Array> = {
  'map.yml': () => new TextEncoder().encode(DESCRIPTOR),
  'ridge.kmz': () => kmz({ 'doc.kml': fixtureText('track.kml') }),
  'ride.gpx': () => fixture('trip.gpx'),
  'geo.jpg': () => syntheticJpeg({ lat: 45.004, lon: 10.004, takenAt: '2020:05:17 08:04:02', thumbnail: THUMB }),
  'placed.jpg': () => syntheticJpeg({}),
};

function host(overrides: Partial<GeoMapHost> = {}, files = FILES): GeoMapHost {
  return {
    loadFile: async () => files['map.yml']!(),
    loadRef: vi.fn(async (ref: string) => {
      const make = files[ref];
      if (!make) throw new Error('File not found');
      return make();
    }),
    photoUrl: (ref) => `/raw/${ref}`,
    ...overrides,
  };
}

async function mount(h: GeoMapHost) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const handle = createGeoMap(root, h, { format: 'descriptor' });
  handles.push(handle);
  await handle.open();
  return { root, handle };
}

const text = (root: ParentNode, sel: string): string => root.querySelector(sel)?.textContent?.trim() ?? '';

describe('descriptor maps', () => {
  it('merges every layer, photo and place into one map titled by the descriptor', async () => {
    const h = host();
    const { root, handle } = await mount(h);
    expect(text(root, '.gm-title-label')).toBe('Ridge trip');
    expect(text(root, '.gm-summary')).toBe('2 tracks · 4 places · 2 photos');
    expect(handle.document?.items.map((i) => `${i.kind}:${i.name ?? ''}`)).toEqual([
      'place:Synthetic Ridge Loop (Start)', 'track:Synthetic Ridge Loop', 'place:Synthetic Ridge Loop (End)',
      'track:Morning ride', 'place:Voice recording',
      'photo:Steps', 'photo:placed.jpg',
      'place:Hut',
    ]);
    // A layer colour overrides the file's own.
    expect(handle.document?.items.find((i) => i.name === 'Morning ride')?.style.color).toBe('#2f7fe0');
    // Photo headers are read with a bounded request; the full photo is never fetched.
    expect(h.loadRef).toHaveBeenCalledWith('geo.jpg', expect.any(AbortSignal), { maxBytes: 262144 });
    expect(root.querySelector('.gm-notes')).toBeNull();
  });

  it('places a photo from its EXIF position, else from `at:`, and shows its thumbnail', async () => {
    const { root, handle } = await mount(host());
    const [geo, placed] = handle.document!.items.filter((i) => i.kind === 'photo');
    expect(geo!.geometry).toEqual({ type: 'Point', coordinates: [expect.closeTo(10.004, 5), expect.closeTo(45.004, 5)] });
    expect(geo!.start).toBe('2020-05-17T08:04:02');
    expect(placed!.geometry).toEqual({ type: 'Point', coordinates: [10.005, 45.005] });
    const thumbs = Array.from(root.querySelectorAll<HTMLImageElement>('.gm-photo-marker img')).map((i) => i.getAttribute('src'));
    // Embedded thumbnail as a blob URL; without one, the photo itself.
    expect(thumbs).toEqual(['blob:thumb-1', '/raw/placed.jpg']);
  });

  it('opens a photo popup with the photo, and hands the gallery to the host on click', async () => {
    const openPhoto = vi.fn();
    const { root } = await mount(host({ openPhoto }));
    root.querySelector<HTMLButtonElement>('.gm-item-photo')!.click();
    const popup = root.querySelector('.leaflet-popup-content')!;
    expect(text(popup, '.gm-popup-name')).toBe('Steps');
    const img = popup.querySelector<HTMLImageElement>('img.gm-popup-photo')!;
    expect(img.getAttribute('src')).toBe('/raw/geo.jpg');
    img.click();
    expect(openPhoto).toHaveBeenCalledWith([
      { ref: 'geo.jpg', url: '/raw/geo.jpg', caption: 'Steps' },
      { ref: 'placed.jpg', url: '/raw/placed.jpg', caption: null },
    ], 0);
  });

  it('keeps the rest of the map when a layer or a photo fails, and names each failure', async () => {
    const files: Record<string, () => Uint8Array> = { ...FILES, 'nogps.jpg': () => syntheticJpeg({}) };
    delete files['ride.gpx'];
    files['map.yml'] = () => new TextEncoder().encode(`${DESCRIPTOR}\n`.replace('  - path: placed.jpg\n    at: [45.005, 10.005]', '  - path: nogps.jpg'));
    const { root, handle } = await mount(host({}, files));
    expect(handle.document?.items.some((i) => i.kind === 'track')).toBe(true);
    expect(Array.from(root.querySelectorAll('.gm-notes li')).map((li) => li.textContent)).toEqual([
      'ride.gpx: File not found',
      'nogps.jpg: no GPS position in the photo (add `at:`)',
    ]);
  });

  it('fails as a whole only when the descriptor is invalid or nothing at all can be shown', async () => {
    const bad = await mount(host({ loadFile: async () => new TextEncoder().encode('layer: []') }));
    expect(text(bad.root, '.gm-status-text')).toBe('Cannot show this map: unknown key "layer" (expected title, basemap, layers, photos, places)');
    const empty = await mount(host({ loadRef: async () => { throw new Error('File not found'); } }, {
      ...FILES, 'map.yml': () => new TextEncoder().encode('layers: [{file: gone.kmz}]'),
    }));
    expect(text(empty.root, '.gm-status-text')).toBe('Cannot show this map: nothing could be shown (gone.kmz: File not found)');
  });

  it('starts on the descriptor basemap, over the host preference', async () => {
    const files = { ...FILES, 'map.yml': () => new TextEncoder().encode(`basemap: cyclosm\n${DESCRIPTOR}`) };
    const { handle } = await mount(host({ initialBasemap: 'opentopomap' }, files));
    expect(handle.basemap).toBe('cyclosm');
  });

  it('revokes the thumbnail blob URLs on destroy', async () => {
    const { handle } = await mount(host());
    handle.destroy();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:thumb-1');
  });
});
