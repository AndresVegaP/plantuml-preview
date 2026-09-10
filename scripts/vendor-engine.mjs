/**
 * Copies the PlantUML JavaScript engine into `media/engine/`.
 *
 * The engine is a *build-time* dependency, not a runtime one: the extension
 * ships the two files it needs and declares no npm dependencies at all. That
 * keeps the installed extension's dependency tree empty, which is the whole
 * point of the supply-chain posture — there is nothing to audit at runtime
 * beyond these files and the extension's own code.
 *
 * Every copied file's SHA-256 is written to `media/engine/MANIFEST.json` so the
 * exact bytes shipped in a `.vsix` can be verified later against the published
 * npm package.
 *
 *   node scripts/vendor-engine.mjs [--check]
 *
 * `--check` verifies an existing vendored copy instead of rewriting it, which
 * is what CI runs.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'node_modules', '@plantuml', 'core');
const target = path.join(root, 'media', 'engine');

/**
 * Files taken from the package.
 *
 * Deliberately minimal: `emoji.js` and `openiconic.js` are large optional
 * sprite bundles that most diagrams never touch, and `themes.js` is only needed
 * for `!theme` directives. Including them would triple the package size.
 */
const FILES = ['plantuml.js', 'viz-global.js', 'LICENSE'];

const checkOnly = process.argv.includes('--check');

async function main() {
  if (!existsSync(source)) {
    fail(
      `@plantuml/core is not installed at ${source}.\n` +
        'Run "npm install" first — it is a devDependency, vendored at build time.',
    );
  }

  const packageJson = JSON.parse(
    await readFile(path.join(source, 'package.json'), 'utf8'),
  );

  if (packageJson.license !== 'MIT') {
    fail(
      `Refusing to vendor @plantuml/core@${packageJson.version}: its license is ` +
        `"${packageJson.license}", not MIT.\n` +
        'Versions before 1.2026.6 were GPL-3.0-or-later. Pin a version >= 1.2026.6.',
    );
  }

  await mkdir(target, { recursive: true });

  const manifest = {
    engine: '@plantuml/core',
    version: packageJson.version,
    license: packageJson.license,
    files: {},
  };

  const problems = [];
  for (const name of FILES) {
    const from = path.join(source, name);
    if (!existsSync(from)) {
      fail(`@plantuml/core is missing ${name}.`);
    }
    const bytes = await readFile(from);
    const digest = createHash('sha256').update(bytes).digest('hex');
    manifest.files[name] = { bytes: bytes.length, sha256: digest };

    const to = path.join(target, name);
    if (checkOnly) {
      if (!existsSync(to)) {
        problems.push(`${name} has not been vendored`);
        continue;
      }
      const vendored = await readFile(to);
      const vendoredDigest = createHash('sha256').update(vendored).digest('hex');
      if (vendoredDigest !== digest) {
        problems.push(`${name} differs from the installed package`);
      }
      continue;
    }
    await writeFile(to, bytes);
    process.stdout.write(
      `  ${name.padEnd(16)} ${formatSize(bytes.length).padStart(9)}  sha256:${digest.slice(0, 16)}…\n`,
    );
  }

  const manifestPath = path.join(target, 'MANIFEST.json');
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;

  if (checkOnly) {
    const existing = existsSync(manifestPath) ? await readFile(manifestPath, 'utf8') : '';
    if (existing !== manifestText) {
      problems.push('MANIFEST.json is out of date');
    }
    if (problems.length > 0) {
      fail(`The vendored engine is stale:\n  - ${problems.join('\n  - ')}\nRun "npm run vendor".`);
    }
    process.stdout.write(
      `Vendored engine matches @plantuml/core@${packageJson.version} (${packageJson.license}).\n`,
    );
    return;
  }

  await writeFile(manifestPath, manifestText);
  process.stdout.write(
    `Vendored @plantuml/core@${packageJson.version} (${packageJson.license}) into media/engine.\n`,
  );
}

function formatSize(bytes) {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(2)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

await main();
