/**
 * The preview webview.
 *
 * Runs inside VS Code's sandboxed iframe under the strict CSP built by
 * `webviewHtml.ts`. Its jobs are, in order of importance:
 *
 * 1. **Sanitise before display.** Every SVG — whether produced here by the
 *    built-in engine or handed over by a host-side backend — goes through
 *    {@link sanitiseSvg} before it touches the DOM.
 * 2. Render, when the built-in JavaScript engine is the configured backend.
 * 3. Present: zoom, pan, fit, and the loading and error states.
 * 4. Produce export bytes, since only this side has a canvas.
 */

import type { HostMessage, WebviewMessage } from '../shared/protocol.js';
import { sanitiseSvg } from '../shared/svgSanitizer.js';
import { PlantUmlEngine } from './engine.js';
import { Viewer } from './viewer.js';

/** The API VS Code injects into every webview. */
interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

interface Bootstrap {
  readonly engineModuleUri: string;
  readonly useBuiltInEngine: boolean;
  readonly theme: 'light' | 'dark';
  readonly zoomStep: number;
  readonly doubleClickToSource: boolean;
  readonly initialStatus: string;
}

interface PersistedState {
  readonly svg?: string;
  readonly status?: string;
}

const vscode = acquireVsCodeApi();

const elements = {
  body: document.body,
  viewport: requireElement('viewport'),
  canvas: requireElement('canvas'),
  overlay: requireElement('overlay'),
  overlayTitle: requireElement('overlay-title'),
  overlayDetail: requireElement('overlay-detail'),
  status: requireElement('status'),
  zoomLevel: requireElement('zoom-level'),
  zoomIn: requireElement('zoom-in'),
  zoomOut: requireElement('zoom-out'),
  fitWidth: requireElement('fit-width'),
};

const bootstrap = readBootstrap();

let doubleClickToSource = bootstrap.doubleClickToSource;
let theme = bootstrap.theme;
/** The most recent sanitised SVG, kept for export and for reload restore. */
let currentSvg: string | undefined;
/** Token of the newest request; replies carrying an older token are ignored. */
let latestToken = -1;
let engine: PlantUmlEngine | undefined;
let engineLoad: Promise<PlantUmlEngine> | undefined;

const viewer = new Viewer(elements.viewport, elements.canvas, {
  zoomStep: bootstrap.zoomStep,
  onZoomChanged: (zoom) => {
    elements.zoomLevel.textContent = `${Math.round(zoom * 100)}%`;
    vscode.postMessage({ type: 'zoomChanged', zoom });
  },
  onActivateSource: (target) => {
    if (!doubleClickToSource) {
      return;
    }
    const line = sourceLineOf(target);
    vscode.postMessage(
      line === undefined ? { type: 'revealSource' } : { type: 'revealSource', line },
    );
  },
});

elements.zoomIn.addEventListener('click', () => { viewer.zoomIn(); });
elements.zoomOut.addEventListener('click', () => { viewer.zoomOut(); });
elements.zoomLevel.addEventListener('click', () => { viewer.resetZoom(); });
elements.fitWidth.addEventListener('click', () => { refit(); });

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  const message = event.data as HostMessage | undefined;
  if (message === undefined || typeof message !== 'object' || !('type' in message)) {
    return;
  }
  void handleHostMessage(message);
});

restorePreviousState();
setStatus(bootstrap.initialStatus);
void start();

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function start(): Promise<void> {
  if (!bootstrap.useBuiltInEngine) {
    // A host-side backend is in charge; nothing to load here.
    setOverlay(undefined);
    vscode.postMessage({ type: 'ready', engineAvailable: false });
    return;
  }

  try {
    engine = await loadEngine();
    setOverlay(undefined);
    vscode.postMessage({ type: 'ready', engineAvailable: true });
  } catch (error) {
    const message = describe(error);
    setOverlay(
      'The PlantUML engine could not be loaded.',
      `${message}\n\nThe extension package may be incomplete. Re-run "npm run vendor" and repackage it.`,
    );
    vscode.postMessage({ type: 'ready', engineAvailable: false, engineError: message });
  }
}

function loadEngine(): Promise<PlantUmlEngine> {
  engineLoad ??= PlantUmlEngine.load(bootstrap.engineModuleUri);
  return engineLoad;
}

async function handleHostMessage(message: HostMessage): Promise<void> {
  switch (message.type) {
    case 'render':
      latestToken = message.token;
      await renderLocally(message.token, message.lines.join('\n'), message.theme);
      break;

    case 'setContent':
      latestToken = message.token;
      applySvg(message.token, message.svg, 0);
      break;

    case 'setError':
      latestToken = message.token;
      setOverlay(message.message, message.detail);
      break;

    case 'setBusy':
      latestToken = message.token;
      elements.body.dataset['state'] = 'busy';
      break;

    case 'configure':
      theme = message.theme;
      doubleClickToSource = message.doubleClickToSource;
      viewer.configure({ zoomStep: message.zoomStep });
      setStatus(message.statusText);
      break;

    case 'command':
      runViewCommand(message.command);
      break;

    case 'exportRequest':
      await handleExport(message.token, message.format, message.scale);
      break;

    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

async function renderLocally(token: number, source: string, requestedTheme: 'light' | 'dark'): Promise<void> {
  elements.body.dataset['state'] = 'busy';
  const started = performance.now();

  let active: PlantUmlEngine;
  try {
    active = engine ?? (await loadEngine());
    engine = active;
  } catch (error) {
    postFailure(token, `The PlantUML engine is not available: ${describe(error)}`);
    return;
  }

  try {
    const svg = await active.render(source, requestedTheme === 'dark', 60_000);
    if (token !== latestToken) {
      // A newer request has already been issued; this result is stale.
      return;
    }
    applySvg(token, svg, Math.round(performance.now() - started));
  } catch (error) {
    if (token === latestToken) {
      postFailure(token, describe(error));
    }
  }
}

/**
 * Sanitises and displays an SVG, then reports it back to the host.
 *
 * This is the only path by which markup reaches the DOM.
 */
function applySvg(token: number, rawSvg: string, durationMs: number): void {
  const sanitised = sanitiseSvg(rawSvg);
  if (!sanitised.ok) {
    postFailure(token, `The rendered diagram was rejected: ${sanitised.error}`);
    return;
  }

  const parsed = parseSvgFragment(sanitised.value.svg);
  if (parsed === undefined) {
    postFailure(token, 'The rendered diagram could not be parsed as SVG.');
    return;
  }

  prepareForDisplay(parsed);

  currentSvg = sanitised.value.svg;
  viewer.setContent(parsed);
  setOverlay(undefined);
  elements.body.dataset['state'] = 'ready';
  persistState();

  vscode.postMessage({
    type: 'rendered',
    token,
    svg: sanitised.value.svg,
    durationMs,
    removals: sanitised.value.removals,
  });
}

function postFailure(token: number, message: string): void {
  elements.body.dataset['state'] = 'error';
  setOverlay('The diagram could not be rendered.', message);
  vscode.postMessage({ type: 'renderFailed', token, message });
}

/**
 * Parses sanitised markup into a live SVG element.
 *
 * `DOMParser` with the XML mime type is used rather than `innerHTML` so that
 * the markup is never interpreted as HTML — HTML parsing has its own quirks
 * (implicit tag closing, foreign-content switching) that a sanitiser reasoning
 * about XML cannot anticipate.
 */
function parseSvgFragment(svg: string): SVGElement | undefined {
  const document_ = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (document_.getElementsByTagName('parsererror').length > 0) {
    return undefined;
  }
  const root = document_.documentElement;
  return root instanceof SVGElement ? (document.importNode(root, true)) : undefined;
}

// ---------------------------------------------------------------------------
// View commands and export
// ---------------------------------------------------------------------------

function runViewCommand(command: string): void {
  switch (command) {
    case 'zoomIn':
      viewer.zoomIn();
      break;
    case 'zoomOut':
      viewer.zoomOut();
      break;
    case 'zoomReset':
      viewer.resetZoom();
      break;
    case 'fitWidth':
      refit();
      break;
    default:
      break;
  }
}

function refit(): void {
  elements.viewport.dispatchEvent(new Event('plantuml-refit'));
  viewer.fitToWidth();
}

async function handleExport(token: number, format: 'svg' | 'png', scale: number): Promise<void> {
  if (currentSvg === undefined) {
    vscode.postMessage({
      type: 'exportFailed',
      token,
      message: 'There is nothing rendered to export yet.',
    });
    return;
  }

  try {
    const base64 =
      format === 'svg'
        ? bytesToBase64(new TextEncoder().encode(currentSvg))
        : await svgToPngBase64(currentSvg, scale);
    vscode.postMessage({ type: 'exportResult', token, format, base64 });
  } catch (error) {
    vscode.postMessage({ type: 'exportFailed', token, message: describe(error) });
  }
}

/**
 * Rasterises the current diagram.
 *
 * The SVG is loaded through a `data:` URL, which counts as same-origin, so the
 * canvas is not tainted and `toDataURL` succeeds. Nothing is fetched: the CSP
 * allows `data:` images precisely and only for this.
 */
async function svgToPngBase64(svg: string, scale: number): Promise<string> {
  const size = measureSvg(svg);
  const width = Math.max(1, Math.round(size.width * scale));
  const height = Math.max(1, Math.round(size.height * scale));

  const image = new Image();
  const dataUrl = `data:image/svg+xml;base64,${bytesToBase64(new TextEncoder().encode(svg))}`;

  await new Promise<void>((resolve, reject) => {
    image.onload = (): void => { resolve(); };
    image.onerror = (): void => { reject(new Error('The diagram could not be rasterised.')); };
    image.src = dataUrl;
  });

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context === null) {
    throw new Error('A 2D canvas is not available in this webview.');
  }
  // PNG supports transparency, but a diagram pasted into a document reads far
  // better on an opaque background matching the theme it was rendered for.
  // #1B1B1B is the background PlantUML's own dark mode paints, so the margin
  // around a dark diagram matches the diagram rather than leaving a seam.
  context.fillStyle = theme === 'dark' ? '#1b1b1b' : '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);

  const url = canvas.toDataURL('image/png');
  const comma = url.indexOf(',');
  if (comma < 0) {
    throw new Error('The rasterised image could not be read back.');
  }
  return url.slice(comma + 1);
}

function measureSvg(svg: string): { width: number; height: number } {
  const viewBox = /viewBox\s*=\s*"([^"]+)"/u.exec(svg);
  if (viewBox !== null) {
    const parts = (viewBox[1] ?? '').trim().split(/[\s,]+/u).map(Number);
    const width = parts[2];
    const height = parts[3];
    if (typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0) {
      return { width, height };
    }
  }
  return { width: 1200, height: 800 };
}

function bytesToBase64(bytes: Uint8Array): string {
  // Chunked to stay well clear of the argument-count limit on large diagrams.
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

function setOverlay(title: string | undefined, detail?: string): void {
  if (title === undefined) {
    elements.overlay.hidden = true;
    return;
  }
  elements.overlay.hidden = false;
  elements.overlayTitle.textContent = title;
  if (detail === undefined || detail.length === 0) {
    elements.overlayDetail.hidden = true;
    elements.overlayDetail.textContent = '';
  } else {
    elements.overlayDetail.hidden = false;
    elements.overlayDetail.textContent = detail;
  }
}

function setStatus(text: string): void {
  elements.status.textContent = text;
  persistState();
}

/**
 * Restores the last diagram after a window reload.
 *
 * The saved markup was already sanitised before it was stored, but it is put
 * back through the sanitiser anyway: persisted state is just as untrusted as
 * anything else once it has left our process.
 */
function restorePreviousState(): void {
  const state = vscode.getState() as PersistedState | undefined;
  if (state?.svg === undefined) {
    return;
  }
  const sanitised = sanitiseSvg(state.svg);
  if (!sanitised.ok) {
    return;
  }
  const parsed = parseSvgFragment(sanitised.value.svg);
  if (parsed === undefined) {
    return;
  }
  prepareForDisplay(parsed);
  currentSvg = sanitised.value.svg;
  viewer.setContent(parsed);
  elements.body.dataset['state'] = 'ready';
  setOverlay(undefined);
  if (state.status !== undefined) {
    elements.status.textContent = state.status;
  }
}

function persistState(): void {
  const state: PersistedState = {
    ...(currentSvg === undefined ? {} : { svg: currentSvg }),
    status: elements.status.textContent ?? '',
  };
  vscode.setState(state);
}

function readBootstrap(): Bootstrap {
  const node = document.getElementById('plantuml-bootstrap');
  const fallback: Bootstrap = {
    engineModuleUri: '',
    useBuiltInEngine: false,
    theme: 'light',
    zoomStep: 1.2,
    doubleClickToSource: true,
    initialStatus: '',
  };
  if (node?.textContent == null) {
    return fallback;
  }
  try {
    return { ...fallback, ...(JSON.parse(node.textContent) as Partial<Bootstrap>) };
  } catch {
    return fallback;
  }
}

/**
 * Looks up a required element, failing loudly rather than degrading.
 *
 * The document is built by this extension, so a missing element means the page
 * template and this script are out of sync — a bug worth surfacing at once.
 */
/**
 * Finds the source line PlantUML stamped on the clicked shape.
 *
 * The attribute sits on the group wrapping a declaration, not on the individual
 * path or text node under the pointer, so this walks up until it finds one.
 */
function sourceLineOf(target: Element | undefined): number | undefined {
  const owner = target?.closest('[data-source-line]');
  if (owner === null || owner === undefined) {
    return undefined;
  }
  const value = Number.parseInt(owner.getAttribute('data-source-line') ?? '', 10);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Gives the SVG a definite size before it is displayed.
 *
 * An SVG that carries only a `viewBox` defaults to `width: 100%` — and inside
 * the absolutely-positioned, shrink-to-fit canvas that resolves to zero, so the
 * diagram is present in the DOM but invisible. Pinning the intrinsic size from
 * the viewBox keeps the element measurable; the viewer's CSS transform does all
 * the scaling from there.
 */
function prepareForDisplay(svg: SVGElement): void {
  svg.setAttribute('class', 'diagram');

  const hasSize =
    (svg.getAttribute('width')?.length ?? 0) > 0 && (svg.getAttribute('height')?.length ?? 0) > 0;
  if (hasSize) {
    return;
  }

  const viewBox = svg.getAttribute('viewBox');
  if (viewBox === null) {
    return;
  }
  const parts = viewBox.trim().split(/[s,]+/u).map(Number);
  const width = parts[2];
  const height = parts[3];
  if (typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0) {
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
  }
}

function requireElement(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (node === null) {
    throw new Error(`The preview document is missing #${id}.`);
  }
  return node;
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'Unknown error';
}

