/**
 * Serves the browser harnesses.
 *
 * These are a *manual* inspection tool, not part of `npm test`: they let you
 * look at the real preview — the vendored engine plus the compiled webview
 * bundle plus the shipped stylesheet — in an ordinary browser, without
 * launching VS Code. Useful when working on layout, theming or the zoom
 * behaviour, where a screenshot beats an assertion.
 *
 * The automated equivalent lives in the integration suite, which asserts that a
 * diagram really rendered inside a VS Code webview.
 *
 *   npm run harness
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 8731;

for (const required of [
  ['media/engine/plantuml.js', 'npm run vendor'],
  ['media/dist/webview/main.js', 'npm run compile'],
]) {
  if (!existsSync(path.join(root, required[0]))) {
    process.stderr.write(`Missing ${required[0]}. Run "${required[1]}" first.\n`);
    process.exit(1);
  }
}

process.stdout.write(
  [
    '',
    `  Preview harness   http://127.0.0.1:${port}/test/browser/preview-harness.html`,
    `  Engine harness    http://127.0.0.1:${port}/test/browser/engine-harness.html`,
    '',
    '  The engine harness reports its result in window.__harness.',
    '  Press Ctrl+C to stop.',
    '',
  ].join('\n'),
);

const server = spawn(
  process.execPath,
  [path.join(root, 'test', 'browser', 'server.mjs'), `--port=${port}`],
  { stdio: 'inherit' },
);

server.on('exit', (code) => process.exit(code ?? 0));
