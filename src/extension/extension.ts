/**
 * Extension entry point and composition root.
 *
 * Everything is constructed here and nowhere else: the modules below take their
 * collaborators as constructor arguments rather than reaching for globals, so
 * each of them can be exercised in isolation and the ownership of every
 * disposable is visible in one place.
 */

import * as vscode from 'vscode';

import { DisposableStore } from '../shared/disposable.js';
import { registerCommands } from './commands/index.js';
import { readConfiguration } from './config.js';
import { DiagnosticsManager } from './diagnostics.js';
import { OutputChannelLogger } from './logger.js';
import type { RenderEvent } from './preview/preview.js';
import { PreviewManager } from './preview/previewManager.js';
import { RenderCoordinator } from './render/renderCoordinator.js';

/**
 * The extension's public API, reachable through
 * `vscode.extensions.getExtension('local.plantuml-preview').exports`.
 *
 * Deliberately tiny. It exists so that a render can be *observed* rather than
 * inferred: the integration suite uses it to assert that a diagram genuinely
 * drew inside the webview, under the real Content-Security-Policy, instead of
 * merely checking that a panel appeared.
 */
export interface PlantUmlPreviewApi {
  /** Fires after every render attempt, successful or not. */
  readonly onDidRender: vscode.Event<RenderEvent>;
}

let store: DisposableStore | undefined;

export function activate(context: vscode.ExtensionContext): PlantUmlPreviewApi {
  const disposables = new DisposableStore();
  store = disposables;

  const logger = disposables.add(new OutputChannelLogger('PlantUML Preview'));
  const diagnostics = disposables.add(new DiagnosticsManager());
  const coordinator = new RenderCoordinator(logger);
  const manager = disposables.add(
    new PreviewManager(context.extensionUri, logger, coordinator, diagnostics),
  );

  disposables.add(registerCommands(manager, logger));

  const config = readConfiguration(undefined);
  logger.info(
    `PlantUML Preview activated. Backend: ${config.backend}. ` +
      `Workspace trusted: ${String(vscode.workspace.isTrusted)}.`,
  );
  if (!vscode.workspace.isTrusted && config.backend !== 'javascript') {
    logger.warn(
      'This workspace is not trusted, so the built-in JavaScript renderer is being used ' +
        'instead of the configured backend.',
    );
  }

  // Everything created above is released when the extension is deactivated or
  // reloaded; nothing outlives the context.
  context.subscriptions.push({
    dispose: () => {
      disposables.dispose();
    },
  });

  return { onDidRender: manager.onDidRender };
}

export function deactivate(): void {
  store?.dispose();
  store = undefined;
}
