/**
 * Owns every open preview.
 *
 * The rules it enforces are the ones that make previews feel predictable:
 *
 * - At most one *unlocked* preview per editor group. Opening a preview from a
 *   second file reuses that panel instead of stacking panels up.
 * - A locked preview is pinned to its document and is only reused for that
 *   same document.
 * - An unlocked preview follows the active PlantUML editor.
 * - Previews survive a window reload, through a `WebviewPanelSerializer`.
 */

import * as vscode from 'vscode';

import { DisposableStore, type IDisposable } from '../../shared/disposable.js';
import type { DiagnosticsManager } from '../diagnostics.js';
import type { Logger } from '../logger.js';
import type { RenderCoordinator } from '../render/renderCoordinator.js';
import { Preview, type PreviewDependencies, type PreviewState, type RenderEvent } from './preview.js';

/** File extensions the preview treats as PlantUML sources. */
const PLANTUML_LANGUAGE_ID = 'plantuml';

export interface OpenPreviewOptions {
  /** Open beside the current editor rather than replacing it. */
  readonly sideBySide: boolean;
  /** Pin the new preview to this document. */
  readonly locked: boolean;
}

export class PreviewManager implements IDisposable, vscode.WebviewPanelSerializer {
  private readonly store = new DisposableStore();
  private readonly previews = new Set<Preview>();
  private readonly deps: PreviewDependencies;

  private readonly onDidRenderEmitter = new vscode.EventEmitter<RenderEvent>();
  /** Fires for every render attempt in any preview. */
  readonly onDidRender = this.onDidRenderEmitter.event;

  constructor(
    extensionUri: vscode.Uri,
    logger: Logger,
    coordinator: RenderCoordinator,
    diagnostics: DiagnosticsManager,
  ) {
    this.deps = { extensionUri, logger, coordinator, diagnostics };

    this.store.add(this.onDidRenderEmitter);

    this.store.add(
      vscode.window.registerWebviewPanelSerializer(Preview.viewType, this),
    );

    this.store.add(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this.retargetUnlockedPreviews(editor);
      }),
    );
  }

  /** Opens or reuses a preview for `resource`. */
  open(resource: vscode.Uri, options: OpenPreviewOptions): Preview {
    const column = this.resolveColumn(options.sideBySide);

    const existing = [...this.previews].find((preview) =>
      preview.matches(resource, column, options.locked),
    );
    if (existing !== undefined) {
      existing.reveal(column);
      existing.retarget(resource);
      return existing;
    }

    const preview = Preview.create(this.deps, resource, column, options.locked);
    this.track(preview);
    return preview;
  }

  /**
   * The preview the user is currently looking at, if any.
   *
   * Used by the commands that only make sense against a focused preview
   * (refresh, lock, zoom).
   */
  get activePreview(): Preview | undefined {
    return [...this.previews].find((preview) => preview.isActive);
  }

  /** The preview showing `resource`, preferring the active one. */
  previewFor(resource: vscode.Uri): Preview | undefined {
    const candidates = [...this.previews].filter((preview) => preview.isPreviewOf(resource));
    return candidates.find((preview) => preview.isActive) ?? candidates[0];
  }

  async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
    const parsed = parsePreviewState(state);
    if (parsed === undefined) {
      // Nothing sensible to restore; dispose rather than show an empty shell.
      panel.dispose();
      return;
    }
    const preview = Preview.revive(this.deps, panel, parsed);
    this.track(preview);
    await Promise.resolve();
  }

  private track(preview: Preview): void {
    this.previews.add(preview);
    preview.onDidDispose(() => {
      this.previews.delete(preview);
    });
    preview.onDidChangeViewState(() => {
      this.disposeRedundant(preview);
    });
    preview.onDidRender((event) => {
      this.onDidRenderEmitter.fire(event);
    });
  }

  /**
   * Closes panels that have become duplicates.
   *
   * Two unlocked previews in the same editor group would fight over which
   * document they show, so the newest one wins and the other is closed.
   */
  private disposeRedundant(keep: Preview): void {
    const column = keep.column;
    if (column === undefined) {
      return;
    }
    for (const other of [...this.previews]) {
      if (other !== keep && other.matches(keep.uri, column, keep.isLocked)) {
        other.dispose();
      }
    }
  }

  private retargetUnlockedPreviews(editor: vscode.TextEditor | undefined): void {
    // Only real text editors have a view column; output panes and similar do
    // not, and retargeting to those would blank the preview.
    if (editor?.viewColumn === undefined) {
      return;
    }
    if (editor.document.languageId !== PLANTUML_LANGUAGE_ID) {
      return;
    }
    for (const preview of this.previews) {
      if (!preview.isLocked && !preview.isPreviewOf(editor.document.uri)) {
        preview.retarget(editor.document.uri);
      }
    }
  }

  private resolveColumn(sideBySide: boolean): vscode.ViewColumn {
    const active = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (!sideBySide) {
      return active;
    }
    // `ViewColumn.Beside` is resolved eagerly so that `matches()` can compare
    // concrete columns; comparing against the symbolic value never matches.
    const group = vscode.window.tabGroups.activeTabGroup.viewColumn;
    return (group + 1);
  }

  dispose(): void {
    for (const preview of [...this.previews]) {
      preview.dispose();
    }
    this.previews.clear();
    this.store.dispose();
  }
}

/**
 * Validates serialised preview state.
 *
 * Webview state survives a restart on disk and is therefore untrusted input by
 * the time it comes back: it is validated exactly like a message.
 */
function parsePreviewState(raw: unknown): PreviewState | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const resource = record['resource'];
  if (typeof resource !== 'string' || resource.length === 0 || resource.length > 4096) {
    return undefined;
  }
  try {
    vscode.Uri.parse(resource, true);
  } catch {
    return undefined;
  }
  const diagramIndex = record['diagramIndex'];
  return {
    resource,
    locked: record['locked'] === true,
    diagramIndex:
      typeof diagramIndex === 'number' && Number.isInteger(diagramIndex) && diagramIndex >= -1
        ? diagramIndex
        : -1,
  };
}
