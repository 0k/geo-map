import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';

export function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(import.meta.dirname, 'fixtures', name)));
}

export function fixtureText(name: string): string {
  return readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
}

/** A KMZ archive (zip) holding the given entries. */
export function kmz(entries: Record<string, string | Uint8Array>): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (const [name, body] of Object.entries(entries)) files[name] = typeof body === 'string' ? strToU8(body) : body;
  return zipSync(files);
}
