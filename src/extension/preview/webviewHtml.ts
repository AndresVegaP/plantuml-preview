/**
 * The webview document.
 *
 * ## The Content-Security-Policy is the security boundary
 *
 * The preview runs a large third-party rendering engine over untrusted diagram
 * text. Rather than trust that engine to be well-behaved, the page it runs in
 * is locked down so that misbehaviour has nowhere to go:
 *
 * - `default-src 'none'` — nothing loads unless a directive below allows it.
 * - `connect-src 'none'` — this is the important one. PlantUML supports
 *   `!includeurl` and remote sprites, and the JavaScript engine implements them
 *   with `XMLHttpRequest`. With no connect sources, those calls fail at the
 *   browser level, so a `.puml` file cannot make the editor fetch a URL — no
 *   SSRF, no tracking pixel, no exfiltration of the diagram to a third party.
 * - `script-src` allows only extension-local files and the one nonce'd inline
 *   bootstrap. `'wasm-unsafe-eval'` is required because the Graphviz layout
 *   engine is WebAssembly; it permits instantiating a module, not `eval`.
 * - `style-src` includes `'unsafe-inline'` because PlantUML styles the SVG it
 *   builds with `setAttribute('style', …)`. That is safe here precisely
 *   because no source is allowed for any fetch: CSS cannot phone home when
 *   every load is already denied.
 * - `frame-src`, `object-src`, `base-uri` and `form-action` are all `'none'`,
 *   closing the classic markup-injection escapes.
 */

import { randomBytes } from 'node:crypto';

import type * as vscode from 'vscode';

/** Values the page needs at boot, passed as inert JSON rather than script. */
export interface WebviewBootstrap {
  /** URL of the PlantUML JavaScript engine module. */
  readonly engineModuleUri: string;
  /** Whether the built-in engine should be loaded at all. */
  readonly useBuiltInEngine: boolean;
  readonly theme: 'light' | 'dark';
  readonly zoomStep: number;
  readonly doubleClickToSource: boolean;
  /** Restored viewer state after a window reload, if any. */
  readonly initialStatus: string;
}

export interface WebviewResources {
  readonly styleUri: vscode.Uri;
  readonly scriptUri: vscode.Uri;
  readonly engineScriptUri: vscode.Uri;
  readonly engineModuleUri: vscode.Uri;
}

/** Generates a fresh CSP nonce. 128 bits from a CSPRNG, per publish. */
export function createNonce(): string {
  return randomBytes(16).toString('base64');
}

/** Builds the full HTML document for a preview panel. */
export function renderWebviewHtml(
  webview: vscode.Webview,
  resources: WebviewResources,
  bootstrap: WebviewBootstrap,
): string {
  const nonce = createNonce();
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src ${webview.cspSource} 'nonce-${nonce}' 'wasm-unsafe-eval'`,
    "connect-src 'none'",
    "worker-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');

  // Serialised as JSON inside a non-executable data block. `<` is escaped so
  // the payload can never terminate the script element early, which is the
  // only way a value here could become markup.
  const bootstrapJson = JSON.stringify(bootstrap).replace(/</gu, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${resources.styleUri.toString()}" />
<title>PlantUML Preview</title>
</head>
<body class="plantuml-preview" data-state="loading">
<script type="application/json" id="plantuml-bootstrap">${bootstrapJson}</script>

<div id="viewport" class="viewport" tabindex="0" role="img" aria-label="PlantUML diagram">
  <div id="canvas" class="canvas"></div>
</div>

<div id="overlay" class="overlay" role="status" aria-live="polite">
  <div class="overlay__panel">
    <div id="overlay-title" class="overlay__title">Starting the PlantUML engine…</div>
    <pre id="overlay-detail" class="overlay__detail" hidden></pre>
  </div>
</div>

<div id="toolbar" class="toolbar" role="toolbar" aria-label="Diagram view controls">
  <button type="button" id="zoom-out" class="toolbar__button" title="Zoom out" aria-label="Zoom out">&#8722;</button>
  <button type="button" id="zoom-level" class="toolbar__button toolbar__button--wide" title="Reset zoom to 100%" aria-label="Reset zoom">100%</button>
  <button type="button" id="zoom-in" class="toolbar__button" title="Zoom in" aria-label="Zoom in">+</button>
  <button type="button" id="fit-width" class="toolbar__button toolbar__button--wide" title="Fit the diagram to the window" aria-label="Fit to window">Fit</button>
</div>

<div id="status" class="status"></div>

${
  bootstrap.useBuiltInEngine
    ? `<script nonce="${nonce}" src="${resources.engineScriptUri.toString()}"></script>`
    : ''
}
<script type="module" nonce="${nonce}" src="${resources.scriptUri.toString()}"></script>
</body>
</html>`;
}
