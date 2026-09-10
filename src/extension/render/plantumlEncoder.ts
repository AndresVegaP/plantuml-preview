/**
 * PlantUML's URL text encoding.
 *
 * A PlantUML server accepts a diagram as a path segment: the source is
 * UTF-8 encoded, raw-DEFLATE compressed, then written in a base64-like alphabet
 * chosen so the result is URL-safe.
 *
 * Implemented here on `node:zlib` rather than pulled in as a dependency: the
 * algorithm is thirty lines, and a dependency-free extension is the whole point
 * of this project's supply-chain posture.
 */

import { deflateRawSync } from 'node:zlib';

/**
 * PlantUML's 6-bit alphabet.
 *
 * Note that it is **not** standard base64: digits come first, and the last two
 * symbols are `-` and `_`. Feeding standard base64 to a PlantUML server
 * produces a "cannot decode" diagram rather than an error, which is why this
 * ordering is spelled out explicitly and covered by a test.
 */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';

/**
 * Encodes diagram source for use in a PlantUML server URL.
 *
 * The result carries no prefix, which every PlantUML server understands as
 * "deflate". (The `~1` prefix means the same thing on modern servers but is
 * rejected by older ones, so the bare form is the compatible choice.)
 */
export function encodePlantUmlText(source: string): string {
  const utf8 = Buffer.from(source, 'utf8');
  // Level 9: the payload travels in a URL, where length is the binding
  // constraint, and diagram sources are small enough that time is irrelevant.
  const compressed = deflateRawSync(utf8, { level: 9 });
  return encode64(compressed);
}

/** Encodes bytes with PlantUML's alphabet, three bytes at a time. */
function encode64(data: Buffer): string {
  let out = '';
  for (let i = 0; i < data.length; i += 3) {
    const b1 = data[i] ?? 0;
    const b2 = data[i + 1] ?? 0;
    const b3 = data[i + 2] ?? 0;
    out += append3bytes(b1, b2, b3);
  }
  return out;
}

function append3bytes(b1: number, b2: number, b3: number): string {
  const c1 = b1 >> 2;
  const c2 = ((b1 & 0x3) << 4) | (b2 >> 4);
  const c3 = ((b2 & 0xf) << 2) | (b3 >> 6);
  const c4 = b3 & 0x3f;
  return encode6bit(c1) + encode6bit(c2) + encode6bit(c3) + encode6bit(c4);
}

function encode6bit(value: number): string {
  return ALPHABET[value & 0x3f] ?? '?';
}

/** Exposed for tests, which assert the alphabet has not been reordered. */
export const PLANTUML_ALPHABET = ALPHABET;
