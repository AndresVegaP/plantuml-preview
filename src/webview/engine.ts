/**
 * A typed wrapper around the bundled PlantUML JavaScript engine.
 *
 * The engine is `@plantuml/core`: the real PlantUML, compiled from Java to
 * JavaScript with TeaVM, paired with Graphviz compiled to WebAssembly. It is
 * MIT licensed and needs no Java, no Graphviz binary and no server, which is
 * what makes a genuinely offline preview possible.
 *
 * Two details of its API shape this wrapper:
 *
 * 1. `renderToString` is callback-based and asynchronous, so it is promisified
 *    here.
 * 2. The engine keeps global state per render, so two overlapping renders
 *    corrupt each other's output. Every call is therefore funnelled through a
 *    single-slot queue.
 */

/** Options the engine understands. */
interface EngineOptions {
  /** Render with a dark palette. */
  readonly dark?: boolean;
  /** Largest image the engine will produce, per side, in pixels. */
  readonly maxSvgSize?: number;
}

interface EngineModule {
  renderToString(
    lines: readonly string[],
    onSuccess: (svg: string) => void,
    onError: (error: unknown) => void,
    options?: EngineOptions,
  ): void;
}

/** Upper bound on generated image size, mirroring PLANTUML_LIMIT_SIZE. */
const MAX_SVG_SIZE = 16384;

export class PlantUmlEngine {
  private constructor(private readonly module: EngineModule) {}

  /** Chain that serialises renders; see the note about global engine state. */
  private queue: Promise<unknown> = Promise.resolve();

  /**
   * Loads the engine module.
   *
   * The URL is resolved by the extension host and passed in, because a compiled
   * webview bundle cannot know its own `vscode-resource` origin at build time.
   */
  static async load(moduleUri: string): Promise<PlantUmlEngine> {
    const loaded = (await import(/* webpackIgnore: true */ moduleUri)) as Partial<EngineModule>;
    if (typeof loaded.renderToString !== 'function') {
      throw new Error('The PlantUML engine module did not export renderToString.');
    }
    return new PlantUmlEngine(loaded as EngineModule);
  }

  /**
   * Renders one diagram to an SVG string.
   *
   * Rejects with the engine's own error when the diagram cannot be rendered.
   * Note that a *syntax* error is not an error here: PlantUML answers those
   * with a valid SVG that draws the message, which the caller detects.
   */
  render(source: string, dark: boolean, timeoutMs: number): Promise<string> {
    const run = async (): Promise<string> => {
      const lines = source.split(/\r\n|\r|\n/u);
      return await new Promise<string>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error(`The renderer did not finish within ${timeoutMs} ms.`));
          }
        }, timeoutMs);

        const succeed = (svg: string): void => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(svg);
          }
        };
        const fail = (error: unknown): void => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(error instanceof Error ? error : new Error(describe(error)));
          }
        };

        try {
          this.module.renderToString(lines, succeed, fail, {
            dark,
            maxSvgSize: MAX_SVG_SIZE,
          });
        } catch (error) {
          fail(error);
        }
      });
    };

    // Queue behind whatever is already running, and keep the chain alive even
    // when a render rejects.
    const result = this.queue.then(run, run);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function describe(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }
  if (error !== null && typeof error === 'object' && 'message' in error) {
    const message = (error).message;
    if (typeof message === 'string') {
      return message;
    }
  }
  return 'The PlantUML engine reported an unspecified error.';
}
