/**
 * The message protocol between the extension host and the preview webview.
 *
 * Both sides import this file, so the two ends of the channel cannot drift
 * apart without a compile error.
 *
 * ## Trust model
 *
 * The webview is treated as **untrusted** by the host. It runs third-party
 * rendering code (the PlantUML engine) over attacker-controlled input, so every
 * message arriving from it is validated by {@link parseWebviewMessage} before a
 * single field is read. The host never `eval`s, never resolves a path, and
 * never writes a file based on an unvalidated webview message.
 */

/** Output formats the preview can produce. */
export type ExportFormat = 'svg' | 'png';

/** Colour scheme requested for the rendered diagram. */
export type DiagramTheme = 'light' | 'dark';

// ---------------------------------------------------------------------------
// Host -> Webview
// ---------------------------------------------------------------------------

/** Ask the webview to render diagram source with its built-in engine. */
export interface RenderMessage {
  readonly type: 'render';
  /** Correlates the reply; a reply with a stale token is discarded. */
  readonly token: number;
  /** Complete PlantUML source, one entry per line. */
  readonly lines: readonly string[];
  readonly theme: DiagramTheme;
}

/** Hand the webview an already-rendered SVG produced by a host-side backend. */
export interface SetContentMessage {
  readonly type: 'setContent';
  readonly token: number;
  readonly svg: string;
}

/** Report a host-side failure so the webview can present it in place. */
export interface SetErrorMessage {
  readonly type: 'setError';
  readonly token: number;
  readonly message: string;
  readonly detail?: string;
}

/** Tell the webview a render is under way, so it can show progress. */
export interface SetBusyMessage {
  readonly type: 'setBusy';
  readonly token: number;
}

/** Push changed settings without rebuilding the whole page. */
export interface ConfigureMessage {
  readonly type: 'configure';
  readonly theme: DiagramTheme;
  readonly zoomStep: number;
  readonly doubleClickToSource: boolean;
  readonly statusText: string;
}

/** Drive the viewer from a command palette entry. */
export interface ViewCommandMessage {
  readonly type: 'command';
  readonly command: 'zoomIn' | 'zoomOut' | 'zoomReset' | 'fitWidth' | 'copyImage';
}

/** Request the current diagram as a file, for the export command. */
export interface ExportRequestMessage {
  readonly type: 'exportRequest';
  readonly token: number;
  readonly format: ExportFormat;
  /** Pixel density multiplier applied to PNG output. */
  readonly scale: number;
}

export type HostMessage =
  | RenderMessage
  | SetContentMessage
  | SetErrorMessage
  | SetBusyMessage
  | ConfigureMessage
  | ViewCommandMessage
  | ExportRequestMessage;

// ---------------------------------------------------------------------------
// Webview -> Host
// ---------------------------------------------------------------------------

/** The webview finished booting and loaded its rendering engine. */
export interface ReadyMessage {
  readonly type: 'ready';
  /** False when the bundled engine could not be loaded at all. */
  readonly engineAvailable: boolean;
  readonly engineError?: string;
}

/** A render completed; `svg` is already sanitised. */
export interface RenderedMessage {
  readonly type: 'rendered';
  readonly token: number;
  readonly svg: string;
  readonly durationMs: number;
  /** Constructs the sanitiser stripped, for the log. */
  readonly removals: readonly string[];
}

/** A render failed. */
export interface RenderFailedMessage {
  readonly type: 'renderFailed';
  readonly token: number;
  readonly message: string;
}

/** The user asked to jump from the preview back to the source. */
export interface RevealSourceMessage {
  readonly type: 'revealSource';
  /**
   * Line of the *rendered* source the clicked shape came from, 0-based.
   *
   * PlantUML stamps `data-source-line` onto the group it emits for each
   * declaration, so a double-click can land on the exact line rather than just
   * opening the file. Absent when the click was not on a diagram element.
   */
  readonly line?: number;
}

/** Result of an {@link ExportRequestMessage}, as base64 bytes. */
export interface ExportResultMessage {
  readonly type: 'exportResult';
  readonly token: number;
  readonly format: ExportFormat;
  /** Base64-encoded file content. */
  readonly base64: string;
}

/** An export could not be produced. */
export interface ExportFailedMessage {
  readonly type: 'exportFailed';
  readonly token: number;
  readonly message: string;
}

/** Diagnostic text the webview wants written to the output channel. */
export interface LogMessage {
  readonly type: 'log';
  readonly level: 'info' | 'warn' | 'error';
  readonly message: string;
}

/** The viewer's zoom changed, so the host can show it in the status bar. */
export interface ZoomChangedMessage {
  readonly type: 'zoomChanged';
  readonly zoom: number;
}

export type WebviewMessage =
  | ReadyMessage
  | RenderedMessage
  | RenderFailedMessage
  | RevealSourceMessage
  | ExportResultMessage
  | ExportFailedMessage
  | LogMessage
  | ZoomChangedMessage;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Longest string the host will accept in a single message field.
 *
 * A hostile or wedged webview must not be able to exhaust host memory by
 * posting an unbounded string, and a legitimate diagram never approaches this.
 */
const MAX_STRING_LENGTH = 64 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function str(value: unknown, max = MAX_STRING_LENGTH): string | undefined {
  return typeof value === 'string' && value.length <= max ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown, maxItems: number): string[] | undefined {
  if (!Array.isArray(value) || value.length > maxItems) {
    return undefined;
  }
  const out: string[] = [];
  for (const item of value) {
    const text = str(item, 4096);
    if (text === undefined) {
      return undefined;
    }
    out.push(text);
  }
  return out;
}

/**
 * Parses a message received from the webview.
 *
 * Returns `undefined` for anything that is not a well-formed, known message —
 * the caller logs and drops it. Unknown message types are never forwarded
 * anywhere, so adding a message to the webview without adding it here fails
 * closed rather than silently reaching untested host code.
 */
export function parseWebviewMessage(raw: unknown): WebviewMessage | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  switch (raw['type']) {
    case 'ready': {
      const engineError = str(raw['engineError'], 8192);
      return {
        type: 'ready',
        engineAvailable: raw['engineAvailable'] === true,
        ...(engineError === undefined ? {} : { engineError }),
      };
    }

    case 'rendered': {
      const token = finiteNumber(raw['token']);
      const svg = str(raw['svg']);
      const durationMs = finiteNumber(raw['durationMs']) ?? 0;
      const removals = stringArray(raw['removals'], 200) ?? [];
      if (token === undefined || svg === undefined) {
        return undefined;
      }
      return { type: 'rendered', token, svg, durationMs, removals };
    }

    case 'renderFailed': {
      const token = finiteNumber(raw['token']);
      const message = str(raw['message'], 64 * 1024);
      if (token === undefined || message === undefined) {
        return undefined;
      }
      return { type: 'renderFailed', token, message };
    }

    case 'revealSource': {
      const line = finiteNumber(raw['line']);
      return line === undefined || line < 0
        ? { type: 'revealSource' }
        : { type: 'revealSource', line: Math.floor(line) };
    }

    case 'exportResult': {
      const token = finiteNumber(raw['token']);
      const format = raw['format'];
      const base64 = str(raw['base64']);
      if (
        token === undefined ||
        base64 === undefined ||
        (format !== 'svg' && format !== 'png') ||
        // Reject anything that is not strict base64 before it reaches Buffer:
        // decoding is lenient and would silently accept smuggled bytes.
        !/^[A-Za-z0-9+/]*={0,2}$/u.test(base64)
      ) {
        return undefined;
      }
      return { type: 'exportResult', token, format, base64 };
    }

    case 'exportFailed': {
      const token = finiteNumber(raw['token']);
      const message = str(raw['message'], 64 * 1024);
      if (token === undefined || message === undefined) {
        return undefined;
      }
      return { type: 'exportFailed', token, message };
    }

    case 'log': {
      const level = raw['level'];
      const message = str(raw['message'], 64 * 1024);
      if (message === undefined || (level !== 'info' && level !== 'warn' && level !== 'error')) {
        return undefined;
      }
      return { type: 'log', level, message };
    }

    case 'zoomChanged': {
      const zoom = finiteNumber(raw['zoom']);
      if (zoom === undefined || zoom <= 0) {
        return undefined;
      }
      return { type: 'zoomChanged', zoom };
    }

    default:
      return undefined;
  }
}
