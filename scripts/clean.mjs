/**
 * Removes build output.
 *
 * Written in Node rather than as a shell one-liner so the same command works on
 * Windows, macOS and Linux without a cross-platform shim dependency.
 */

import { rm } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TARGETS = ['out', 'media/dist', 'media/engine', '.eslintcache'];

for (const target of TARGETS) {
  await rm(path.join(root, target), { recursive: true, force: true });
  process.stdout.write(`  removed ${target}\n`);
}
