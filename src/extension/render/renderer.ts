/**
 * The renderer abstraction.
 *
 * Three very different things can turn PlantUML text into a picture — a
 * JavaScript engine inside the webview, a local `plantuml.jar`, and an HTTP
 * server — and the preview must not care which one is in use. They all
 * implement {@link HostRenderer}, except the JavaScript engine, whose "backend"
 * is the webview itself and which is therefore driven through the preview's
 * message channel instead.
 */

import type { Result } from '../../shared/result.js';

/** What the caller wants rendered. */
export interface RenderRequest {
  /** Complete, include-resolved PlantUML source for a single diagram. */
  readonly source: string;
  /** Requested colour scheme; backends that cannot honour it ignore it. */
  readonly dark: boolean;
  /** Abandon the render after this many milliseconds. */
  readonly timeoutMs: number;
}

/** A successful render. */
export interface RenderSuccess {
  /** Raw SVG markup, before sanitising. */
  readonly svg: string;
  /** Wall-clock duration, for the log. */
  readonly durationMs: number;
}

/** Why a render failed, in a form the UI and the Problems panel can both use. */
export interface RenderFailure {
  /** One-line summary shown in the preview. */
  readonly message: string;
  /** Full backend output, written to the log. */
  readonly detail?: string;
  /**
   * Line within the rendered diagram source that the backend blamed, 0-based.
   * Callers translate it into a document position.
   */
  readonly sourceLine?: number;
  /** True when the failure is a configuration problem rather than a bad diagram. */
  readonly configurationError?: boolean;
}

export type RenderOutcome = Result<RenderSuccess, RenderFailure>;

/** A renderer that runs in the extension host. */
export interface HostRenderer {
  /** Stable identifier used in logs and error messages. */
  readonly id: string;
  /**
   * Checks that the backend can run at all.
   *
   * Called before the first render so a missing Java or an unreachable server
   * is reported as a clear configuration message rather than as a broken
   * diagram.
   */
  validate(): Promise<Result<void, RenderFailure>>;
  render(request: RenderRequest): Promise<RenderOutcome>;
}
