/**
 * A static file server for the browser harness.
 *
 * The rendering engine and the webview code are ES modules, which browsers
 * refuse to load over `file://`. This serves the repository over loopback so
 * the harness can exercise exactly the files that ship.
 *
 *   node test/browser/server.mjs [--port=8731]
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const portArgument = process.argv.find((entry) => entry.startsWith('--port='));
const port = portArgument === undefined ? 8731 : Number.parseInt(portArgument.slice(7), 10);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = createServer((request, response) => {
  const requestedPath = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
  const resolved = path.resolve(root, `.${requestedPath}`);

  // Never serve anything outside the repository, even for a harness.
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  void (async () => {
    try {
      const info = await stat(resolved);
      if (info.isDirectory()) {
        response.writeHead(404).end('Not found');
        return;
      }
      response.writeHead(200, {
        'content-type': TYPES[path.extname(resolved)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      createReadStream(resolved).pipe(response);
    } catch {
      response.writeHead(404).end('Not found');
    }
  })();
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`harness server on http://127.0.0.1:${port}/\n`);
});
