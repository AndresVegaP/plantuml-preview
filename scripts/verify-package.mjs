/**
 * Audits the built `.vsix` before it is installed.
 *
 * The point is that a reviewer — or a security team — can run one command and
 * get a factual answer to the questions they will actually ask:
 *
 *   - What does this extension contain?
 *   - Does it declare any runtime dependencies?
 *   - Does the bundled rendering engine match the published npm package?
 *   - Does it talk to the network, and under what conditions?
 *
 *   node scripts/verify-package.mjs [path/to/plantuml-preview.vsix]
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(label, ok, detail = '') {
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}\n`);
  if (!ok) {
    failures += 1;
  }
}

function heading(text) {
  process.stdout.write(`\n${text}\n${'-'.repeat(text.length)}\n`);
}

// ---------------------------------------------------------------------------

heading('Manifest');

const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

check(
  'declares no runtime dependencies',
  Object.keys(manifest.dependencies ?? {}).length === 0,
  `dependencies: ${JSON.stringify(manifest.dependencies ?? {})}`,
);
check('is MIT licensed', manifest.license === 'MIT', manifest.license);
check(
  'limits what an untrusted workspace may do',
  manifest.capabilities?.untrustedWorkspaces?.supported === 'limited',
);
check(
  'does not activate on startup',
  !(manifest.activationEvents ?? []).includes('*'),
  (manifest.activationEvents ?? []).join(', ') || 'none',
);

// ---------------------------------------------------------------------------

heading('Vendored rendering engine');

const enginePath = path.join(root, 'media', 'engine');
if (!existsSync(path.join(enginePath, 'MANIFEST.json'))) {
  check('media/engine/MANIFEST.json exists', false, 'run "npm run vendor"');
} else {
  const engineManifest = JSON.parse(
    await readFile(path.join(enginePath, 'MANIFEST.json'), 'utf8'),
  );
  check('engine is MIT licensed', engineManifest.license === 'MIT', engineManifest.license);
  process.stdout.write(`        ${engineManifest.engine}@${engineManifest.version}\n`);

  for (const [name, expected] of Object.entries(engineManifest.files)) {
    const file = path.join(enginePath, name);
    if (!existsSync(file)) {
      check(`${name} is present`, false);
      continue;
    }
    const bytes = await readFile(file);
    const digest = createHash('sha256').update(bytes).digest('hex');
    check(`${name} matches its recorded SHA-256`, digest === expected.sha256, digest.slice(0, 16));
  }
}

// ---------------------------------------------------------------------------

heading('Network posture');

const sources = await collect(path.join(root, 'src'), '.ts');
const networkCalls = [];
for (const file of sources) {
  const text = await readFile(file, 'utf8');
  const relative = path.relative(root, file);
  for (const [line, content] of text.split('\n').entries()) {
    if (/\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(/u.test(content)) {
      networkCalls.push(`${relative}:${line + 1}`);
    }
  }
}
check(
  'no ad-hoc network calls in extension source',
  networkCalls.length === 0,
  networkCalls.join(', '),
);

const serverRenderer = await readFile(
  path.join(root, 'src', 'extension', 'render', 'serverRenderer.ts'),
  'utf8',
);
check(
  'the only HTTP client is the opt-in server backend',
  serverRenderer.includes("import * as http from 'node:http'"),
);

const webviewHtml = await readFile(
  path.join(root, 'src', 'extension', 'preview', 'webviewHtml.ts'),
  'utf8',
);
for (const directive of [
  "default-src 'none'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
]) {
  check(`webview CSP sets ${directive}`, webviewHtml.includes(directive));
}
check(
  'webview scripts are nonce-gated',
  webviewHtml.includes("'nonce-${nonce}'"),
);
check(
  'webview resources are confined to media/',
  (await readFile(path.join(root, 'src', 'extension', 'preview', 'preview.ts'), 'utf8')).includes(
    "localResourceRoots: [vscode.Uri.joinPath(this.deps.extensionUri, 'media')]",
  ),
);

// ---------------------------------------------------------------------------

heading('Package contents');

const vsix = process.argv[2] ?? path.join(root, 'plantuml-preview.vsix');
if (!existsSync(vsix)) {
  process.stdout.write(`  SKIP  ${path.relative(root, vsix)} not built yet (run "npm run package")\n`);
} else {
  const info = await stat(vsix);
  process.stdout.write(`  INFO  ${path.basename(vsix)} — ${(info.size / 1048576).toFixed(2)} MB\n`);
  check('the package is a plausible size', info.size > 1_000_000 && info.size < 40 * 1048576);

  const entries = await listZipEntries(vsix);
  process.stdout.write(`  INFO  ${entries.length} files\n`);

  // A .vsix is built from an ignore-list, which fails open: forget one entry
  // and the package quietly grows a directory it should never contain. These
  // are the mistakes worth catching before anyone installs it.
  const forbidden = [
    ['TypeScript sources', /^extension\/(?!.*\.d\.ts$).*\.ts$/u],
    ['source maps', /\.map$/u],
    ['downloaded VS Code builds', /^extension\/\.vscode-test\//u],
    ['agent or editor state', /^extension\/\.(?:claude|vscode|git)\//u],
    ['node_modules', /^extension\/node_modules\//u],
    ['plantuml jars', /\.jar$/u],
    ['build configuration', /^extension\/(?:tsconfig|eslint\.config)/u],
    ['tests or build scripts', /^extension\/(?:test|scripts)\//u],
  ];
  for (const [label, pattern] of forbidden) {
    const hits = entries.filter((entry) => pattern.test(entry));
    check(`contains no ${label}`, hits.length === 0, hits.slice(0, 3).join(', '));
  }

  const required = [
    'extension/out/extension/extension.js',
    'extension/media/dist/webview/main.js',
    'extension/media/engine/plantuml.js',
    'extension/media/engine/viz-global.js',
    'extension/media/engine/LICENSE',
    'extension/media/preview.css',
    'extension/syntaxes/plantuml.tmLanguage.json',
    'extension/language-configuration.json',
  ];
  for (const entry of required) {
    check(`contains ${entry.replace('extension/', '')}`, entries.includes(entry));
  }

  // vsce lower-cases the readme and changelog and gives the licence a .txt
  // suffix, so these are matched by shape rather than by exact name.
  check(
    'contains the extension licence',
    entries.some((entry) => /^extension\/LICENSE(?:\.txt|\.md)?$/iu.test(entry)),
  );
  check(
    'contains the readme',
    entries.some((entry) => /^extension\/readme\.md$/iu.test(entry)),
  );
  check(
    'contains the security notes',
    entries.some((entry) => /^extension\/security\.md$/iu.test(entry)),
  );
}

// ---------------------------------------------------------------------------

process.stdout.write(
  failures === 0
    ? '\nAll checks passed.\n'
    : `\n${failures} check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);

/**
 * Lists the entries of a ZIP archive by reading its central directory.
 *
 * Hand-rolled so that auditing the package needs no dependency of its own — a
 * verification tool that pulls in third-party code undermines the thing it is
 * verifying.
 */
async function listZipEntries(file) {
  const buffer = await readFile(file);

  // Locate the End Of Central Directory record, scanning back from the end
  // because it is followed by a variable-length comment.
  const EOCD_SIGNATURE = 0x06054b50;
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 22 - 65_535; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error('The .vsix does not look like a ZIP archive.');
  }

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  const names = [];
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('Malformed ZIP central directory.');
    }
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    names.push(buffer.toString('utf8', offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

/** Lists every file under `directory` with the given extension. */
async function collect(directory, extension) {
  const found = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await collect(full, extension)));
    } else if (entry.name.endsWith(extension)) {
      found.push(full);
    }
  }
  return found;
}
