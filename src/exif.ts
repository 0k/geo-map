/**
 * Read what a map needs from a JPEG's EXIF block: GPS position, time
 * taken, orientation, and the small embedded thumbnail.
 *
 * Works on the first bytes of the file only (the EXIF block sits at the
 * start and is at most 64 KiB), so a host can fetch a bounded prefix
 * rather than the whole photo.  Never throws: anything missing,
 * malformed or cut short yields null for that field.
 */

import { toBytes } from './geometry.js';

export interface PhotoMeta {
  /** Decimal degrees, negative south. */
  lat: number | null;
  /** Decimal degrees, negative west. */
  lon: number | null;
  /** `DateTimeOriginal` as `YYYY-MM-DDTHH:MM:SS` (camera local time, no zone). */
  takenAt: string | null;
  /** EXIF orientation 1..8. */
  orientation: number | null;
  /** The embedded JPEG thumbnail (IFD1), when entirely within the bytes. */
  thumbnail: Uint8Array | null;
}

const EMPTY: PhotoMeta = { lat: null, lon: null, takenAt: null, orientation: null, thumbnail: null };

const TAG_ORIENTATION = 0x0112;
const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_THUMB_OFFSET = 0x0201;
const TAG_THUMB_LENGTH = 0x0202;
const GPS_LAT_REF = 1;
const GPS_LAT = 2;
const GPS_LON_REF = 3;
const GPS_LON = 4;

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

class Tiff {
  constructor(readonly view: DataView, readonly le: boolean) {}

  u16(at: number): number {
    return this.view.getUint16(at, this.le);
  }

  u32(at: number): number {
    return this.view.getUint32(at, this.le);
  }

  /** Map tag -> entry offset for the IFD at `at`. */
  entries(at: number): Map<number, number> {
    const out = new Map<number, number>();
    const count = this.u16(at);
    for (let i = 0; i < count; i += 1) {
      const entry = at + 2 + i * 12;
      out.set(this.u16(entry), entry);
    }
    return out;
  }

  nextIfd(at: number): number {
    return this.u32(at + 2 + this.u16(at) * 12);
  }

  /** Offset of an entry's value (inline when it fits in 4 bytes). */
  valueAt(entry: number): { type: number; count: number; at: number } {
    const type = this.u16(entry + 2);
    const count = this.u32(entry + 4);
    const size = (TYPE_SIZE[type] ?? 1) * count;
    return { type, count, at: size <= 4 ? entry + 8 : this.u32(entry + 8) };
  }

  number(entry: number): number {
    const { type, at } = this.valueAt(entry);
    return type === 3 ? this.u16(at) : this.u32(at);
  }

  ascii(entry: number): string {
    const { count, at } = this.valueAt(entry);
    let out = '';
    for (let i = 0; i < count; i += 1) {
      const c = this.view.getUint8(at + i);
      if (c === 0) break;
      out += String.fromCharCode(c);
    }
    return out;
  }

  /** Degrees / minutes / seconds rationals -> decimal degrees. */
  dms(entry: number): number | null {
    const { type, count, at } = this.valueAt(entry);
    if (type !== 5 || count < 3) return null;
    let total = 0;
    for (let i = 0; i < 3; i += 1) {
      const den = this.u32(at + i * 8 + 4);
      if (den === 0) return null;
      total += this.u32(at + i * 8) / den / 60 ** i;
    }
    return total;
  }
}

/** The TIFF block inside the APP1 "Exif" segment, or null. */
function findTiff(bytes: Uint8Array): Tiff | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0) !== 0xffd8) return null;
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (view.getUint8(at) !== 0xff) return null;
    const marker = view.getUint8(at + 1);
    // Start of scan / end of image: no metadata past here.
    if (marker === 0xda || marker === 0xd9) return null;
    const length = view.getUint16(at + 2);
    if (marker === 0xe1 && at + 10 <= bytes.length && view.getUint32(at + 4) === 0x45786966 && view.getUint16(at + 8) === 0) {
      const start = at + 10;
      const end = Math.min(bytes.length, at + 2 + length);
      const tiff = new DataView(bytes.buffer, bytes.byteOffset + start, end - start);
      const order = tiff.getUint16(0);
      if (order !== 0x4949 && order !== 0x4d4d) return null;
      return new Tiff(tiff, order === 0x4949);
    }
    at += 2 + length;
  }
  return null;
}

/** "2020:05:17 08:04:02" -> "2020-05-17T08:04:02" (null if malformed). */
function isoTime(raw: string): string | null {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(raw.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : null;
}

function attempt<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    // Out-of-bounds reads mean "cut short or malformed": the field is absent.
    return null;
  }
}

export function readPhotoMeta(data: ArrayBuffer | Uint8Array): PhotoMeta {
  const bytes = toBytes(data);
  const tiff = attempt(() => findTiff(bytes));
  if (!tiff) return { ...EMPTY };
  const ifd0At = attempt(() => tiff.u32(4));
  const ifd0 = ifd0At === null ? null : attempt(() => tiff.entries(ifd0At));
  if (!ifd0 || ifd0At === null) return { ...EMPTY };
  const meta: PhotoMeta = { ...EMPTY };

  const orientation = ifd0.get(TAG_ORIENTATION);
  if (orientation !== undefined) {
    const value = attempt(() => tiff.number(orientation));
    if (value !== null && value >= 1 && value <= 8) meta.orientation = value;
  }

  const exifPointer = ifd0.get(TAG_EXIF_IFD);
  if (exifPointer !== undefined) {
    meta.takenAt = attempt(() => {
      const exif = tiff.entries(tiff.number(exifPointer));
      const entry = exif.get(TAG_DATETIME_ORIGINAL);
      return entry === undefined ? null : isoTime(tiff.ascii(entry));
    });
  }

  const gpsPointer = ifd0.get(TAG_GPS_IFD);
  if (gpsPointer !== undefined) {
    const position = attempt(() => {
      const gps = tiff.entries(tiff.number(gpsPointer));
      const [latE, lonE, latRefE, lonRefE] = [gps.get(GPS_LAT), gps.get(GPS_LON), gps.get(GPS_LAT_REF), gps.get(GPS_LON_REF)];
      if (latE === undefined || lonE === undefined) return null;
      const lat = tiff.dms(latE);
      const lon = tiff.dms(lonE);
      if (lat === null || lon === null || lat > 90 || lon > 180) return null;
      const south = latRefE !== undefined && tiff.ascii(latRefE) === 'S';
      const west = lonRefE !== undefined && tiff.ascii(lonRefE) === 'W';
      return { lat: south ? -lat : lat, lon: west ? -lon : lon };
    });
    // 0,0 is what some cameras write when they have no fix.
    if (position && !(position.lat === 0 && position.lon === 0)) {
      meta.lat = position.lat;
      meta.lon = position.lon;
    }
  }

  meta.thumbnail = attempt(() => {
    const ifd1At = tiff.nextIfd(ifd0At);
    if (!ifd1At) return null;
    const ifd1 = tiff.entries(ifd1At);
    const offsetE = ifd1.get(TAG_THUMB_OFFSET);
    const lengthE = ifd1.get(TAG_THUMB_LENGTH);
    if (offsetE === undefined || lengthE === undefined) return null;
    const offset = tiff.number(offsetE);
    const length = tiff.number(lengthE);
    if (!length || offset + length > tiff.view.byteLength) return null;
    return new Uint8Array(tiff.view.buffer, tiff.view.byteOffset + offset, length).slice();
  });
  return meta;
}
