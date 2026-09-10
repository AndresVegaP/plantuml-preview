/**
 * Downloads a VS Code build and runs the integration suite inside it.
 *
 * Uses `@vscode/test-electron` directly rather than `@vscode/test-cli`: the CLI
 * pulls in Mocha, whose current dependency tree carries published advisories,
 * and this project keeps `npm audit` clean including devDependencies.
 *
 *   node scripts/run-integration-tests.mjs [--version=stable|insiders|1.90.0]
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runTests } from '@vscode/test-electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((entry) => /^--([a-z-]+)(?:=(.*))?$/u.exec(entry))
    .filter((match) => match !== null)
    .map((match) => [match[1], match[2] ?? true]),
);

try {
  await runTests({
    version: typeof args.version === 'string' ? args.version : 'stable',
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, 'test', 'integration', 'index.cjs'),
    launchArgs: [
      // A clean, isolated profile: no user settings, no other extensions, and
      // no shared state between runs.
      '--disable-extensions',
      '--disable-gpu',
      '--disable-workspace-trust',
      path.join(root, 'samples'),
    ],
  });
} catch (error) {
  console.error('\nIntegration tests failed.');
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
}
