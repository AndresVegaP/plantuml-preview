/**
 * Downloads a `plantuml.jar` for the optional `jar` rendering backend.
 *
 * Most users never need this: the default backend is the bundled JavaScript
 * engine, which needs no Java. The jar exists for people who want PlantUML's
 * full feature set or a specific version their organisation has approved.
 *
 * Two things make this safe to run inside a company:
 *
 * 1. **A licence is chosen explicitly.** PlantUML publishes the same engine
 *    under several licences. The default here is the MIT build, so the
 *    downloaded artefact carries no copyleft obligation. `--license=gpl` is
 *    available for the full-featured build if that is acceptable to you.
 * 2. **The download is verified.** Maven Central publishes a `.sha1` next to
 *    every artefact; the jar is rejected unless it matches.
 *
 *   node scripts/fetch-plantuml-jar.mjs [--version=1.2026.8] [--license=mit|asl|lgpl|epl|gpl] [--out=vendor]
 *
 * The jar is written outside the extension package (`vendor/` is git-ignored
 * and excluded from the `.vsix`) and its path is printed for you to paste into
 * the `plantuml.render.jarPath` setting.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import * as https from 'node:https';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Maven Central artefact ids for each licence PlantUML publishes under. */
const ARTIFACTS = {
  mit: 'plantuml-mit',
  asl: 'plantuml-asl',
  lgpl: 'plantuml-lgpl',
  epl: 'plantuml-epl',
  gpl: 'plantuml',
};

const MAVEN_BASE = 'https://repo1.maven.org/maven2/net/sourceforge/plantuml';

const args = parseArgs(process.argv.slice(2));
const licence = String(args.license ?? 'mit').toLowerCase();
const artifact = ARTIFACTS[licence];
if (artifact === undefined) {
  fail(`Unknown licence "${licence}". Choose one of: ${Object.keys(ARTIFACTS).join(', ')}.`);
}

const version = String(args.version ?? '1.2026.8');
if (!/^\d+\.\d+\.\d+$/u.test(version)) {
  fail(`"${version}" does not look like a PlantUML version (expected e.g. 1.2026.8).`);
}

const outDir = path.resolve(root, String(args.out ?? 'vendor'));
const jarName = `${artifact}-${version}.jar`;
const jarUrl = `${MAVEN_BASE}/${artifact}/${version}/${jarName}`;
const shaUrl = `${jarUrl}.sha1`;
const target = path.join(outDir, 'plantuml.jar');

process.stdout.write(`Downloading ${jarUrl}\n`);

const [jar, expectedSha] = await Promise.all([download(jarUrl), download(shaUrl)]);

const actual = createHash('sha1').update(jar).digest('hex');
const expected = expectedSha.toString('utf8').trim().split(/\s+/u)[0]?.toLowerCase();

if (expected === undefined || expected.length !== 40) {
  fail('Maven Central did not return a usable SHA-1 checksum; refusing to install an unverified jar.');
}
if (actual !== expected) {
  fail(
    `Checksum mismatch. Expected ${expected}, got ${actual}.\n` +
      'The download was corrupted or tampered with; nothing has been written.',
  );
}

if (existsSync(target) && args.force !== true) {
  process.stdout.write(`${target} already exists. Re-run with --force to replace it.\n`);
  process.exit(0);
}

await mkdir(outDir, { recursive: true });
await writeFile(target, jar);

process.stdout.write(
  [
    '',
    `Verified and saved ${jarName} (${(jar.length / 1048576).toFixed(1)} MB, licence: ${licence.toUpperCase()})`,
    `  ${target}`,
    '',
    'To use it, set in VS Code settings:',
    '  "plantuml.render.backend": "jar",',
    `  "plantuml.render.jarPath": ${JSON.stringify(target)}`,
    '',
    'Java 8 or newer must be on PATH or named by plantuml.render.javaPath.',
    '',
  ].join('\n'),
);

/**
 * Fetches a URL into a Buffer.
 *
 * Redirects are followed only within Maven Central, so a hijacked redirect
 * cannot send the request somewhere else.
 */
function download(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error('Too many redirects.'));
      return;
    }
    https
      .get(url, { headers: { accept: '*/*' } }, (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location !== undefined) {
          const next = new URL(response.headers.location, url);
          response.resume();
          if (next.protocol !== 'https:' || next.hostname !== 'repo1.maven.org') {
            reject(new Error(`Refusing to follow a redirect to ${next.origin}.`));
            return;
          }
          resolve(download(next.href, redirects + 1));
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(new Error(`HTTP ${status} for ${url}`));
          return;
        }
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks)));
        response.on('error', reject);
      })
      .on('error', reject);
  });
}

function parseArgs(argv) {
  const out = {};
  for (const entry of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/u.exec(entry);
    if (match !== null) {
      out[match[1]] = match[2] ?? true;
    }
  }
  return out;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
