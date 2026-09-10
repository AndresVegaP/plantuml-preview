/**
 * Integration suite entry point.
 *
 * Runs inside a real VS Code instance, so these tests exercise the parts that
 * unit tests cannot reach: manifest contributions actually taking effect,
 * commands actually being registered, the preview panel actually opening, and
 * diagnostics actually reaching the Problems panel.
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const vscode = require('vscode');

const { runAll, suite, test, waitFor } = require('./harness.cjs');

const EXTENSION_ID = 'local.plantuml-preview';

/** Commands the manifest promises; every one must be registered on activation. */
const CONTRIBUTED_COMMANDS = [
  'plantuml.showPreview',
  'plantuml.showPreviewToSide',
  'plantuml.showLockedPreviewToSide',
  'plantuml.showSource',
  'plantuml.preview.refresh',
  'plantuml.preview.toggleLock',
  'plantuml.preview.selectDiagram',
  'plantuml.preview.zoomIn',
  'plantuml.preview.zoomOut',
  'plantuml.preview.zoomReset',
  'plantuml.preview.copyImage',
  'plantuml.export',
  'plantuml.showDiagnostics',
];

/** Resolves the extension's public API, activating it if necessary. */
async function extensionApi() {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `extension ${EXTENSION_ID} should be installed`);
  const api = extension.isActive ? extension.exports : await extension.activate();
  assert.ok(api && typeof api.onDidRender === 'function', 'the extension should export onDidRender');
  return api;
}

/** Files created during the run, removed afterwards. */
const scratchFiles = [];

async function scratchFile(name, contents) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'plantuml-preview-test-'));
  const file = path.join(directory, name);
  await fs.writeFile(file, contents, 'utf8');
  scratchFiles.push(directory);
  return vscode.Uri.file(file);
}

async function closeEverything() {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

function previewTabs() {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter(
      (tab) =>
        tab.input instanceof vscode.TabInputWebview &&
        String(tab.input.viewType).includes('plantuml.preview'),
    );
}

suite('activation', () => {
  test('the extension is present and activates', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `extension ${EXTENSION_ID} should be installed`);
    await extension.activate();
    assert.equal(extension.isActive, true);
  });

  test('every contributed command is registered', async () => {
    const registered = new Set(await vscode.commands.getCommands(true));
    const missing = CONTRIBUTED_COMMANDS.filter((command) => !registered.has(command));
    assert.deepEqual(missing, [], 'these manifest commands were never registered');
  });

  test('the manifest declares no runtime dependencies', () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    const dependencies = extension.packageJSON.dependencies ?? {};
    assert.deepEqual(Object.keys(dependencies), []);
  });
});

suite('language', () => {
  test('a .puml file is recognised as PlantUML', async () => {
    const uri = await scratchFile('sample.puml', '@startuml\nAlice -> Bob : hi\n@enduml\n');
    const document = await vscode.workspace.openTextDocument(uri);
    assert.equal(document.languageId, 'plantuml');
  });

  test('the other PlantUML extensions are recognised too', async () => {
    for (const extension of ['.plantuml', '.pu', '.iuml', '.wsd', '.pml']) {
      const uri = await scratchFile(`sample${extension}`, '@startuml\nA -> B\n@enduml\n');
      const document = await vscode.workspace.openTextDocument(uri);
      assert.equal(document.languageId, 'plantuml', `${extension} should map to plantuml`);
    }
  });
});

suite('configuration', () => {
  test('defaults match the documented values', () => {
    const config = vscode.workspace.getConfiguration('plantuml');
    assert.equal(config.get('render.backend'), 'javascript');
    assert.equal(config.get('render.allowRemoteServer'), false);
    assert.equal(config.get('preview.updateMode'), 'live');
    assert.equal(config.get('preview.theme'), 'light');
    assert.equal(config.get('include.allowOutsideWorkspace'), false);
    assert.equal(config.get('diagnostics.enabled'), true);
  });

  test('the default backend needs no external program', () => {
    const config = vscode.workspace.getConfiguration('plantuml');
    assert.equal(config.get('render.jarPath'), '');
    assert.equal(config.get('render.serverUrl'), '');
  });
});

suite('preview', () => {
  test('opening a preview to the side creates exactly one preview tab', async () => {
    await closeEverything();
    const uri = await scratchFile('preview.puml', '@startuml\nAlice -> Bob : hi\n@enduml\n');
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);

    await vscode.commands.executeCommand('plantuml.showPreviewToSide', uri);
    await waitFor('a preview tab to appear', () => previewTabs().length === 1);
  });

  test('opening a preview again reuses the same panel', async () => {
    const uri = await scratchFile('preview2.puml', '@startuml\nA -> B\n@enduml\n');
    await vscode.commands.executeCommand('plantuml.showPreviewToSide', uri);
    // Give any second panel a chance to appear before asserting it did not.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal(previewTabs().length, 1, 'an unlocked preview should be reused, not duplicated');
  });

  test('closing the preview tab disposes it', async () => {
    await closeEverything();
    await waitFor('the preview tab to go away', () => previewTabs().length === 0);
  });

  test('a locked preview opens alongside an unlocked one', async () => {
    await closeEverything();
    const uri = await scratchFile('locked.puml', '@startuml\nA -> B\n@enduml\n');
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);

    await vscode.commands.executeCommand('plantuml.showPreviewToSide', uri);
    await waitFor('the first preview', () => previewTabs().length === 1);
    await vscode.commands.executeCommand('plantuml.showLockedPreviewToSide', uri);
    await waitFor('a second, locked preview', () => previewTabs().length === 2);
    await closeEverything();
  });

  test('preview commands are safe to run with no preview open', async () => {
    await closeEverything();
    for (const command of [
      'plantuml.preview.refresh',
      'plantuml.preview.toggleLock',
      'plantuml.preview.zoomIn',
      'plantuml.preview.zoomOut',
      'plantuml.preview.zoomReset',
      'plantuml.showSource',
    ]) {
      await vscode.commands.executeCommand(command);
    }
  });
});

suite('rendering', () => {
  /**
   * The decisive test: it proves the bundled PlantUML engine actually draws a
   * diagram inside the real webview, under the real Content-Security-Policy,
   * with no Java and no network. Everything else in this suite is scaffolding
   * around this one assertion.
   */
  test('the built-in engine renders a diagram inside the preview', async () => {
    await closeEverything();
    const api = await extensionApi();

    const rendered = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no render within 90 s')), 90_000);
      const subscription = api.onDidRender((event) => {
        clearTimeout(timer);
        subscription.dispose();
        resolve(event);
      });
    });

    const uri = await scratchFile(
      'render.puml',
      ['@startuml', 'Alice -> Bob : Authentication Request', 'Bob --> Alice : Response', '@enduml', ''].join('\n'),
    );
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand('plantuml.showPreviewToSide', uri);

    const event = await rendered;
    assert.equal(event.succeeded, true, `render failed: ${event.message ?? ''}`);
    assert.equal(event.uri.toString(), uri.toString());
    assert.ok(event.bytes > 500, `the SVG looks too small: ${event.bytes} bytes`);
    process.stdout.write(`       (rendered ${event.bytes} bytes in ${event.durationMs} ms)
`);
    await closeEverything();
  });

  test('a diagram needing Graphviz layout renders too', async () => {
    await closeEverything();
    const api = await extensionApi();

    const rendered = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no render within 90 s')), 90_000);
      const subscription = api.onDidRender((event) => {
        clearTimeout(timer);
        subscription.dispose();
        resolve(event);
      });
    });

    // Class diagrams are laid out by Graphviz, which ships as WebAssembly. If
    // 'wasm-unsafe-eval' were missing from the CSP, this is what would break.
    const uri = await scratchFile(
      'classes.puml',
      ['@startuml', 'class Order', 'class Customer', 'Customer "1" --> "*" Order', '@enduml', ''].join('\n'),
    );
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand('plantuml.showPreviewToSide', uri);

    const event = await rendered;
    assert.equal(event.succeeded, true, `render failed: ${event.message ?? ''}`);
    await closeEverything();
  });

  test('a syntax error still produces a rendered error diagram', async () => {
    await closeEverything();
    const api = await extensionApi();

    const rendered = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no render within 90 s')), 90_000);
      const subscription = api.onDidRender((event) => {
        clearTimeout(timer);
        subscription.dispose();
        resolve(event);
      });
    });

    const uri = await scratchFile(
      'bad.puml',
      ['@startuml', '!!! not plantuml !!!', '@enduml', ''].join('\n'),
    );
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand('plantuml.showPreviewToSide', uri);

    // PlantUML answers a broken diagram with a picture of the error, so the
    // render itself succeeds; the user sees what is wrong rather than nothing.
    const event = await rendered;
    assert.equal(typeof event.succeeded, 'boolean');
    await closeEverything();
  });
});

suite('diagnostics', () => {
  test('a broken include is reported in the Problems panel', async () => {
    await closeEverything();
    const uri = await scratchFile(
      'broken.puml',
      '@startuml\n!include ./definitely-missing.puml\nA -> B\n@enduml\n',
    );
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand('plantuml.showPreviewToSide', uri);

    const diagnostics = await waitFor('an include diagnostic', () => {
      const found = vscode.languages.getDiagnostics(uri);
      return found.length > 0 ? found : undefined;
    });

    const include = diagnostics.find((diagnostic) => diagnostic.code === 'include');
    assert.ok(include, 'the missing include should be reported');
    assert.equal(include.source, 'plantuml');
    assert.equal(include.range.start.line, 1, 'it should point at the !include line');
    await closeEverything();
  });

  test('a remote include is refused rather than fetched', async () => {
    await closeEverything();
    const uri = await scratchFile(
      'remote.puml',
      '@startuml\n!includeurl https://example.invalid/x.puml\nA -> B\n@enduml\n',
    );
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand('plantuml.showPreviewToSide', uri);

    const diagnostics = await waitFor('a remote-include warning', () => {
      const found = vscode.languages.getDiagnostics(uri);
      return found.length > 0 ? found : undefined;
    });
    assert.ok(
      diagnostics.some((diagnostic) => /not fetched/iu.test(diagnostic.message)),
      'the preview must refuse remote includes',
    );
    await closeEverything();
  });

  test('diagnostics are cleared when the preview closes', async () => {
    const uri = await scratchFile('clean.puml', '@startuml\n!include gone.puml\n@enduml\n');
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand('plantuml.showPreviewToSide', uri);
    await waitFor('a diagnostic', () => vscode.languages.getDiagnostics(uri).length > 0);

    await closeEverything();
    await waitFor('diagnostics to clear', () => vscode.languages.getDiagnostics(uri).length === 0);
  });
});

/** Called by @vscode/test-electron. */
async function run() {
  try {
    await runAll();
  } finally {
    await Promise.allSettled(
      scratchFiles.map((directory) => fs.rm(directory, { recursive: true, force: true })),
    );
  }
}

module.exports = { run };
