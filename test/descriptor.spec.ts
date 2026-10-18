import { describe, expect, it } from 'vitest';
import { MapDescriptorError, parseMapDescriptor } from '../src/descriptor';

function error(text: string): string {
  try {
    parseMapDescriptor(text);
  } catch (e) {
    expect(e).toBeInstanceOf(MapDescriptorError);
    return (e as Error).message;
  }
  throw new Error('expected a MapDescriptorError');
}

describe('parseMapDescriptor', () => {
  it('normalises layers, photos and places', () => {
    expect(parseMapDescriptor(`
title: Ridge trip
basemap: opentopomap
layers:
  - file: a.kmz
  - file: /x/b.gpx
    color: '#2f7fe0'
    name: Ride
photos:
  - path: p/1.jpg
    caption: Steps
  - path: p/2.jpg
    at: [45.01, 10.02]
places:
  - name: Hut
    at: [45.02, 10.01]
    note: Slept **here**
`)).toEqual({
      title: 'Ridge trip',
      basemap: 'opentopomap',
      layers: [{ file: 'a.kmz', color: null, name: null }, { file: '/x/b.gpx', color: '#2f7fe0', name: 'Ride' }],
      photos: [{ path: 'p/1.jpg', caption: 'Steps', at: null }, { path: 'p/2.jpg', caption: null, at: [45.01, 10.02] }],
      places: [{ name: 'Hut', at: [45.02, 10.01], note: 'Slept **here**' }],
    });
  });

  it('accepts a descriptor with only one of the three lists', () => {
    expect(parseMapDescriptor('photos: [{path: a.jpg}]').layers).toEqual([]);
  });

  it('rejects malformed descriptors with a reason naming the key', () => {
    expect(error('title: [')).toMatch(/^invalid YAML/);
    expect(error('- a')).toBe('the descriptor must be a mapping');
    expect(error('title: x')).toBe('nothing to show: add layers, photos or places');
    expect(error('layer: [{file: a.kmz}]')).toBe('unknown key "layer" (expected title, basemap, layers, photos, places)');
    expect(error('layers: [{path: a.kmz}]')).toBe('layers[0]: unknown key "path" (expected file, color, name)');
    expect(error('layers: [{color: "#fff"}]')).toBe('layers[0].file: a non-empty string is required');
    expect(error('layers: [{file: a.kmz, color: red}]')).toBe('layers[0].color: expected a #rgb or #rrggbb colour');
    expect(error('photos: [{path: a.jpg, at: [91, 0]}]')).toBe('photos[0].at: expected [latitude, longitude] in degrees');
    expect(error('places: [{name: x}]')).toBe('places[0].at: expected [latitude, longitude] in degrees');
    expect(error('places: [{at: [1, 2]}]')).toBe('places[0].name: a non-empty string is required');
    expect(error('photos: {path: a.jpg}')).toBe('photos: expected a list');
  });
});
