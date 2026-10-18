// jsdom has no SVG geometry API, so Leaflet would pick its canvas
// renderer (and jsdom has no canvas either).  Leaflet only probes for
// `createSVGRect`'s existence; give it one before Leaflet is imported.
const proto = (globalThis as unknown as { SVGSVGElement?: { prototype: Record<string, unknown> } }).SVGSVGElement?.prototype;
if (proto && !proto.createSVGRect) proto.createSVGRect = () => ({ x: 0, y: 0, width: 0, height: 0 });
