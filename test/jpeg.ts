/**
 * Build a synthetic JPEG with an EXIF block, for tests: no real photo
 * ever enters the repository.
 */

export interface SyntheticExif {
  bigEndian?: boolean;
  /** Decimal degrees; negative = S / W. */
  lat?: number;
  lon?: number;
  /** EXIF `DateTimeOriginal`, "YYYY:MM:DD HH:MM:SS". */
  takenAt?: string;
  orientation?: number;
  thumbnail?: Uint8Array;
  /** Bytes of filler placed BEFORE the APP1 segment (an APP0 / JFIF block). */
  leadingApp0?: number;
}

type Entry = { tag: number; type: number; count: number; value: number[] | Uint8Array | 'pointer' };

const SHORT = 3;
const LONG = 4;
const ASCII = 2;
const RATIONAL = 5;

function dms(deg: number): number[] {
  const abs = Math.abs(deg);
  const d = Math.floor(abs);
  const m = Math.floor((abs - d) * 60);
  const s = Math.round(((abs - d) * 60 - m) * 60 * 10000);
  return [d, 1, m, 1, s, 10000];
}

/** Lay out IFDs into a TIFF block; returns the bytes. */
function tiff(ex: SyntheticExif): Uint8Array {
  const le = !ex.bigEndian;
  const buf = new ArrayBuffer(4096 + (ex.thumbnail?.length ?? 0));
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let end = 8;
  const u16 = (at: number, v: number): void => view.setUint16(at, v, le);
  const u32 = (at: number, v: number): void => view.setUint32(at, v, le);
  bytes.set(le ? [0x49, 0x49] : [0x4d, 0x4d], 0);
  u16(2, 42);
  u32(4, 8);

  const writeIfd = (entries: Entry[], next = 0): { at: number; pointers: Map<number, number> } => {
    const at = end;
    u16(at, entries.length);
    end = at + 2 + entries.length * 12 + 4;
    const pointers = new Map<number, number>();
    entries.forEach((e, i) => {
      const p = at + 2 + i * 12;
      u16(p, e.tag);
      u16(p + 2, e.type);
      u32(p + 4, e.count);
      if (e.value === 'pointer') { pointers.set(e.tag, p + 8); return; }
      const size = e.type === SHORT ? 2 : e.type === LONG ? 4 : e.type === RATIONAL ? 8 : 1;
      const total = size * e.count;
      const target = total <= 4 ? p + 8 : end;
      if (total > 4) { u32(p + 8, end); end += total + (total % 2); }
      if (!Array.isArray(e.value)) bytes.set(e.value, target);
      else if (e.type === SHORT) e.value.forEach((v, k) => u16(target + k * 2, v));
      else if (e.type === LONG) e.value.forEach((v, k) => u32(target + k * 4, v));
      else if (e.type === RATIONAL) e.value.forEach((v, k) => u32(target + k * 4, v));
    });
    u32(at + 2 + entries.length * 12, next);
    return { at, pointers };
  };

  const ifd0: Entry[] = [];
  if (ex.orientation) ifd0.push({ tag: 0x0112, type: SHORT, count: 1, value: [ex.orientation] });
  if (ex.takenAt) ifd0.push({ tag: 0x8769, type: LONG, count: 1, value: 'pointer' });
  if (ex.lat !== undefined) ifd0.push({ tag: 0x8825, type: LONG, count: 1, value: 'pointer' });
  const zero = writeIfd(ifd0);
  if (ex.takenAt) {
    const exif = writeIfd([{ tag: 0x9003, type: ASCII, count: 20, value: new TextEncoder().encode(`${ex.takenAt}\0`) }]);
    u32(zero.pointers.get(0x8769)!, exif.at);
  }
  if (ex.lat !== undefined && ex.lon !== undefined) {
    const ascii = (s: string): Uint8Array => new TextEncoder().encode(`${s}\0`);
    const gps = writeIfd([
      { tag: 1, type: ASCII, count: 2, value: ascii(ex.lat < 0 ? 'S' : 'N') },
      { tag: 2, type: RATIONAL, count: 3, value: dms(ex.lat) },
      { tag: 3, type: ASCII, count: 2, value: ascii(ex.lon < 0 ? 'W' : 'E') },
      { tag: 4, type: RATIONAL, count: 3, value: dms(ex.lon) },
    ]);
    u32(zero.pointers.get(0x8825)!, gps.at);
  }
  if (ex.thumbnail) {
    const thumbAt = end + 64;
    const one = writeIfd([
      { tag: 0x0201, type: LONG, count: 1, value: [thumbAt] },
      { tag: 0x0202, type: LONG, count: 1, value: [ex.thumbnail.length] },
    ]);
    u32(zero.at + 2 + ifd0.length * 12, one.at);
    bytes.set(ex.thumbnail, thumbAt);
    end = thumbAt + ex.thumbnail.length;
  }
  return bytes.slice(0, end);
}

export function syntheticJpeg(ex: SyntheticExif): Uint8Array {
  const parts: number[] = [0xff, 0xd8];
  if (ex.leadingApp0) {
    const len = ex.leadingApp0 + 2;
    parts.push(0xff, 0xe0, len >> 8, len & 0xff, ...new Array(ex.leadingApp0).fill(0));
  }
  const body = tiff(ex);
  const len = body.length + 8;
  parts.push(0xff, 0xe1, len >> 8, len & 0xff, 0x45, 0x78, 0x69, 0x66, 0, 0, ...body);
  // A tiny "scan" so the file looks like a JPEG past the header.
  parts.push(0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9);
  return new Uint8Array(parts);
}

/** A fake embedded thumbnail: just a JPEG-looking byte run. */
export const THUMB = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 9, 8, 7, 6, 0xff, 0xd9]);
