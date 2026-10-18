import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGeoMap, type GeoMapHandle, type GeoMapHost } from '../src/map';
import { BASEMAPS } from '../src/basemaps';
import { fixture, fixtureText, kmz } from './helpers';

const handles: GeoMapHandle[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) handle.destroy();
  document.body.innerHTML = '';
});

function mount(host: Partial<GeoMapHost> & Pick<GeoMapHost, 'loadFile'>, label = '', format: 'kmz' | 'kml' | 'gpx' = 'kmz') {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const handle = createGeoMap(root, host, { format, label });
  handles.push(handle);
  return { root, handle };
}

const trackKmz = () => Promise.resolve(kmz({ 'doc.kml': fixtureText('track.kml') }));

function text(root: ParentNode, selector: string): string {
  return root.querySelector(selector)?.textContent?.trim() ?? '';
}

describe('createGeoMap', () => {
  it('loads the file through the host and renders the map, the title, the summary and the attribution', async () => {
    const loadFile = vi.fn(trackKmz);
    const { root, handle } = mount({ loadFile });
    await handle.open();
    expect(loadFile).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(root.classList.contains('gm-root')).toBe(true);
    expect(root.getAttribute('data-open')).toBe('1');
    expect(root.querySelector('.gm-map.leaflet-container')).not.toBeNull();
    expect(text(root, '.gm-title-label')).toBe('Synthetic Ridge Loop');
    expect(text(root, '.gm-summary')).toBe('1 track · 2 places');
    expect(text(root, '.leaflet-control-attribution')).toContain('OpenStreetMap');
    expect(root.querySelectorAll('.gm-item')).toHaveLength(3);
    expect(handle.document?.items).toHaveLength(3);
  });

  it('prefers the host label over the document name', async () => {
    const { root, handle } = mount({ loadFile: trackKmz }, 'My label');
    await handle.open();
    expect(text(root, '.gm-title-label')).toBe('My label');
  });

  it('never fetches the remote icons a KML references', async () => {
    const { root, handle } = mount({ loadFile: () => Promise.resolve(fixture('places.kml')) }, '', 'kml');
    await handle.open();
    const sources = Array.from(root.querySelectorAll('img')).map((img) => img.getAttribute('src') ?? '');
    expect(sources.filter((src) => /gstatic|google/.test(src))).toEqual([]);
  });

  it('shows a load failure with its reason and retries on demand', async () => {
    const loadFile = vi.fn()
      .mockRejectedValueOnce(new Error('File request failed: 404'))
      .mockImplementationOnce(trackKmz);
    const { root, handle } = mount({ loadFile });
    await handle.open();
    expect(root.querySelector('.gm-status')?.getAttribute('data-state')).toBe('error');
    expect(text(root, '.gm-status-text')).toBe('Failed to load map: File request failed: 404');
    root.querySelector<HTMLButtonElement>('.gm-retry')!.click();
    await vi.waitFor(() => expect(root.querySelector('.gm-map')).not.toBeNull());
    expect(loadFile).toHaveBeenCalledTimes(2);
  });

  it('shows a parse failure with its reason', async () => {
    const { root, handle } = mount({ loadFile: () => Promise.resolve(fixture('empty.kml')) }, '', 'kml');
    await handle.open();
    expect(text(root, '.gm-status-text')).toBe('Cannot show this map: no tracks or places in this file');
  });

  it('opens an item popup with its name, details and the host-rendered description', async () => {
    const renderDescription = vi.fn((s: string) => `<em>${s.length}</em>`);
    const { root, handle } = mount({ loadFile: trackKmz, renderDescription });
    await handle.open();
    root.querySelectorAll<HTMLButtonElement>('.gm-item')[1]!.click();
    const popup = root.querySelector('.leaflet-popup-content')!;
    expect(text(popup, '.gm-popup-name')).toBe('Synthetic Ridge Loop');
    expect(text(popup, '.gm-popup-meta')).toMatch(/^1\.9 km · /);
    expect(popup.querySelector('.gm-popup-desc')?.innerHTML).toBe('<em>22</em>');
    expect(renderDescription).toHaveBeenCalledWith('Walk *along* the ridge');
  });

  it('shows descriptions as plain text when the host renders nothing', async () => {
    const { root, handle } = mount({ loadFile: () => Promise.resolve(fixture('places.kml')) }, '', 'kml');
    await handle.open();
    root.querySelector<HTMLButtonElement>('.gm-item')!.click();
    const desc = root.querySelector('.leaflet-popup-content .gm-popup-desc')!;
    expect(desc.querySelector('b, img')).toBeNull();
    expect(desc.textContent).toBe('<b>bold</b> <img src="https://tracker.example/x.png">');
  });

  it('switches basemaps from the menu, updating the attribution and telling the host', async () => {
    const onBasemapChange = vi.fn();
    const { root, handle } = mount({ loadFile: trackKmz, basemaps: [BASEMAPS.osm, BASEMAPS.opentopomap], onBasemapChange });
    await handle.open();
    const select = root.querySelector<HTMLSelectElement>('select.gm-basemap')!;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['osm', 'opentopomap']);
    select.value = 'opentopomap';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(handle.basemap).toBe('opentopomap');
    expect(onBasemapChange).toHaveBeenCalledWith('opentopomap');
    expect(text(root, '.leaflet-control-attribution')).toContain('OpenTopoMap');
  });

  it('starts on the host-chosen basemap, ignoring an unknown one', async () => {
    const a = mount({ loadFile: trackKmz, initialBasemap: 'cyclosm' });
    await a.handle.open();
    expect(a.handle.basemap).toBe('cyclosm');
    const b = mount({ loadFile: trackKmz, initialBasemap: 'nope' });
    await b.handle.open();
    expect(b.handle.basemap).toBe('osm');
  });

  it('hides the basemap menu when only one basemap is offered', async () => {
    const { root, handle } = mount({ loadFile: trackKmz, basemaps: [BASEMAPS.osm] });
    await handle.open();
    expect(root.querySelector('select.gm-basemap')).toBeNull();
  });

  it('goes full screen into the host portal, and Escape brings it back in place', async () => {
    const portal = document.createElement('section');
    document.body.appendChild(portal);
    const onLayoutChange = vi.fn();
    const { root, handle } = mount({ loadFile: trackKmz, fullscreenPortal: () => portal, onLayoutChange });
    const parent = root.parentElement;
    await handle.open();
    root.querySelector<HTMLButtonElement>('.gm-fullscreen')!.click();
    expect(handle.getLayout()).toBe('full');
    expect(root.getAttribute('data-layout')).toBe('full');
    expect(portal.contains(root)).toBe(true);
    expect(handle.isPortalled()).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(handle.getLayout()).toBe('inline');
    expect(root.parentElement).toBe(parent);
    expect(portal.childElementCount).toBe(0);
    expect(onLayoutChange.mock.calls.map((c) => c[0])).toEqual(['full', 'inline']);
  });

  it('closes on ✕: empties the root and tells the host', async () => {
    const onClose = vi.fn();
    const { root, handle } = mount({ loadFile: trackKmz, onClose });
    await handle.open();
    root.querySelector<HTMLButtonElement>('.gm-close')!.click();
    expect(onClose).toHaveBeenCalledOnce();
    expect(root.childElementCount).toBe(0);
    expect(root.hasAttribute('data-open')).toBe(false);
  });

  it('destroy() aborts an in-flight load, never mounts late, and is idempotent', async () => {
    let signal: AbortSignal | null = null;
    let resolve: (value: Uint8Array) => void = () => {};
    const { root, handle } = mount({
      loadFile: (s) => { signal = s; return new Promise((r) => { resolve = r; }); },
    });
    const opening = handle.open();
    handle.destroy();
    handle.destroy();
    expect(signal!.aborted).toBe(true);
    resolve(kmz({ 'doc.kml': fixtureText('track.kml') }));
    await opening;
    expect(root.childElementCount).toBe(0);
    expect(root.querySelector('.leaflet-container')).toBeNull();
  });

  it('destroy() from full screen restores the root and releases the Escape listener', async () => {
    const remove = vi.spyOn(document, 'removeEventListener');
    const { root, handle } = mount({ loadFile: trackKmz });
    const parent = root.parentElement;
    await handle.open();
    handle.setLayout('full');
    handle.destroy();
    expect(root.parentElement).toBe(parent);
    expect(document.querySelector('.gm-portal')).toBeNull();
    expect(document.body.classList.contains('gm-fullscreen-open')).toBe(false);
    expect(remove).toHaveBeenCalledWith('keydown', expect.any(Function), true);
    remove.mockRestore();
  });
});

describe('drawing', () => {
  it('draws places as place markers and lines as tracks, never mixing their classes', async () => {
    const { root, handle } = mount({ loadFile: trackKmz });
    await handle.open();
    expect(root.querySelectorAll('path.gm-place')).toHaveLength(2);
    expect(root.querySelectorAll('path.gm-track')).toHaveLength(1);
    expect(root.querySelector('path.gm-track')?.getAttribute('stroke')).toBe('#ff0000');
  });
});

describe('resize grip', () => {
  function drag(grip: Element, from: number, to: number): void {
    grip.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientY: from, button: 0 }));
    window.dispatchEvent(new MouseEvent('pointermove', { clientY: to }));
    window.dispatchEvent(new MouseEvent('pointerup', { clientY: to }));
  }

  it('drags the inline map height between 200 px and 90 % of the viewport; double-click resets it', async () => {
    Object.defineProperty(window, 'innerHeight', { value: 1000, configurable: true });
    const { root, handle } = mount({ loadFile: trackKmz });
    await handle.open();
    const map = root.querySelector<HTMLElement>('.gm-map')!;
    vi.spyOn(map, 'getBoundingClientRect').mockReturnValue({ height: 360 } as DOMRect);
    const grip = root.querySelector('.gm-resize')!;
    expect(grip.getAttribute('aria-label')).toBe('Resize map');
    drag(grip, 500, 640);
    expect(map.style.height).toBe('500px');
    drag(grip, 500, 100);
    expect(map.style.height).toBe('200px');
    drag(grip, 100, 2000);
    expect(map.style.height).toBe('900px');
    grip.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(map.style.height).toBe('');
  });
});

describe('linked media', () => {
  const gpx = () => Promise.resolve(fixture('trip.gpx'));

  function openPopup(root: HTMLElement, name: string): Element {
    const entry = Array.from(root.querySelectorAll<HTMLButtonElement>('.gm-item')).find((b) => b.textContent?.includes(name))!;
    entry.click();
    return root.querySelector('.leaflet-popup-content')!;
  }

  it('plays a linked recording in the popup, resolving it through the host against its source file', async () => {
    const mediaUrl = vi.fn((href: string, source: string | null, kind: string) => `/m/${kind}/${href}`);
    const { root, handle } = mount({ loadFile: gpx, mediaUrl }, '', 'gpx');
    await handle.open();
    const popup = openPopup(root, 'Voice recording');
    const audio = popup.querySelector<HTMLAudioElement>('.gm-popup-media audio')!;
    expect(audio.getAttribute('src')).toBe('/m/audio/note.3gpp');
    expect(audio.controls).toBe(true);
    expect(audio.preload).toBe('none');
    expect(mediaUrl).toHaveBeenCalledWith('note.3gpp', null, 'audio');
  });

  it('marks list entries that carry media', async () => {
    const { root, handle } = mount({ loadFile: gpx, mediaUrl: (h) => h }, '', 'gpx');
    await handle.open();
    const marks = Array.from(root.querySelectorAll('.gm-item')).map((b) => `${b.querySelector('.gm-item-name')?.textContent}|${b.querySelector('.gm-item-media')?.textContent ?? ''}`);
    expect(marks.sort()).toEqual(['Morning ride|', 'Picture|\u{1F5BC}', 'Voice recording|\u266A'].sort());
  });

  it('shows a linked image that opens in the host viewer, and an external link that opens in a new tab', async () => {
    const openPhoto = vi.fn();
    const { root, handle } = mount({ loadFile: gpx, mediaUrl: (h, _s, k) => `/m/${k}/${h}`, openPhoto }, '', 'gpx');
    await handle.open();
    const popup = openPopup(root, 'Picture');
    const img = popup.querySelector<HTMLImageElement>('.gm-popup-media img')!;
    expect(img.getAttribute('src')).toBe('/m/image/pics/view.JPG');
    img.click();
    expect(openPhoto).toHaveBeenCalledWith([{ ref: 'pics/view.JPG', url: '/m/image/pics/view.JPG', caption: 'view.JPG' }], 0);
    const link = popup.querySelector<HTMLAnchorElement>('.gm-popup-media a')!;
    expect([link.href, link.target, link.rel, link.textContent]).toEqual(['https://example.org/about', '_blank', 'noopener noreferrer', 'About']);
  });

  it('lets the host render the media itself', async () => {
    const renderMedia = vi.fn((media: { kind: string }, url: string) => {
      const el = document.createElement('my-player');
      el.setAttribute('data-src', url);
      return media.kind === 'audio' ? el : null;
    });
    const { root, handle } = mount({ loadFile: gpx, mediaUrl: (h) => `/x/${h}`, renderMedia }, '', 'gpx');
    await handle.open();
    const popup = openPopup(root, 'Voice recording');
    expect(popup.querySelector('my-player')?.getAttribute('data-src')).toBe('/x/note.3gpp');
    expect(popup.querySelector('audio')).toBeNull();
  });

  it('says why a medium is unavailable: no host resolver, or a recording that fails to play', async () => {
    const bare = mount({ loadFile: gpx }, '', 'gpx');
    await bare.handle.open();
    expect(openPopup(bare.root, 'Voice recording').querySelector('.gm-popup-media')?.textContent).toBe('note.3gpp: not available here');
    const { root, handle } = mount({ loadFile: gpx, mediaUrl: (h) => `/m/${h}` }, '', 'gpx');
    await handle.open();
    const audio = openPopup(root, 'Voice recording').querySelector('audio')!;
    audio.dispatchEvent(new Event('error'));
    expect(root.querySelector('.leaflet-popup-content .gm-media-error')?.textContent).toBe('note.3gpp: cannot be played');
  });
});
