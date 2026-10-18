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
