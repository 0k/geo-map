import { describe, expect, it } from 'vitest';
import { detectFormat, GeoParseError, mediaKind, parseGeoFile } from '../src/formats';
import { fixture, fixtureText, kmz } from './helpers';

function names(doc: ReturnType<typeof parseGeoFile>): string[] {
  return doc.items.map((item) => `${item.kind}:${item.name ?? ''}`);
}

function parseError(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(GeoParseError);
    return (error as Error).message;
  }
  throw new Error('expected a GeoParseError');
}

describe('detectFormat', () => {
  it('recognises the supported extensions, case-insensitively, and nothing else', () => {
    expect(['a.kmz', 'B.KML', '/x/y.gpx', 'z.GeoJSON', 'n.txt', 'n.json', 'kmz', ''].map(detectFormat))
      .toEqual(['kmz', 'kml', 'gpx', 'geojson', null, null, null, null]);
  });
});

describe('parseGeoFile', () => {
  it('reads a My Tracks KMZ: document name, gx:MultiTrack as a timed track, and its start/end places', () => {
    const doc = parseGeoFile(kmz({ 'doc.kml': fixtureText('track.kml') }), 'kmz');
    expect(doc.name).toBe('Synthetic Ridge Loop');
    expect(names(doc)).toEqual([
      'place:Synthetic Ridge Loop (Start)',
      'track:Synthetic Ridge Loop',
      'place:Synthetic Ridge Loop (End)',
    ]);
    const track = doc.items[1]!;
    expect(track.start).toBe('2020-05-17T06:00:09Z');
    expect(track.end).toBe('2020-05-17T07:00:09Z');
    expect(track.description).toBe('Walk *along* the ridge');
    expect(track.style).toEqual({ color: '#ff0000', opacity: expect.closeTo(0.498, 2), weight: expect.any(Number) });
    // 0.01° of latitude, then 0.01° of longitude at 45.01°N.
    expect(track.lengthMeters).toBeCloseTo(1111.95 + 786.3, -1);
    expect(doc.bounds).toEqual({ south: 45, west: 10, north: 45.01, east: 10.01 });
  });

  it('prefers doc.kml inside a KMZ and otherwise takes the shallowest .kml', () => {
    const other = fixtureText('places.kml');
    expect(parseGeoFile(kmz({ 'a.kml': other, 'doc.kml': fixtureText('track.kml') }), 'kmz').name).toBe('Synthetic Ridge Loop');
    expect(parseGeoFile(kmz({ 'files/deep/x.kml': fixtureText('track.kml'), 'files/top.kml': other }), 'kmz').name).toBe('Synthetic Trip');
  });

  it('reads Google Maps places (Folder + StyleMap) and drops placemarks without geometry', () => {
    const doc = parseGeoFile(fixture('places.kml'), 'kml');
    expect(doc.name).toBe('Synthetic Trip');
    expect(doc.description).toBe('sample places');
    expect(names(doc)).toEqual(['place:Alpha Square', 'place:Beta Harbour']);
    expect(doc.items[0]!.description).toBe('<b>bold</b> <img src="https://tracker.example/x.png">');
    expect(doc.items[0]!.lengthMeters).toBeNull();
  });

  it('reads GPX tracks and waypoints', () => {
    const doc = parseGeoFile(fixture('trip.gpx'), 'gpx');
    expect(names(doc).sort()).toEqual(['place:Picture', 'place:Voice recording', 'track:Morning ride']);
    const track = doc.items.find((item) => item.kind === 'track')!;
    const place = doc.items.find((item) => item.kind === 'place')!;
    expect([track.start, track.end]).toEqual(['2020-06-02T10:00:00Z', '2020-06-02T10:20:00Z']);
    expect(place.start).toBe('2020-06-02T10:24:38Z');
  });

  it('keeps the media a GPX waypoint links to, typed by extension', () => {
    const doc = parseGeoFile(fixture('trip.gpx'), 'gpx');
    const media = (name: string) => doc.items.find((item) => item.name === name)!.media;
    expect(media('Voice recording')).toEqual([{ href: 'note.3gpp', text: 'note.3gpp', kind: 'audio' }]);
    expect(media('Picture')).toEqual([
      { href: 'pics/view.JPG', text: 'view.JPG', kind: 'image' },
      { href: 'https://example.org/about', text: 'About', kind: 'web' },
    ]);
    expect(media('Morning ride')).toEqual([]);
  });

  it('finds local media referenced from a KML description, ignoring remote and non-media links', () => {
    const doc = parseGeoFile(fixture('places.kml'), 'kml');
    expect(doc.items.find((item) => item.name === 'Beta Harbour')!.media).toEqual([
      { href: 'audio/harbour.amr', text: 'clip', kind: 'audio' },
      { href: '/abs/harbour.png', text: null, kind: 'image' },
    ]);
    // A remote image in a description is never collected (it would be fetched).
    expect(doc.items.find((item) => item.name === 'Alpha Square')!.media).toEqual([]);
  });

  it('classifies media by extension', () => {
    expect(['a.3gpp', 'a.3GP', 'a.amr', 'a.ogg', 'a.opus', 'a.mp3', 'a.m4a', 'a.wav', 'a.webm', 'a.jpg', 'a.jpeg', 'a.png', 'a.webp', 'a.gif', 'a.txt', 'a']
      .map(mediaKind)).toEqual(['audio', 'audio', 'audio', 'audio', 'audio', 'audio', 'audio', 'audio', 'audio', 'image', 'image', 'image', 'image', 'image', null, null]);
  });

  it('reads GeoJSON, classifying polygons as areas', () => {
    const doc = parseGeoFile(fixture('shapes.geojson'), 'geojson');
    expect(names(doc)).toEqual(['area:Square', 'place:Pin']);
    expect(doc.bounds).toEqual({ south: 0, west: 0, north: 1, east: 1 });
  });

  it('rejects malformed input with a reason naming the problem', () => {
    expect(parseError(() => parseGeoFile(new TextEncoder().encode('not a zip'), 'kmz'))).toMatch(/not a valid KMZ \(zip\) archive/);
    expect(parseError(() => parseGeoFile(kmz({ 'readme.txt': 'hi' }), 'kmz'))).toMatch(/contains no \.kml/);
    expect(parseError(() => parseGeoFile(new TextEncoder().encode('<kml><Document>'), 'kml'))).toMatch(/not well-formed XML/);
    expect(parseError(() => parseGeoFile(fixture('trip.gpx'), 'kml'))).toMatch(/expected a <kml> document, found <gpx>/);
    expect(parseError(() => parseGeoFile(fixture('empty.kml'), 'kml'))).toMatch(/no tracks or places/);
    expect(parseError(() => parseGeoFile(new TextEncoder().encode('{"type":"Nope"}'), 'geojson'))).toMatch(/not GeoJSON/);
  });

  it('refuses a KMZ whose kml entry inflates beyond the size limit before inflating it', () => {
    const archive = kmz({ 'doc.kml': fixtureText('track.kml') });
    expect(parseError(() => parseGeoFile(archive, 'kmz', { maxUncompressedBytes: 100 }))).toMatch(/exceeds the 100-byte limit/);
  });
});
