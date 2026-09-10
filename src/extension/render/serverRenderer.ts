/**
 * The `server` backend: renders by calling a PlantUML server over HTTP.
 *
 * Intended for a server the user runs themselves — `docker run -d -p 8080:8080
 * plantuml/plantuml-server:jetty` — or one their organisation hosts.
 *
 * ## Why this is opt-in and loudly gated
 *
 * Using it means the *content of the diagram* leaves the machine. For a
 * corporate architecture diagram that is a meaningful disclosure, so the URL is
 * validated by {@link validateServerUrl} before we get here: anything that is
 * not loopback is refused unless the user explicitly enabled
 * `plantuml.render.allowRemoteServer`.
 *
 * Implemented on `node:http`/`node:https` rather than a client library, to keep
 * the extension free of runtime dependencies.
 */

import * as http from 'node:http';
import * as https from 'node:https';

import { err, ok, type Result } from '../../shared/result.js';
import { parseErrorImage, parseErrorText } from './errorParser.js';
import { encodePlantUmlText } from './plantumlEncoder.js';
import type { HostRenderer, RenderFailure, RenderOutcome, RenderRequest } from './renderer.js';

/** Cap on a response body, so a hostile server cannot exhaust memory. */
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/**
 * Practical ceiling for a URL path segment.
 *
 * Jetty and Tomcat both refuse very long request lines, and the failure mode is
 * an opaque 414. Past this size the renderer switches to POST.
 */
const MAX_ENCODED_URL_LENGTH = 4000;

/**
 * Headers the official server uses to report a diagram error alongside a
 * rendered error image.
 */
const ERROR_HEADER = 'x-plantuml-diagram-error';
const ERROR_LINE_HEADER = 'x-plantuml-diagram-error-line';

export interface ServerRendererOptions {
  /** Validated base URL, e.g. `http://localhost:8080`. */
  readonly baseUrl: URL;
}

export class ServerRenderer implements HostRenderer {
  readonly id = 'server';

  constructor(private readonly options: ServerRendererOptions) {}

  async validate(): Promise<Result<void, RenderFailure>> {
    // A tiny diagram doubles as a reachability probe: if this renders, the
    // server is up, speaks the expected protocol, and the path prefix is right.
    const probe = await this.render({
      source: '@startuml\nBob -> Alice : ping\n@enduml',
      dark: false,
      timeoutMs: 10_000,
    });
    if (probe.ok) {
      return ok(undefined);
    }
    return err({
      message: `PlantUML server at ${this.options.baseUrl.origin} did not answer: ${probe.error.message}`,
      configurationError: true,
    });
  }

  async render(request: RenderRequest): Promise<RenderOutcome> {
    const started = Date.now();
    const encoded = encodePlantUmlText(request.source);

    const response =
      encoded.length <= MAX_ENCODED_URL_LENGTH
        ? await this.get(encoded, request.timeoutMs)
        : await this.post(request.source, request.timeoutMs);

    if (!response.ok) {
      return response;
    }

    const { body, headers, statusCode } = response.value;
    const durationMs = Date.now() - started;
    const svg = body.toString('utf8');

    const headerError = headers[ERROR_HEADER];
    if (typeof headerError === 'string' && headerError.length > 0) {
      const rawLine = headers[ERROR_LINE_HEADER];
      const line = typeof rawLine === 'string' ? Number.parseInt(rawLine, 10) : Number.NaN;
      return err({
        message: headerError,
        ...(Number.isFinite(line) && line >= 1 ? { sourceLine: line - 1 } : {}),
      });
    }

    if (statusCode >= 400) {
      const textError = parseErrorText(svg);
      return err({
        message: textError?.message ?? `PlantUML server returned HTTP ${statusCode}.`,
        detail: svg.slice(0, 4000),
      });
    }

    const imageError = parseErrorImage(svg);
    if (imageError !== undefined) {
      return err({
        message: imageError.message,
        ...(imageError.line === undefined ? {} : { sourceLine: imageError.line }),
      });
    }

    if (!svg.includes('<svg')) {
      return err({
        message: 'The server did not return an SVG image.',
        detail: svg.slice(0, 4000),
      });
    }

    return ok({ svg, durationMs });
  }

  /** Classic PlantUML server call: the diagram travels encoded in the path. */
  private get(
    encoded: string,
    timeoutMs: number,
  ): Promise<Result<HttpResponse, RenderFailure>> {
    const url = this.endpoint(`svg/${encoded}`);
    return httpRequest(url, { method: 'GET', timeoutMs });
  }

  /**
   * Fallback for diagrams too large for a URL.
   *
   * The official server accepts the raw source as a POST body on the same
   * endpoint. Should a particular server not support it, the failure surfaces
   * as a plain HTTP status rather than a corrupted diagram.
   */
  private post(source: string, timeoutMs: number): Promise<Result<HttpResponse, RenderFailure>> {
    const url = this.endpoint('svg');
    return httpRequest(url, {
      method: 'POST',
      timeoutMs,
      body: Buffer.from(source, 'utf8'),
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  /**
   * Builds an endpoint URL under the configured base.
   *
   * The path is appended, never substituted, so a base URL that already carries
   * a prefix such as `/plantuml` keeps working.
   */
  private endpoint(suffix: string): URL {
    const base = this.options.baseUrl.href.endsWith('/')
      ? this.options.baseUrl.href
      : `${this.options.baseUrl.href}/`;
    return new URL(suffix, base);
  }
}

interface HttpResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string | undefined>;
  readonly body: Buffer;
}

interface HttpOptions {
  readonly method: 'GET' | 'POST';
  readonly timeoutMs: number;
  readonly body?: Buffer;
  readonly headers?: Record<string, string>;
}

/**
 * A minimal HTTP client.
 *
 * Redirects are deliberately **not** followed: a redirect is how a benign-
 * looking local URL would be turned into a request to somewhere else, and this
 * client exists precisely to keep diagram text where the user pointed it.
 */
function httpRequest(url: URL, options: HttpOptions): Promise<Result<HttpResponse, RenderFailure>> {
  return new Promise<Result<HttpResponse, RenderFailure>>((resolve) => {
    let settled = false;
    const finish = (result: Result<HttpResponse, RenderFailure>): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(
      url,
      {
        method: options.method,
        headers: {
          accept: 'image/svg+xml, text/plain',
          ...options.headers,
          ...(options.body === undefined
            ? {}
            : { 'content-length': String(options.body.length) }),
        },
        timeout: options.timeoutMs,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          response.resume();
          finish(
            errFailure(
              `The server answered with a redirect (HTTP ${status}). ` +
                'Redirects are not followed; configure the final URL directly.',
            ),
          );
          return;
        }

        const chunks: Buffer[] = [];
        let total = 0;
        response.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_RESPONSE_BYTES) {
            request.destroy();
            finish(errFailure('The server response was too large.'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          finish(
            ok({
              statusCode: status,
              headers: normaliseHeaders(response.headers),
              body: Buffer.concat(chunks),
            }),
          );
        });
        response.on('error', (error: Error) => { finish(errFailure(error.message)); });
      },
    );

    request.on('timeout', () => {
      request.destroy();
      finish(errFailure(`The server did not answer within ${options.timeoutMs} ms.`));
    });
    request.on('error', (error: Error) => { finish(errFailure(error.message)); });

    if (options.body !== undefined) {
      request.write(options.body);
    }
    request.end();
  });
}

function errFailure(message: string): Result<HttpResponse, RenderFailure> {
  return err({ message });
}

function normaliseHeaders(
  headers: http.IncomingHttpHeaders,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}
