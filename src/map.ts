/**
 * The map widget: `createGeoMap(root, host, options)`.
 *
 * The host supplies the file bytes (and optionally markdown/HTML
 * rendering, the basemap list, the full-screen portal); the widget owns
 * parsing, Leaflet, layout, popups, the item list and teardown.  The
 * widget never fetches anything except basemap tiles, and never fetches
 * the icons a KML file references.
 */

import L from 'leaflet';
import type { Position } from 'geojson';
import { DEFAULT_BASEMAPS, type Basemap } from './basemaps.js';
import { GeoParseError, parseGeoFile, type GeoDocument, type GeoItem, type GeoMedia, type MapKind } from './formats.js';
import { composeDescriptor, type RefLoader } from './compose.js';
import { MapDescriptorError } from './descriptor.js';
import { formatDuration, formatLength, lines, toBytes } from './geometry.js';

export const ROOT_CLASS = 'gm-root';

export type GeoMapLayout = 'inline' | 'wide' | 'full';

/** A photo as handed to `host.openPhoto`. */
export interface GeoMapPhoto {
  ref: string;
  url: string | null;
  caption: string | null;
}

export interface GeoMapHost extends RefLoader {
  /** Raw bytes of the file (the geo file itself, or the descriptor). */
  loadFile(signal: AbortSignal): Promise<ArrayBuffer | Uint8Array>;
  /**
   * Bytes of a file a descriptor refers to (`layers[].file`,
   * `photos[].path`), resolved by the host.  For photos `maxBytes` asks
   * for a bounded prefix (the EXIF block); returning more is fine.
   * Required for descriptors with layers or photos.
   */
  loadRef?(ref: string, signal: AbortSignal, options?: { maxBytes?: number }): Promise<ArrayBuffer | Uint8Array>;
  /** URL of a full-size photo (marker fallback and popup image). */
  photoUrl?(ref: string): string;
  /** Show photo `index` of every photo of the map (e.g. a lightbox).  Default: open its URL in a new tab. */
  openPhoto?(photos: GeoMapPhoto[], index: number): void;
  /**
   * URL of a medium a feature links to (`href` as written in the file),
   * resolved against `source` (the descriptor layer it comes from, or
   * null for the map's own file).  Return null when it cannot be served.
   * Without this hook, local media are listed as unavailable.
   */
  mediaUrl?(href: string, source: string | null, kind: 'audio' | 'image'): string | null;
  /**
   * Render a medium yourself (e.g. the host's own audio player); return
   * null to let the widget render it.  The widget gives it the URL from
   * `mediaUrl`.
   */
  renderMedia?(media: GeoMedia, url: string): HTMLElement | null;
  /** Render an item description to SAFE HTML.  Default: shown as plain text. */
  renderDescription?(text: string): string;
  /** Basemaps offered in the menu, first is the default.  Default: `DEFAULT_BASEMAPS`. */
  basemaps?: readonly Basemap[];
  /** Basemap id to start on (e.g. the user's last choice); unknown ids are ignored. */
  initialBasemap?: string;
  onBasemapChange?(id: string): void;
  /** Element the full-screen portal is appended to.  Default: `document.body`. */
  fullscreenPortal?(): HTMLElement;
  /** The scrolling ancestor the `wide` layout should span.  Default: the root's parent. */
  wideHost?(root: HTMLElement): HTMLElement | null;
  onLayoutChange?(layout: GeoMapLayout): void;
  /** The user pressed ✕ (the widget has already destroyed itself). */
  onClose?(): void;
}

export interface GeoMapOptions {
  format: MapKind;
  /** Title; defaults to the file's own name. */
  label?: string;
}

export interface GeoMapHandle {
  open(): Promise<void>;
  retry(): Promise<void>;
  /** Destroy and tell the host (same as ✕). */
  close(): void;
  setLayout(layout: GeoMapLayout): void;
  getLayout(): GeoMapLayout;
  isPortalled(): boolean;
  setBasemap(id: string): void;
  readonly basemap: string;
  /** Pan / zoom to an item and open its popup. */
  focusItem(id: number): void;
  /** Re-fit the view to all items. */
  fit(): void;
  /** Release everything and empty the root.  Idempotent. */
  destroy(): void;
  readonly document: GeoDocument | null;
  readonly leaflet: L.Map | null;
}

/** Padding around the content when fitting the view, pixels. */
const FIT_PADDING: L.PointExpression = [24, 24];
/** Never zoom closer than this when fitting (a single place). */
const FIT_MAX_ZOOM = 16;
const FALLBACK_ZOOM = 13;
/** Inline height range the resize grip allows. */
const MIN_MAP_HEIGHT = 200;
const MAX_MAP_HEIGHT_RATIO = 0.9;
/** Rotation to apply to a raw EXIF thumbnail, by orientation. */
const THUMB_ROTATION: Record<number, number> = { 3: 180, 6: 90, 8: 270 };

interface State {
  root: HTMLElement;
  host: GeoMapHost;
  options: GeoMapOptions;
  basemaps: readonly Basemap[];
  basemap: Basemap;
  seq: number;
  controller: AbortController | null;
  doc: GeoDocument | null;
  map: L.Map | null;
  tiles: L.TileLayer | null;
  layers: Map<number, L.Layer>;
  layout: GeoMapLayout;
  placeholder: Comment | null;
  keydown: ((event: KeyboardEvent) => void) | null;
  resize: ResizeObserver | null;
  /** True once the view was fitted against a laid-out container. */
  fitted: boolean;
  destroyed: boolean;
  /** Object URLs (photo thumbnails) owned by the current document. */
  blobUrls: string[];
  /** Ends an in-progress resize drag. */
  endDrag: (() => void) | null;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className: string, label: string, glyph: string): HTMLButtonElement {
  const node = el('button', className, glyph);
  node.type = 'button';
  node.title = label;
  node.setAttribute('aria-label', label);
  return node;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** "1 track · 2 places" */
export function summaryText(doc: GeoDocument): string {
  const count = (kind: GeoItem['kind']): number => doc.items.filter((item) => item.kind === kind).length;
  const parts: string[] = [];
  for (const kind of ['track', 'area', 'place', 'photo'] as const) {
    if (count(kind)) parts.push(plural(count(kind), kind));
  }
  return parts.join(' · ');
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** "1.9 km · 1 h 00 · 17 May 2020, 07:00" */
export function itemMeta(item: GeoItem): string {
  const parts: string[] = [];
  if (item.lengthMeters !== null) parts.push(formatLength(item.lengthMeters));
  if (item.start && item.end && item.end !== item.start) {
    const ms = new Date(item.end).getTime() - new Date(item.start).getTime();
    if (Number.isFinite(ms) && ms > 0) parts.push(formatDuration(ms));
  }
  if (item.start) parts.push(formatTime(item.start));
  return parts.join(' · ');
}

function itemName(item: GeoItem): string {
  return item.name ?? `Unnamed ${item.kind}`;
}

const latLng = (position: Position): L.LatLngExpression => [position[1]!, position[0]!];

const MEDIA_MARK: Record<GeoMedia['kind'], string> = { audio: '\u266a', image: '\u{1F5BC}', web: '' };

function mediaLabel(media: GeoMedia): string {
  return media.text ?? (media.href.split('/').pop() || media.href);
}

function mediaElement(st: State, item: GeoItem, media: GeoMedia): HTMLElement {
  const box = el('div', 'gm-popup-media');
  box.setAttribute('data-kind', media.kind);
  if (media.kind === 'web') {
    const link = el('a', undefined, mediaLabel(media));
    link.href = media.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    box.appendChild(link);
    return box;
  }
  const url = st.host.mediaUrl?.(media.href, item.source, media.kind) ?? null;
  if (!url) {
    box.textContent = `${mediaLabel(media)}: not available here`;
    return box;
  }
  const custom = st.host.renderMedia?.(media, url);
  if (custom) {
    box.appendChild(custom);
    return box;
  }
  const fail = (what: string): void => {
    const error = el('span', 'gm-media-error', `${mediaLabel(media)}: ${what}`);
    box.textContent = '';
    box.appendChild(error);
  };
  if (media.kind === 'audio') {
    box.appendChild(el('span', 'gm-media-label', mediaLabel(media)));
    const audio = el('audio');
    audio.controls = true;
    audio.preload = 'none';
    audio.setAttribute('src', url);
    audio.addEventListener('error', () => fail('cannot be played'));
    box.appendChild(audio);
  } else {
    const img = el('img', 'gm-popup-photo');
    img.alt = mediaLabel(media);
    img.title = 'Open the image';
    img.setAttribute('src', url);
    img.addEventListener('error', () => fail('cannot be shown'));
    img.addEventListener('click', () => {
      const photo: GeoMapPhoto = { ref: media.href, url, caption: media.text };
      if (st.host.openPhoto) st.host.openPhoto([photo], 0);
      else window.open(url, '_blank', 'noopener');
    });
    box.appendChild(img);
  }
  return box;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function renderStatus(st: State, message: string, error: boolean): void {
  st.root.textContent = '';
  st.root.setAttribute('data-open', '1');
  const status = el('div', 'gm-status');
  status.setAttribute('role', error ? 'alert' : 'status');
  if (error) status.setAttribute('data-state', 'error');
  status.appendChild(el('span', 'gm-status-text', message));
  if (error) status.appendChild(button('gm-retry', 'Retry loading map', 'Retry'));
  status.appendChild(button('gm-close', 'Close map', '\u2715'));
  st.root.appendChild(status);
}

function photoGallery(st: State): { photos: GeoMapPhoto[]; ids: number[] } {
  const items = st.doc?.items.filter((item) => item.photo) ?? [];
  return {
    photos: items.map((item) => ({ ref: item.photo!.ref, url: item.photo!.url, caption: item.photo!.caption })),
    ids: items.map((item) => item.id),
  };
}

function openPhoto(st: State, item: GeoItem): void {
  const { photos, ids } = photoGallery(st);
  const index = ids.indexOf(item.id);
  if (st.host.openPhoto) st.host.openPhoto(photos, index);
  else if (item.photo?.url) window.open(item.photo.url, '_blank', 'noopener');
}

function thumbImage(item: GeoItem, className: string): HTMLImageElement {
  const img = el('img', className);
  img.alt = itemName(item);
  img.setAttribute('src', item.photo?.thumbUrl ?? '');
  const turn = item.photo?.thumbNeedsOrientation ? THUMB_ROTATION[item.photo.orientation ?? 1] : undefined;
  if (turn) img.style.transform = `rotate(${turn}deg)`;
  return img;
}

function popupContent(st: State, item: GeoItem): HTMLElement {
  const box = el('div', 'gm-popup');
  box.appendChild(el('div', 'gm-popup-name', itemName(item)));
  const meta = itemMeta(item);
  if (meta) box.appendChild(el('div', 'gm-popup-meta', meta));
  if (item.photo) {
    const img = item.photo.url ? el('img', 'gm-popup-photo') : thumbImage(item, 'gm-popup-photo');
    if (item.photo.url) img.setAttribute('src', item.photo.url);
    img.alt = itemName(item);
    img.title = 'Open the photo';
    img.addEventListener('click', () => openPhoto(st, item));
    box.appendChild(img);
  }
  for (const media of item.media) box.appendChild(mediaElement(st, item, media));
  if (item.description) {
    const desc = el('div', 'gm-popup-desc');
    if (st.host.renderDescription) desc.innerHTML = st.host.renderDescription(item.description);
    else desc.textContent = item.description;
    box.appendChild(desc);
  }
  return box;
}

function itemLayer(st: State, item: GeoItem): L.Layer {
  const styled = item.style.color !== undefined;
  const pathOptions = (base: string): L.PathOptions => {
    const options: L.PathOptions = { className: styled ? `${base} gm-styled` : base };
    if (item.style.color) options.color = item.style.color;
    if (item.style.opacity !== undefined) options.opacity = Math.max(item.style.opacity, 0.6);
    if (item.style.weight !== undefined) options.weight = Math.min(Math.max(item.style.weight, 3), 8);
    return options;
  };
  const group = L.featureGroup();
  if (item.photo) {
    const [lon, lat] = (item.geometry as { coordinates: number[] }).coordinates as [number, number];
    const holder = el('div');
    holder.appendChild(thumbImage(item, 'gm-photo-thumb'));
    const icon = L.divIcon({ className: 'gm-photo-marker', html: holder.innerHTML, iconSize: [40, 40], iconAnchor: [20, 20], popupAnchor: [0, -20] });
    group.addLayer(L.marker([lat, lon], { icon, title: itemName(item), alt: itemName(item) }));
    group.bindPopup(() => popupContent(st, item), { maxWidth: 320, minWidth: 200, autoPanPadding: [16, 16] });
    return group;
  }
  // No `style` option: Leaflet would apply it to the place markers too.
  // Places get their options from `pointToLayer`; every other path is
  // styled below, before it is first rendered (the class is read then).
  const geo = L.geoJSON(item.geometry, {
    pointToLayer: (_feature, at) => L.circleMarker(at, { ...pathOptions('gm-place'), radius: 7, weight: 2, fillOpacity: 0.9 }),
  });
  const lineOptions = pathOptions(item.kind === 'area' ? 'gm-area' : 'gm-track');
  if (item.style.weight === undefined) lineOptions.weight = 4;
  const styleLines = (layer: L.Layer): void => {
    if (layer instanceof L.CircleMarker) return;
    if (layer instanceof L.LayerGroup) layer.eachLayer(styleLines);
    else if (layer instanceof L.Path) layer.setStyle(lineOptions);
  };
  geo.eachLayer(styleLines);
  group.addLayer(geo);
  for (const line of lines(item.geometry)) {
    if (line.length < 2) continue;
    const ends: [Position, string][] = [[line[0]!, 'gm-start'], [line[line.length - 1]!, 'gm-end']];
    for (const [position, className] of ends) {
      group.addLayer(L.circleMarker(latLng(position), { className, radius: 4, weight: 2, fillOpacity: 1, interactive: false }));
    }
  }
  group.bindPopup(() => popupContent(st, item), { maxWidth: 320, autoPanPadding: [16, 16] });
  return group;
}

function setTiles(st: State): void {
  if (!st.map) return;
  st.tiles?.remove();
  const basemap = st.basemap;
  const options: L.TileLayerOptions = {
    attribution: basemap.attribution,
    maxZoom: basemap.maxZoom,
    maxNativeZoom: basemap.maxZoom,
    referrerPolicy: 'strict-origin-when-cross-origin',
  };
  if (basemap.subdomains) options.subdomains = basemap.subdomains;
  st.tiles = L.tileLayer(basemap.url, options).addTo(st.map);
  st.map.setMaxZoom(basemap.maxZoom);
}

function fit(st: State): void {
  const map = st.map;
  const doc = st.doc;
  if (!map || !doc) return;
  const { south, west, north, east } = doc.bounds;
  const size = map.getContainer();
  if (!size.clientWidth || !size.clientHeight) {
    map.setView([(south + north) / 2, (west + east) / 2], FALLBACK_ZOOM, { animate: false });
    return;
  }
  map.fitBounds([[south, west], [north, east]], { padding: FIT_PADDING, maxZoom: FIT_MAX_ZOOM, animate: false });
  st.fitted = true;
}

function renderMap(st: State, doc: GeoDocument): void {
  const root = st.root;
  root.textContent = '';
  root.setAttribute('data-open', '1');

  const toolbar = el('div', 'gm-toolbar');
  const title = el('div', 'gm-title');
  title.appendChild(el('span', 'gm-title-label', st.options.label || doc.name || 'Map'));
  title.appendChild(el('span', 'gm-summary', summaryText(doc)));
  toolbar.appendChild(title);
  const controls = el('div', 'gm-controls');
  if (st.basemaps.length > 1) {
    const select = el('select', 'gm-basemap');
    select.setAttribute('aria-label', 'Basemap');
    select.title = 'Basemap';
    for (const basemap of st.basemaps) {
      const option = el('option', undefined, basemap.label);
      option.value = basemap.id;
      select.appendChild(option);
    }
    select.value = st.basemap.id;
    controls.appendChild(select);
  }
  controls.appendChild(button('gm-fit', 'Show everything', '\u2316'));
  controls.appendChild(button('gm-wide', 'Wide', '\u21d4'));
  controls.appendChild(button('gm-fullscreen', 'Full screen', '\u26f6'));
  controls.appendChild(button('gm-close', 'Close map', '\u2715'));
  toolbar.appendChild(controls);
  root.appendChild(toolbar);

  const mapWrap = el('div', 'gm-map-wrap');
  const mapEl = el('div', 'gm-map');
  mapWrap.appendChild(mapEl);
  const grip = el('div', 'gm-resize');
  grip.setAttribute('role', 'separator');
  grip.setAttribute('aria-orientation', 'horizontal');
  grip.setAttribute('aria-label', 'Resize map');
  grip.title = 'Drag to resize, double-click to reset';
  mapWrap.appendChild(grip);
  root.appendChild(mapWrap);
  wireResize(st, grip, mapEl);

  if (doc.notes.length) {
    const notes = el('ul', 'gm-notes');
    notes.setAttribute('role', 'status');
    for (const note of doc.notes) notes.appendChild(el('li', undefined, note));
    root.appendChild(notes);
  }

  const legend = el('details', 'gm-legend');
  legend.appendChild(el('summary', 'gm-legend-summary', `List: ${summaryText(doc)}`));
  const list = el('ul', 'gm-list');
  for (const item of doc.items) {
    const li = el('li');
    const entry = button(`gm-item gm-item-${item.kind}`, `Show ${itemName(item)}`, '');
    entry.setAttribute('data-item-id', String(item.id));
    entry.appendChild(el('span', 'gm-item-name', itemName(item)));
    const marks = Array.from(new Set(item.media.map((media) => MEDIA_MARK[media.kind]).filter(Boolean))).join('');
    if (marks) entry.appendChild(el('span', 'gm-item-media', marks));
    const meta = itemMeta(item);
    if (meta) entry.appendChild(el('span', 'gm-item-meta', meta));
    li.appendChild(entry);
    list.appendChild(li);
  }
  legend.appendChild(list);
  root.appendChild(legend);

  const map = L.map(mapEl, {
    zoomControl: true,
    attributionControl: true,
    // Wheel zoom is centred on the map; one finger pans it, two pinch-zoom.
    scrollWheelZoom: 'center',
  });
  map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
  st.map = map;
  setTiles(st);
  for (const item of doc.items) {
    const layer = itemLayer(st, item).addTo(map);
    st.layers.set(item.id, layer);
  }
  fit(st);
  if (typeof ResizeObserver !== 'undefined') {
    st.resize = new ResizeObserver(() => {
      if (!st.map) return;
      st.map.invalidateSize({ animate: false });
      if (!st.fitted) fit(st);
    });
    st.resize.observe(mapEl);
  }
}

/* ------------------------------------------------------------------ */
/* Resize grip                                                         */
/* ------------------------------------------------------------------ */

function wireResize(st: State, grip: HTMLElement, mapEl: HTMLElement): void {
  grip.addEventListener('pointerdown', (event: PointerEvent) => {
    if (event.button !== 0 || st.layout === 'full') return;
    event.preventDefault();
    st.endDrag?.();
    const startY = event.clientY;
    const startHeight = mapEl.getBoundingClientRect().height;
    const onMove = (move: PointerEvent): void => {
      const max = window.innerHeight * MAX_MAP_HEIGHT_RATIO;
      const height = Math.min(max, Math.max(MIN_MAP_HEIGHT, startHeight + move.clientY - startY));
      mapEl.style.height = `${Math.round(height)}px`;
      st.map?.invalidateSize({ animate: false });
    };
    const end = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      st.root.removeAttribute('data-resizing');
      if (st.endDrag === end) st.endDrag = null;
    };
    st.endDrag = end;
    st.root.setAttribute('data-resizing', '1');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  });
  grip.addEventListener('dblclick', () => {
    mapEl.style.height = '';
    st.map?.invalidateSize({ animate: false });
  });
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

function applyWideGeometry(st: State): void {
  const host = st.host.wideHost?.(st.root) ?? st.root.parentElement;
  if (!host) return;
  const gutter = 8;
  const hostRect = host.getBoundingClientRect();
  st.root.style.marginLeft = '0';
  st.root.style.width = '';
  const shift = st.root.getBoundingClientRect().left - hostRect.left - gutter;
  st.root.style.marginLeft = `${-shift}px`;
  st.root.style.width = `${hostRect.width - 2 * gutter}px`;
}

function leaveLayout(st: State): void {
  if (st.layout === 'wide') {
    st.root.style.marginLeft = '';
    st.root.style.width = '';
  }
  if (st.layout === 'full') {
    document.body.classList.remove('gm-fullscreen-open');
    if (st.keydown) document.removeEventListener('keydown', st.keydown, true);
    st.keydown = null;
    const portal = st.root.parentElement;
    if (st.placeholder?.parentNode) st.placeholder.parentNode.replaceChild(st.root, st.placeholder);
    if (portal?.classList.contains('gm-portal')) portal.remove();
    st.placeholder = null;
  }
  st.root.removeAttribute('data-layout');
}

function setLayout(st: State, layout: GeoMapLayout): void {
  if (st.destroyed || st.layout === layout || !st.map) return;
  leaveLayout(st);
  st.layout = layout;
  if (layout !== 'inline') st.root.setAttribute('data-layout', layout);
  if (layout === 'wide') applyWideGeometry(st);
  if (layout === 'full') {
    // Host ancestors may create stacking contexts that clip a fixed
    // overlay; portal the root out, leaving a placeholder to come back to.
    const placeholder = document.createComment('gm-fullscreen');
    st.root.parentNode?.insertBefore(placeholder, st.root);
    st.placeholder = placeholder;
    const portal = el('div', 'gm-portal');
    portal.appendChild(st.root);
    (st.host.fullscreenPortal?.() ?? document.body).appendChild(portal);
    document.body.classList.add('gm-fullscreen-open');
    st.keydown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setLayout(st, 'inline');
    };
    document.addEventListener('keydown', st.keydown, true);
  }
  st.root.querySelector('.gm-wide')?.toggleAttribute('data-active', layout === 'wide');
  st.root.querySelector('.gm-fullscreen')?.toggleAttribute('data-active', layout === 'full');
  st.host.onLayoutChange?.(layout);
  st.map.invalidateSize({ animate: false });
  st.fitted = false;
  fit(st);
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

function releaseBlobs(st: State): void {
  for (const url of st.blobUrls) URL.revokeObjectURL(url);
  st.blobUrls = [];
}

function teardownMap(st: State): void {
  st.controller?.abort();
  st.controller = null;
  st.endDrag?.();
  releaseBlobs(st);
  st.resize?.disconnect();
  st.resize = null;
  if (st.layout !== 'inline') leaveLayout(st);
  st.layout = 'inline';
  st.map?.remove();
  st.map = null;
  st.tiles = null;
  st.layers.clear();
}

async function open(st: State): Promise<void> {
  if (st.destroyed || st.map || st.controller) return;
  const seq = ++st.seq;
  const controller = new AbortController();
  st.controller = controller;
  renderStatus(st, 'Loading map...', false);
  let doc: GeoDocument;
  try {
    const bytes = await st.host.loadFile(controller.signal);
    if (st.seq !== seq) return;
    if (st.options.format === 'descriptor') {
      const text = new TextDecoder('utf-8').decode(toBytes(bytes));
      const composed = await composeDescriptor(text, st.host, controller.signal);
      if (st.seq !== seq) {
        for (const url of composed.blobUrls) URL.revokeObjectURL(url);
        return;
      }
      st.blobUrls = composed.blobUrls;
      doc = composed.doc;
      const wanted = st.basemaps.find((basemap) => basemap.id === composed.basemap);
      if (wanted) st.basemap = wanted;
      else if (composed.basemap) doc.notes.push(`basemap "${composed.basemap}" is not offered`);
    } else {
      doc = parseGeoFile(bytes, st.options.format);
    }
  } catch (error) {
    if (st.seq !== seq) return;
    st.controller = null;
    const reason = error instanceof Error ? error.message : String(error);
    const unshowable = error instanceof GeoParseError || error instanceof MapDescriptorError;
    renderStatus(st, unshowable ? `Cannot show this map: ${reason}` : `Failed to load map: ${reason}`, true);
    return;
  }
  st.controller = null;
  st.doc = doc;
  renderMap(st, doc);
}

function focusItem(st: State, id: number): void {
  const layer = st.layers.get(id);
  const map = st.map;
  if (!layer || !map) return;
  const bounds = (layer as L.FeatureGroup).getBounds();
  if (bounds.isValid()) {
    const size = map.getContainer();
    if (size.clientWidth && size.clientHeight) {
      map.fitBounds(bounds, { padding: FIT_PADDING, maxZoom: FIT_MAX_ZOOM, animate: false });
    } else {
      map.setView(bounds.getCenter(), FALLBACK_ZOOM, { animate: false });
    }
  }
  (layer as L.FeatureGroup).openPopup(bounds.isValid() ? bounds.getCenter() : undefined);
}

function destroy(st: State & Listeners, notify: boolean): void {
  if (st.destroyed) return;
  st.destroyed = true;
  st.seq += 1;
  teardownMap(st);
  st.root.removeEventListener('click', st.onClick);
  st.root.removeEventListener('change', st.onChange);
  st.root.textContent = '';
  st.root.removeAttribute('data-open');
  st.root.classList.remove(ROOT_CLASS);
  st.doc = null;
  if (notify) st.host.onClose?.();
}

interface Listeners {
  onClick: (event: Event) => void;
  onChange: (event: Event) => void;
}

/**
 * Turn `root` into a map widget.  The element gets the `gm-root` class
 * (every package style hangs from it); `open()` loads the file through
 * the host and mounts Leaflet.  A destroyed widget stays destroyed: make
 * a new one to show the file again.
 */
export function createGeoMap(root: HTMLElement, host: GeoMapHost, options: GeoMapOptions): GeoMapHandle {
  const basemaps = host.basemaps?.length ? host.basemaps : DEFAULT_BASEMAPS;
  const st: State & Listeners = {
    root,
    host,
    options,
    basemaps,
    basemap: basemaps.find((b) => b.id === host.initialBasemap) ?? basemaps[0]!,
    seq: 0,
    controller: null,
    doc: null,
    map: null,
    tiles: null,
    layers: new Map(),
    layout: 'inline',
    placeholder: null,
    keydown: null,
    resize: null,
    fitted: false,
    destroyed: false,
    blobUrls: [],
    endDrag: null,
    onClick: () => {},
    onChange: () => {},
  };
  const handle: GeoMapHandle = {
    open: () => open(st),
    retry: () => (st.map || st.controller ? Promise.resolve() : open(st)),
    close: () => destroy(st, true),
    setLayout: (layout) => setLayout(st, layout),
    getLayout: () => st.layout,
    isPortalled: () => st.placeholder !== null,
    setBasemap(id) {
      const next = st.basemaps.find((b) => b.id === id);
      if (!next || next.id === st.basemap.id) return;
      st.basemap = next;
      setTiles(st);
      const select = st.root.querySelector<HTMLSelectElement>('select.gm-basemap');
      if (select) select.value = id;
      st.host.onBasemapChange?.(id);
    },
    get basemap() {
      return st.basemap.id;
    },
    focusItem: (id) => focusItem(st, id),
    fit: () => fit(st),
    destroy: () => destroy(st, false),
    get document() {
      return st.doc;
    },
    get leaflet() {
      return st.map;
    },
  };
  st.onClick = (event: Event): void => {
    const target = event.target as Element | null;
    const control = target?.closest?.('button');
    if (!control || !root.contains(control)) return;
    if (control.classList.contains('gm-close')) {
      event.stopPropagation();
      handle.close();
    } else if (control.classList.contains('gm-retry')) {
      event.stopPropagation();
      void handle.retry();
    } else if (control.classList.contains('gm-fit')) {
      handle.fit();
    } else if (control.classList.contains('gm-wide')) {
      setLayout(st, st.layout === 'wide' ? 'inline' : 'wide');
    } else if (control.classList.contains('gm-fullscreen')) {
      setLayout(st, st.layout === 'full' ? 'inline' : 'full');
    } else if (control.classList.contains('gm-item')) {
      focusItem(st, Number(control.getAttribute('data-item-id')));
    }
  };
  st.onChange = (event: Event): void => {
    const target = event.target as HTMLSelectElement | null;
    if (target?.classList?.contains('gm-basemap')) handle.setBasemap(target.value);
  };
  root.classList.add(ROOT_CLASS);
  root.addEventListener('click', st.onClick);
  root.addEventListener('change', st.onChange);
  return handle;
}
