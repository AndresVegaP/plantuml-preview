/**
 * One preview panel.
 *
 * The lifecycle mirrors VS Code's own Markdown preview closely enough to feel
 * native: a preview is anchored to a *URI* rather than to an open editor, so
 * closing the source tab does not break it; an unlocked preview retargets
 * itself as the user moves between diagram files; and a locked one stays put.
 *
 * Everything the panel owns — event subscriptions, timers, file watchers — is
 * registered on a single {@link DisposableStore}, so disposing the panel
 * releases all of it.
 */

import * as vscode from 'vscode';

import { Debouncer, LatestOnlyQueue } from '../../shared/async.js';
import { diagramAtLine, parseDiagrams, type DiagramBlock } from '../../shared/diagram.js';
import { DisposableStore, type IDisposable } from '../../shared/disposable.js';
import { parseWebviewMessage, type HostMessage } from '../../shared/protocol.js';
import { readConfiguration, type PlantUmlConfiguration } from '../config.js';
import type { DiagnosticsManager } from '../diagnostics.js';
import { describeError, type Logger } from '../logger.js';
import { parseErrorImage } from '../render/errorParser.js';
import type { RenderCoordinator } from '../render/renderCoordinator.js';
import type { RenderFailure } from '../render/renderer.js';
import { renderWebviewHtml, type WebviewResources } from './webviewHtml.js';

/** Serialised across a window reload. */
export interface PreviewState {
  readonly resource: string;
  readonly locked: boolean;
  /** Pinned diagram index, or -1 when the preview follows the cursor. */
  readonly diagramIndex: number;
}

export interface PreviewDependencies {
  readonly extensionUri: vscode.Uri;
  readonly logger: Logger;
  readonly coordinator: RenderCoordinator;
  readonly diagnostics: DiagnosticsManager;
}

/**
 * What happened to one render attempt.
 *
 * Surfaced through the extension's public API so that a test — or another
 * extension — can observe that a diagram actually drew, rather than inferring
 * it from a panel existing.
 */
export interface RenderEvent {
  readonly uri: vscode.Uri;
  /**
   * False when the diagram could not be drawn, and also when PlantUML drew its
   * error report in place of the diagram: the preview shows that picture, but
   * the source has a problem.
   */
  readonly succeeded: boolean;
  /** Present whenever the preview received an image, error report included. */
  readonly durationMs?: number;
  /** Size of the sanitised SVG, present whenever the preview received an image. */
  readonly bytes?: number;
  /** Present on failure. */
  readonly message?: string;
}

/** How long an export may take before the request is abandoned. */
const EXPORT_TIMEOUT_MS = 60_000;

export class Preview implements IDisposable {
  static readonly viewType = 'plantuml.preview';

  private readonly store = new DisposableStore();
  private readonly renderQueue = new LatestOnlyQueue();
  private debouncer: Debouncer;

  private resource: vscode.Uri;
  private locked: boolean;
  private pinnedIndex: number | undefined;
  private disposed = false;

  /** Increments per render request; replies with an older token are ignored. */
  private token = 0;
  /** Requests issued before the webview reported ready, replayed on ready. */
  private pendingInitialUpdate = false;

  private includeWatcher: vscode.FileSystemWatcher | undefined;
  private readonly exportWaiters = new Map<
    number,
    { resolve: (value: Buffer) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();

  private readonly onDidDisposeEmitter = new vscode.EventEmitter<void>();
  readonly onDidDispose = this.onDidDisposeEmitter.event;

  private readonly onDidChangeViewStateEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeViewState = this.onDidChangeViewStateEmitter.event;

  private readonly onDidRenderEmitter = new vscode.EventEmitter<RenderEvent>();
  /** Fires when a diagram has been drawn, or when drawing it failed. */
  readonly onDidRender = this.onDidRenderEmitter.event;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly deps: PreviewDependencies,
    resource: vscode.Uri,
    locked: boolean,
    pinnedIndex: number | undefined,
  ) {
    this.resource = resource;
    this.locked = locked;
    this.pinnedIndex = pinnedIndex;
    this.debouncer = new Debouncer(this.config().debounceMs);
    this.store.add(this.debouncer);
    this.store.add(this.onDidDisposeEmitter);
    this.store.add(this.onDidChangeViewStateEmitter);
    this.store.add(this.onDidRenderEmitter);

    this.configureWebview();
    this.registerListeners();
    this.updateTitle();
    this.panel.webview.html = this.buildHtml();
    this.pendingInitialUpdate = true;
  }

  static create(
    deps: PreviewDependencies,
    resource: vscode.Uri,
    column: vscode.ViewColumn,
    locked: boolean,
  ): Preview {
    const panel = vscode.window.createWebviewPanel(
      Preview.viewType,
      'PlantUML Preview',
      { viewColumn: column, preserveFocus: true },
      {
        enableFindWidget: false,
        // The PlantUML engine takes a moment to boot and is several megabytes
        // of WebAssembly and generated JavaScript. Rebuilding that every time
        // the tab loses visibility would make tab switching feel broken, so the
        // context is kept alive at the cost of memory while the panel exists.
        retainContextWhenHidden: true,
      },
    );
    return new Preview(panel, deps, resource, locked, undefined);
  }

  static revive(
    deps: PreviewDependencies,
    panel: vscode.WebviewPanel,
    state: PreviewState,
  ): Preview {
    return new Preview(
      panel,
      deps,
      vscode.Uri.parse(state.resource),
      state.locked,
      state.diagramIndex >= 0 ? state.diagramIndex : undefined,
    );
  }

  // -------------------------------------------------------------------------
  // Identity
  // -------------------------------------------------------------------------

  get uri(): vscode.Uri {
    return this.resource;
  }

  get isLocked(): boolean {
    return this.locked;
  }

  get column(): vscode.ViewColumn | undefined {
    return this.panel.viewColumn;
  }

  get isActive(): boolean {
    return this.panel.active;
  }

  isPreviewOf(resource: vscode.Uri): boolean {
    return this.resource.toString() === resource.toString();
  }

  /**
   * Decides whether this preview can serve a new request.
   *
   * A locked preview only answers for its own document; an unlocked one answers
   * for anything, because it will simply retarget.
   */
  matches(resource: vscode.Uri, column: vscode.ViewColumn, locked: boolean): boolean {
    if (this.panel.viewColumn !== column) {
      return false;
    }
    return this.locked ? locked && this.isPreviewOf(resource) : !locked;
  }

  reveal(column: vscode.ViewColumn): void {
    this.panel.reveal(column, true);
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  /** Points an unlocked preview at a different document. */
  retarget(resource: vscode.Uri): void {
    if (this.locked || this.isPreviewOf(resource)) {
      return;
    }
    this.resource = resource;
    this.pinnedIndex = undefined;
    this.updateTitle();
    this.scheduleUpdate(true);
  }

  toggleLock(): void {
    this.locked = !this.locked;
    this.updateTitle();
  }

  refresh(): void {
    this.scheduleUpdate(true);
  }

  /** Pins the preview to one diagram of a multi-diagram file. */
  selectDiagram(index: number | undefined): void {
    this.pinnedIndex = index;
    this.updateTitle();
    this.scheduleUpdate(true);
  }

  postViewCommand(command: 'zoomIn' | 'zoomOut' | 'zoomReset' | 'fitWidth' | 'copyImage'): void {
    this.post({ type: 'command', command });
  }

  /**
   * Asks the webview for the current diagram as file bytes.
   *
   * Rasterising needs a canvas, which only exists in the webview, so export is
   * a request/response over the message channel rather than a host computation.
   */
  requestExport(format: 'svg' | 'png', scale: number): Promise<Buffer> {
    const token = ++this.token;
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.exportWaiters.delete(token);
        reject(new Error('The preview did not produce an image in time.'));
      }, EXPORT_TIMEOUT_MS);
      this.exportWaiters.set(token, { resolve, reject, timer });
      this.post({ type: 'exportRequest', token, format, scale });
    });
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  private configureWebview(): void {
    this.panel.webview.options = {
      enableScripts: true,
      enableForms: false,
      enableCommandUris: false,
      // The webview may load nothing but files the extension itself ships.
      localResourceRoots: [vscode.Uri.joinPath(this.deps.extensionUri, 'media')],
    };
  }

  private registerListeners(): void {
    this.store.add(
      this.panel.onDidDispose(() => {
        this.dispose();
      }),
    );

    this.store.add(
      this.panel.webview.onDidReceiveMessage((raw: unknown) => {
        this.handleWebviewMessage(raw);
      }),
    );

    this.store.add(
      this.panel.onDidChangeViewState(() => {
        this.onDidChangeViewStateEmitter.fire();
      }),
    );

    this.store.add(
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (!this.isPreviewOf(event.document.uri) || event.contentChanges.length === 0) {
          return;
        }
        if (this.config().updateMode === 'live') {
          this.scheduleUpdate(false);
        }
      }),
    );

    this.store.add(
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (this.isPreviewOf(document.uri) && this.config().updateMode !== 'manual') {
          this.scheduleUpdate(true);
        }
      }),
    );

    this.store.add(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration('plantuml')) {
          return;
        }
        // The debounce interval is baked into the timer, so rebuild it.
        this.debouncer.dispose();
        this.store.delete(this.debouncer);
        this.debouncer = new Debouncer(this.config().debounceMs);
        this.store.add(this.debouncer);
        this.pushConfiguration();
        this.scheduleUpdate(true);
      }),
    );

    this.store.add(
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (
          this.pinnedIndex !== undefined ||
          !this.isPreviewOf(event.textEditor.document.uri) ||
          !this.config().scrollPreviewWithEditor
        ) {
          return;
        }
        this.scheduleUpdate(false);
      }),
    );

    this.store.add(
      vscode.window.onDidChangeActiveColorTheme(() => {
        if (this.config().theme === 'auto') {
          this.pushConfiguration();
          this.scheduleUpdate(true);
        }
      }),
    );
  }

  private handleWebviewMessage(raw: unknown): void {
    const message = parseWebviewMessage(raw);
    if (message === undefined) {
      this.deps.logger.warn('Dropped a malformed message from the preview webview.');
      return;
    }

    switch (message.type) {
      case 'ready':
        if (message.engineAvailable) {
          this.deps.logger.info('The built-in PlantUML engine is ready.');
        } else if (message.engineError !== undefined) {
          this.deps.logger.error(`The built-in PlantUML engine failed to load: ${message.engineError}`);
        }
        this.pushConfiguration();
        if (this.pendingInitialUpdate) {
          this.pendingInitialUpdate = false;
          this.scheduleUpdate(true);
        }
        break;

      case 'rendered': {
        if (message.token !== this.token) {
          return;
        }
        this.deps.logger.trace(
          `Rendered ${this.resource.fsPath} in ${message.durationMs} ms (${message.svg.length} bytes).`,
        );
        if (message.removals.length > 0) {
          this.deps.logger.warn(
            `The sanitiser removed constructs from the rendered diagram: ${message.removals.join(', ')}.`,
          );
        }
        // PlantUML answers a broken diagram with a valid SVG that draws the
        // error, so the webview cannot tell it from a diagram. The picture stays
        // on screen, because it shows the user what is wrong, but the failure is
        // reported like any other: in the API and in the Problems panel.
        const imageError = parseErrorImage(message.svg);
        const failure: RenderFailure | undefined =
          imageError === undefined
            ? undefined
            : {
                message: imageError.message,
                ...(imageError.line === undefined ? {} : { sourceLine: imageError.line }),
              };
        this.onDidRenderEmitter.fire({
          uri: this.resource,
          succeeded: failure === undefined,
          durationMs: message.durationMs,
          bytes: message.svg.length,
          ...(failure === undefined ? {} : { message: failure.message }),
        });
        void this.publishDiagnostics(failure);
        break;
      }

      case 'renderFailed':
        if (message.token !== this.token) {
          return;
        }
        this.deps.logger.warn(`Render failed: ${message.message}`);
        this.onDidRenderEmitter.fire({
          uri: this.resource,
          succeeded: false,
          message: message.message,
        });
        void this.publishDiagnostics({ message: message.message });
        break;

      case 'revealSource':
        void this.revealSource(message.line);
        break;

      case 'exportResult': {
        const waiter = this.exportWaiters.get(message.token);
        if (waiter === undefined) {
          return;
        }
        this.exportWaiters.delete(message.token);
        clearTimeout(waiter.timer);
        waiter.resolve(Buffer.from(message.base64, 'base64'));
        break;
      }

      case 'exportFailed': {
        const waiter = this.exportWaiters.get(message.token);
        if (waiter === undefined) {
          return;
        }
        this.exportWaiters.delete(message.token);
        clearTimeout(waiter.timer);
        waiter.reject(new Error(message.message));
        break;
      }

      case 'log':
        if (message.level === 'error') {
          this.deps.logger.error(`[preview] ${message.message}`);
        } else if (message.level === 'warn') {
          this.deps.logger.warn(`[preview] ${message.message}`);
        } else {
          this.deps.logger.trace(`[preview] ${message.message}`);
        }
        break;

      case 'zoomChanged':
        break;

      default:
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private scheduleUpdate(immediate: boolean): void {
    if (this.disposed) {
      return;
    }
    if (immediate) {
      this.debouncer.cancel();
      void this.renderQueue.run(async () => {
        await this.update();
      });
      return;
    }
    this.debouncer.schedule(() => {
      void this.renderQueue.run(async () => {
        await this.update();
      });
    });
  }

  private async update(): Promise<void> {
    if (this.disposed) {
      return;
    }

    const document = await this.openDocument();
    if (document === undefined) {
      this.post({
        type: 'setError',
        token: ++this.token,
        message: 'The source file could not be opened.',
        detail: this.resource.fsPath,
      });
      return;
    }

    const config = this.config();
    const blocks = parseDiagrams(document.getText());
    const first = blocks[0];
    if (first === undefined) {
      this.post({
        type: 'setError',
        token: ++this.token,
        message: 'There is no diagram in this file yet.',
        detail: 'Add a block that starts with @startuml and ends with @enduml.',
      });
      this.deps.diagnostics.clear(document.uri);
      return;
    }

    const block = this.pickBlock(blocks, first, config);
    const token = ++this.token;
    this.post({ type: 'setBusy', token });

    const prepared = await this.deps.coordinator.prepare(document, block, config);
    this.lastPrepared = prepared;
    this.watchIncludes(prepared.includedFiles);
    this.updateTitle(block, blocks.length);

    if (config.backend === 'javascript') {
      // The webview renders; diagnostics are published when it answers.
      this.post({
        type: 'render',
        token,
        lines: prepared.text.split(/\r\n|\r|\n/u),
        theme: this.effectiveTheme(config),
      });
      await this.publishDiagnostics(undefined, prepared);
      return;
    }

    const renderer = this.deps.coordinator.createHostRenderer(document, config);
    if (!renderer.ok) {
      this.post({ type: 'setError', token, message: renderer.error.message });
      await this.publishDiagnostics(renderer.error, prepared);
      return;
    }
    if (renderer.value === undefined) {
      this.post({ type: 'setError', token, message: 'No renderer is configured.' });
      return;
    }

    const outcome = await this.deps.coordinator.render(renderer.value, prepared.text, config);
    if (token !== this.token) {
      // Superseded while the backend was working.
      return;
    }

    if (outcome.ok) {
      this.post({ type: 'setContent', token, svg: outcome.value.svg });
      this.deps.logger.trace(
        `Rendered ${this.resource.fsPath} via ${renderer.value.id} in ${outcome.value.durationMs} ms.`,
      );
      await this.publishDiagnostics(undefined, prepared);
    } else {
      this.onDidRenderEmitter.fire({
        uri: this.resource,
        succeeded: false,
        message: outcome.error.message,
      });
      this.post({
        type: 'setError',
        token,
        message: outcome.error.message,
        ...(outcome.error.detail === undefined ? {} : { detail: outcome.error.detail }),
      });
      await this.publishDiagnostics(outcome.error, prepared);
    }
  }

  /**
   * Source prepared for the most recent render, whichever backend drew it.
   *
   * The webview acknowledges host-rendered images too, so its reply publishes
   * diagnostics through this, and double-click-to-source maps a shape's line
   * back to the document through it.
   */
  private lastPrepared: Awaited<ReturnType<RenderCoordinator['prepare']>> | undefined;

  /**
   * Chooses which diagram of the file to show.
   *
   * An explicit pin wins. Otherwise the cursor decides, which makes a file of
   * many diagrams behave like a document: move the caret, see that diagram.
   */
  private pickBlock(
    blocks: readonly DiagramBlock[],
    fallback: DiagramBlock,
    config: PlantUmlConfiguration,
  ): DiagramBlock {
    if (this.pinnedIndex !== undefined) {
      return blocks[Math.min(this.pinnedIndex, blocks.length - 1)] ?? fallback;
    }

    if (config.scrollPreviewWithEditor) {
      const editor = vscode.window.visibleTextEditors.find((candidate) =>
        this.isPreviewOf(candidate.document.uri),
      );
      if (editor !== undefined) {
        const found = diagramAtLine(blocks, editor.selection.active.line);
        if (found !== undefined) {
          return found;
        }
      }
    }

    return fallback;
  }

  private async publishDiagnostics(
    failure: RenderFailure | undefined,
    prepared = this.lastPrepared,
  ): Promise<void> {
    const document = await this.openDocument();
    if (document === undefined || prepared === undefined) {
      return;
    }
    this.deps.diagnostics.publish(
      document,
      prepared.includeProblems,
      failure,
      (line) => prepared.toDocumentLine(line),
      this.config().diagnosticsEnabled,
    );
  }

  /**
   * Watches the files pulled in by `!include`.
   *
   * Without this, editing a shared `!include`d stylesheet would leave every
   * preview that depends on it showing stale output.
   */
  private watchIncludes(files: readonly string[]): void {
    this.includeWatcher?.dispose();
    this.includeWatcher = undefined;
    if (files.length === 0) {
      return;
    }

    // One watcher over every PlantUML file is much cheaper than one watcher per
    // included file, and the callback re-checks that the change is relevant.
    const watched = new Set(
      files.map((file) => vscode.Uri.file(file).fsPath.toLowerCase()),
    );
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{puml,plantuml,pu,iuml,wsd,pml}');
    const onChange = (uri: vscode.Uri): void => {
      if (watched.has(uri.fsPath.toLowerCase())) {
        this.scheduleUpdate(true);
      }
    };
    watcher.onDidChange(onChange);
    watcher.onDidCreate(onChange);
    watcher.onDidDelete(onChange);
    this.includeWatcher = watcher;
    this.store.add(watcher);
  }

  // -------------------------------------------------------------------------
  // Presentation
  // -------------------------------------------------------------------------

  private buildHtml(): string {
    const config = this.config();
    const media = vscode.Uri.joinPath(this.deps.extensionUri, 'media');
    const resources: WebviewResources = {
      styleUri: this.panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'preview.css')),
      scriptUri: this.panel.webview.asWebviewUri(
        vscode.Uri.joinPath(media, 'dist', 'webview', 'main.js'),
      ),
      engineScriptUri: this.panel.webview.asWebviewUri(
        vscode.Uri.joinPath(media, 'engine', 'viz-global.js'),
      ),
      engineModuleUri: this.panel.webview.asWebviewUri(
        vscode.Uri.joinPath(media, 'engine', 'plantuml.js'),
      ),
    };

    return renderWebviewHtml(this.panel.webview, resources, {
      engineModuleUri: resources.engineModuleUri.toString(),
      useBuiltInEngine: config.backend === 'javascript',
      theme: this.effectiveTheme(config),
      zoomStep: config.zoomStep,
      doubleClickToSource: config.doubleClickToSource,
      initialStatus: '',
    });
  }

  private pushConfiguration(): void {
    const config = this.config();
    this.post({
      type: 'configure',
      theme: this.effectiveTheme(config),
      zoomStep: config.zoomStep,
      doubleClickToSource: config.doubleClickToSource,
      statusText: this.statusText(config),
    });
  }

  private statusText(config: PlantUmlConfiguration): string {
    const backend =
      config.backend === 'javascript'
        ? 'built-in engine'
        : config.backend === 'jar'
          ? 'local plantuml.jar'
          : 'PlantUML server';
    return `${backend} · ${config.updateMode}`;
  }

  private effectiveTheme(config: PlantUmlConfiguration): 'light' | 'dark' {
    if (config.theme !== 'auto') {
      return config.theme;
    }
    const kind = vscode.window.activeColorTheme.kind;
    return kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast
      ? 'dark'
      : 'light';
  }

  private updateTitle(block?: DiagramBlock, total?: number): void {
    const name = basename(this.resource);
    const suffix =
      block !== undefined && total !== undefined && total > 1
        ? ` (${block.index + 1}/${total})`
        : '';
    this.panel.title = this.locked
      ? `[Preview] ${name}${suffix}`
      : `Preview ${name}${suffix}`;
  }

  /**
   * Brings the source editor forward, placing the caret on the line that
   * produced the shape the user double-clicked when the renderer told us which
   * one that was.
   */
  private async revealSource(renderedLine?: number): Promise<void> {
    const document = await this.openDocument();
    if (document === undefined) {
      return;
    }

    // Prefer an editor that already shows this document, so the click does not
    // move the file into a different group.
    const existing = vscode.window.visibleTextEditors.find((candidate) =>
      this.isPreviewOf(candidate.document.uri),
    );
    const column =
      existing?.viewColumn ??
      (this.panel.viewColumn === vscode.ViewColumn.One
        ? vscode.ViewColumn.Two
        : vscode.ViewColumn.One);

    const editor = await vscode.window.showTextDocument(document, column, false);

    const documentLine =
      renderedLine === undefined ? undefined : this.lastPrepared?.toDocumentLine(renderedLine);
    if (documentLine === undefined) {
      return;
    }

    const line = Math.min(Math.max(0, documentLine), Math.max(0, document.lineCount - 1));
    const position = new vscode.Position(line, document.lineAt(line).firstNonWhitespaceCharacterIndex);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(
      new vscode.Range(position, position),
      vscode.TextEditorRevealType.InCenterIfOutsideViewport,
    );
  }

  private async openDocument(): Promise<vscode.TextDocument | undefined> {
    try {
      return await vscode.workspace.openTextDocument(this.resource);
    } catch (error) {
      this.deps.logger.warn(`Could not open ${this.resource.toString()}: ${describeError(error)}`);
      return undefined;
    }
  }

  private post(message: HostMessage): void {
    if (this.disposed) {
      return;
    }
    // `postMessage` resolves to false when the webview is not listening; that is
    // normal during startup and disposal and is not worth reporting.
    void this.panel.webview.postMessage(message);
  }

  private config(): PlantUmlConfiguration {
    return readConfiguration(this.resource);
  }

  /** Snapshot for the webview panel serializer. */
  get state(): PreviewState {
    return {
      resource: this.resource.toString(),
      locked: this.locked,
      diagramIndex: this.pinnedIndex ?? -1,
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    for (const waiter of this.exportWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('The preview was closed.'));
    }
    this.exportWaiters.clear();

    this.deps.diagnostics.clear(this.resource);
    this.onDidDisposeEmitter.fire();
    this.store.dispose();
    this.panel.dispose();
  }
}

function basename(uri: vscode.Uri): string {
  const parts = uri.path.split('/');
  return parts[parts.length - 1] ?? uri.toString();
}

