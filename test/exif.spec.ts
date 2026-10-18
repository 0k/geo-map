import { describe, expect, it } from 'vitest';
import { readPhotoMeta } from '../src/exif';
import { syntheticJpeg, THUMB } from './jpeg';

describe('readPhotoMeta', () => {
  it.each([false, true])('reads position, time, orientation and the embedded thumbnail (big endian: %s)', (bigEndian) => {
    const meta = readPhotoMeta(syntheticJpeg({
      bigEndian, lat: 45.00074, lon: 10.02883, takenAt: '2020:05:17 08:04:02', orientation: 6, thumbnail: THUMB, leadingApp0: 16,
    }));
    expect(meta.lat).toBeCloseTo(45.00074, 5);
    expect(meta.lon).toBeCloseTo(10.02883, 5);
    expect(meta.takenAt).toBe('2020-05-17T08:04:02');
    expect(meta.orientation).toBe(6);
    expect(Array.from(meta.thumbnail ?? [])).toEqual(Array.from(THUMB));
  });

  it('signs southern and western positions', () => {
    const meta = readPhotoMeta(syntheticJpeg({ lat: -33.85, lon: -70.65 }));
    expect([meta.lat, meta.lon].map((v) => Number(v?.toFixed(2)))).toEqual([-33.85, -70.65]);
  });

  it('returns empty metadata, never throws, for photos without EXIF or with broken / truncated EXIF', () => {
    const none = { lat: null, lon: null, takenAt: null, orientation: null, thumbnail: null };
    expect(readPhotoMeta(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toEqual(none);
    expect(readPhotoMeta(new TextEncoder().encode('not a jpeg'))).toEqual(none);
    const full = syntheticJpeg({ lat: 1, lon: 2, takenAt: '2020:05:17 08:04:02', thumbnail: THUMB });
    for (let cut = 4; cut < full.length; cut += 7) {
      expect(() => readPhotoMeta(full.subarray(0, cut))).not.toThrow();
    }
  });

  it('drops an embedded thumbnail that runs past the bytes it was given', () => {
    const full = syntheticJpeg({ lat: 1, lon: 2, thumbnail: THUMB });
    const meta = readPhotoMeta(full.subarray(0, full.length - 15));
    expect(meta.thumbnail).toBeNull();
    expect(meta.lat).toBeCloseTo(1, 5);
  });
});
