/**
 * Command registration.
 *
 * Commands are thin: they resolve *which* document or preview the user meant,
 * then delegate. All the behaviour lives in `PreviewManager` and `Preview`, so
 * the same operation works identically from the palette, the editor toolbar,
 * the context menu and a keybinding.
 */

import * as path from 'node:path';

import * as vscode from 'vscode';

import { diagramLabel, parseDiagrams } from '../../shared/diagram.js';
import { DisposableStore, type IDisposable } from '../../shared/disposable.js';
import { readConfiguration, type ExportFormat } from '../config.js';
import { describeError, type Logger } from '../logger.js';
import type { Preview } from '../preview/preview.js';
import type { PreviewManager } from '../preview/previewManager.js';

export function registerCommands(
  manager: PreviewManager,
  logger: Logger,
): IDisposable {
  const store = new DisposableStore();
  const register = (id: string, handler: (...args: never[]) => unknown): void => {
    store.add(
      vscode.commands.registerCommand(id, async (...args: never[]) => {
        try {
          await handler(...args);
        } catch (error) {
          const message = describeError(error);
          logger.error(`Command ${id} failed`, error);
          void vscode.window.showErrorMessage(`PlantUML: ${message}`);
        }
      }),
    );
  };

  register('plantuml.showPreview', (uri?: vscode.Uri) => {
    openPreview(manager, uri, { sideBySide: false, locked: false });
  });

  register('plantuml.showPreviewToSide', (uri?: vscode.Uri) => {
    openPreview(manager, uri, { sideBySide: true, locked: false });
  });

  register('plantuml.showLockedPreviewToSide', (uri?: vscode.Uri) => {
    openPreview(manager, uri, { sideBySide: true, locked: true });
  });

  register('plantuml.showSource', async () => {
    const preview = manager.activePreview;
    if (preview === undefined) {
      return;
    }
    const document = await vscode.workspace.openTextDocument(preview.uri);
    await vscode.window.showTextDocument(document, vscode.ViewColumn.One, false);
  });

  register('plantuml.preview.refresh', () => {
    const preview = manager.activePreview ?? previewForActiveEditor(manager);
    preview?.refresh();
  });

  register('plantuml.preview.toggleLock', () => {
    manager.activePreview?.toggleLock();
  });

  register('plantuml.preview.zoomIn', () => {
    manager.activePreview?.postViewCommand('zoomIn');
  });

  register('plantuml.preview.zoomOut', () => {
    manager.activePreview?.postViewCommand('zoomOut');
  });

  register('plantuml.preview.zoomReset', () => {
    manager.activePreview?.postViewCommand('zoomReset');
  });

  register('plantuml.preview.selectDiagram', async () => {
    await selectDiagram(manager);
  });

  register('plantuml.preview.copyImage', async () => {
    await copyImage(manager);
  });

  register('plantuml.export', async (uri?: vscode.Uri) => {
    await exportDiagram(manager, uri, logger);
  });

  register('plantuml.showDiagnostics', () => {
    logger.show();
  });

  return store;
}

function openPreview(
  manager: PreviewManager,
  uri: vscode.Uri | undefined,
  options: { sideBySide: boolean; locked: boolean },
): void {
  const resource = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (resource === undefined) {
    void vscode.window.showInformationMessage('Open a PlantUML file to preview it.');
    return;
  }
  manager.open(resource, options);
}

function previewForActiveEditor(manager: PreviewManager): Preview | undefined {
  const uri = vscode.window.activeTextEditor?.document.uri;
  return uri === undefined ? undefined : manager.previewFor(uri);
}

/**
 * Lets the user pick which diagram of a multi-diagram file to pin.
 *
 * "Follow the cursor" is offered first because it is the default and the most
 * useful mode; pinning is for when you want the preview to stay put while you
 * edit elsewhere in the file.
 */
async function selectDiagram(manager: PreviewManager): Promise<void> {
  const preview = manager.activePreview ?? previewForActiveEditor(manager);
  if (preview === undefined) {
    void vscode.window.showInformationMessage('Open a PlantUML preview first.');
    return;
  }

  const document = await vscode.workspace.openTextDocument(preview.uri);
  const blocks = parseDiagrams(document.getText());
  if (blocks.length === 0) {
    void vscode.window.showInformationMessage('This file contains no diagrams.');
    return;
  }

  const fallback = path.parse(preview.uri.fsPath).name;
  const items: (vscode.QuickPickItem & { index: number | undefined })[] = [
    {
      label: '$(list-selection) Follow the cursor',
      description: 'Show whichever diagram the caret is inside',
      index: undefined,
    },
    ...blocks.map((block) => ({
      label: `$(symbol-class) ${diagramLabel(block, fallback)}`,
      description: `line ${block.startLine + 1}`,
      ...(block.unterminated ? { detail: 'This block is missing its @end delimiter' } : {}),
      index: block.index,
    })),
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Select the diagram to preview',
    placeHolder: `${blocks.length} diagram${blocks.length === 1 ? '' : 's'} in this file`,
  });
  if (picked !== undefined) {
    preview.selectDiagram(picked.index);
  }
}

async function copyImage(manager: PreviewManager): Promise<void> {
  const preview = manager.activePreview;
  if (preview === undefined) {
    void vscode.window.showInformationMessage('Open a PlantUML preview first.');
    return;
  }
  const bytes = await preview.requestExport('svg', 1);
  await vscode.env.clipboard.writeText(bytes.toString('utf8'));
  void vscode.window.showInformationMessage('The diagram SVG was copied to the clipboard.');
}

/**
 * Writes the current diagram to a file.
 *
 * Rendering happens in the webview, so a preview must exist. When one does not,
 * it is opened first — which is almost always what the user wanted anyway.
 */
async function exportDiagram(
  manager: PreviewManager,
  uri: vscode.Uri | undefined,
  logger: Logger,
): Promise<void> {
  const resource = uri ?? manager.activePreview?.uri ?? vscode.window.activeTextEditor?.document.uri;
  if (resource === undefined) {
    void vscode.window.showInformationMessage('Open a PlantUML file to export it.');
    return;
  }

  const config = readConfiguration(resource);
  const preview = manager.previewFor(resource) ?? manager.open(resource, {
    sideBySide: true,
    locked: false,
  });

  const format = await pickFormat(config.exportFormat);
  if (format === undefined) {
    return;
  }

  const target = await pickTarget(resource, format, config.exportDirectory);
  if (target === undefined) {
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Exporting the diagram…' },
    async () => {
      const bytes = await preview.requestExport(format, config.exportPngScale);
      await vscode.workspace.fs.writeFile(target, new Uint8Array(bytes));
      logger.info(`Exported ${resource.fsPath} to ${target.fsPath}`);
    },
  );

  const open = await vscode.window.showInformationMessage(
    `Saved ${path.basename(target.fsPath)}.`,
    'Show in Folder',
  );
  if (open === 'Show in Folder') {
    await vscode.commands.executeCommand('revealFileInOS', target);
  }
}

async function pickFormat(preferred: ExportFormat): Promise<ExportFormat | undefined> {
  const items: (vscode.QuickPickItem & { format: ExportFormat })[] = [
    { label: 'SVG', description: 'Vector, scales without loss', format: 'svg' },
    { label: 'PNG', description: 'Raster, for slides and documents', format: 'png' },
  ];
  // Put the configured default first so Enter does the expected thing.
  items.sort((a, b) => (a.format === preferred ? -1 : b.format === preferred ? 1 : 0));

  const picked = await vscode.window.showQuickPick(items, { title: 'Export format' });
  return picked?.format;
}

/**
 * Chooses the output path.
 *
 * A configured export directory is honoured without prompting; otherwise the
 * standard save dialog is shown, defaulting next to the source file.
 */
async function pickTarget(
  resource: vscode.Uri,
  format: ExportFormat,
  configuredDirectory: string,
): Promise<vscode.Uri | undefined> {
  const parsed = path.parse(resource.fsPath);
  const fileName = `${parsed.name}.${format}`;

  if (configuredDirectory.length > 0) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(resource);
    const base = path.isAbsolute(configuredDirectory)
      ? configuredDirectory
      : path.join(workspaceFolder?.uri.fsPath ?? parsed.dir, configuredDirectory);
    const target = vscode.Uri.file(path.join(base, fileName));
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(base));
    return target;
  }

  return await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(parsed.dir, fileName)),
    filters: format === 'svg' ? { 'SVG image': ['svg'] } : { 'PNG image': ['png'] },
    title: 'Export diagram',
  });
}
