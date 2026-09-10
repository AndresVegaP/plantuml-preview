/**
 * The `jar` backend: renders by running a local `plantuml.jar` under Java.
 *
 * This is the optional, highest-fidelity path. It is never the default, because
 * it requires the user to install a JRE and obtain a jar, and because starting
 * a process is a bigger capability than rendering in a sandbox.
 *
 * ## Hardening
 *
 * - The child is started with `spawn` and an **argument array**. No shell is
 *   involved anywhere, so a diagram, a path or a setting containing `&&`,
 *   backticks or quotes is data, never syntax.
 * - PlantUML runs under `PLANTUML_SECURITY_PROFILE=ALLOWLIST` with an explicit
 *   list of readable folders, so `!include` and `%load_json` cannot reach
 *   arbitrary files and `!includeurl` cannot reach the network.
 * - Source arrives on stdin, never as a temporary file, so there is no
 *   predictable path for another process to race.
 * - The process is killed on timeout, and its output is capped, so a
 *   pathological diagram cannot hang or exhaust the editor.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { err, ok, type Result } from '../../shared/result.js';
import { parseErrorImage, parseErrorText } from './errorParser.js';
import type { HostRenderer, RenderFailure, RenderOutcome, RenderRequest } from './renderer.js';

/** Hard ceiling on what a render may write, to bound memory. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Largest image PlantUML will attempt, in pixels per side. */
const PLANTUML_LIMIT_SIZE = '16384';

export interface JarRendererOptions {
  /** Configured java executable, or empty to search. */
  readonly javaPath: string;
  /** Absolute path to plantuml.jar. */
  readonly jarPath: string;
  /** Extra JVM arguments, passed verbatim before `-jar`. */
  readonly jvmArguments: readonly string[];
  /** Folders PlantUML is permitted to read. */
  readonly allowedRoots: readonly string[];
}

export class JarRenderer implements HostRenderer {
  readonly id = 'jar';

  constructor(private readonly options: JarRendererOptions) {}

  async validate(): Promise<Result<void, RenderFailure>> {
    const java = await resolveJavaExecutable(this.options.javaPath);
    if (java === undefined) {
      return err({
        message:
          'Java was not found. Set plantuml.render.javaPath, define JAVA_HOME, or switch ' +
          'plantuml.render.backend back to "javascript" (which needs nothing installed).',
        configurationError: true,
      });
    }

    if (this.options.jarPath.length === 0) {
      return err({
        message:
          'No plantuml.jar is configured. Set plantuml.render.jarPath, or run ' +
          '"npm run fetch:plantuml" in the extension folder to download a verified copy.',
        configurationError: true,
      });
    }

    try {
      const stat = await fs.stat(this.options.jarPath);
      if (!stat.isFile()) {
        return err({
          message: `plantuml.render.jarPath does not point at a file: ${this.options.jarPath}`,
          configurationError: true,
        });
      }
    } catch {
      return err({
        message: `plantuml.jar was not found at ${this.options.jarPath}`,
        configurationError: true,
      });
    }

    return ok(undefined);
  }

  async render(request: RenderRequest): Promise<RenderOutcome> {
    const java = await resolveJavaExecutable(this.options.javaPath);
    if (java === undefined) {
      return err({ message: 'Java was not found.', configurationError: true });
    }

    const started = Date.now();
    const result = await runJava(java, this.buildArguments(), request.source, request.timeoutMs);
    const durationMs = Date.now() - started;

    if (result.kind === 'timeout') {
      return err({
        message: `Rendering took longer than ${request.timeoutMs} ms and was cancelled.`,
        detail: 'Raise plantuml.render.timeoutMs if the diagram is genuinely large.',
      });
    }
    if (result.kind === 'spawnError') {
      return err({ message: `Could not start Java: ${result.message}`, configurationError: true });
    }

    const stderr = result.stderr.toString('utf8').trim();
    const svg = result.stdout.toString('utf8');

    // PlantUML answers a broken diagram with a valid SVG that says "Syntax
    // Error?", so a zero exit code is not by itself evidence of success.
    const imageError = parseErrorImage(svg);
    if (imageError !== undefined) {
      return err({
        message: imageError.message,
        ...(stderr.length > 0 ? { detail: stderr } : {}),
        ...(imageError.line === undefined ? {} : { sourceLine: imageError.line }),
      });
    }

    if (result.code !== 0 || !svg.includes('<svg')) {
      const textError = parseErrorText(stderr.length > 0 ? stderr : svg);
      return err({
        message: textError?.message ?? `PlantUML exited with code ${result.code ?? -1}.`,
        ...(stderr.length > 0 ? { detail: stderr } : {}),
        ...(textError?.line === undefined ? {} : { sourceLine: textError.line }),
      });
    }

    return ok({ svg, durationMs });
  }

  private buildArguments(): string[] {
    const allowlist = this.options.allowedRoots.join(path.delimiter);
    return [
      // Never try to open a display; rendering is entirely offscreen.
      '-Djava.awt.headless=true',
      '-Dfile.encoding=UTF-8',
      // Confine file access to the folders the document legitimately needs and
      // block every network include.
      '-DPLANTUML_SECURITY_PROFILE=ALLOWLIST',
      ...(allowlist.length > 0 ? [`-Dplantuml.allowlist.path=${allowlist}`] : []),
      `-DPLANTUML_LIMIT_SIZE=${PLANTUML_LIMIT_SIZE}`,
      ...this.options.jvmArguments,
      '-jar',
      this.options.jarPath,
      '-tsvg',
      '-pipe',
      '-charset',
      'UTF-8',
      // Keep the source out of the output: it is already on disk, and metadata
      // makes every render byte-unstable.
      '-nometadata',
      // One-line, parseable error reports on stderr.
      '-stdrpt:2',
    ];
  }
}

type RunResult =
  | { kind: 'exit'; code: number | null; stdout: Buffer; stderr: Buffer }
  | { kind: 'timeout' }
  | { kind: 'spawnError'; message: string };

function runJava(
  executable: string,
  args: readonly string[],
  input: string,
  timeoutMs: number,
): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    let settled = false;
    const finish = (result: RunResult): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(result);
      }
    };

    const child = spawn(executable, [...args], {
      // No shell: arguments are passed to the OS verbatim.
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ kind: 'timeout' });
    }, timeoutMs);

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish({ kind: 'timeout' });
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 512) {
        stderr.push(chunk);
      }
    });

    child.on('error', (error: Error) => {
      finish({ kind: 'spawnError', message: error.message });
    });
    child.on('close', (code) => {
      finish({ kind: 'exit', code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });

    // A broken pipe here is normal when the child dies early; it must not
    // become an unhandled error event.
    child.stdin.on('error', () => undefined);
    child.stdin.end(Buffer.from(input, 'utf8'));
  });
}

/**
 * Finds a usable `java`.
 *
 * Order of preference: the explicit setting, then `JAVA_HOME`, then whatever is
 * on `PATH`. Each candidate is verified by actually running `-version`, because
 * a stale `JAVA_HOME` pointing at a removed JDK is a common state.
 */
export async function resolveJavaExecutable(configured: string): Promise<string | undefined> {
  const binary = process.platform === 'win32' ? 'java.exe' : 'java';
  const candidates: string[] = [];

  if (configured.length > 0) {
    candidates.push(configured);
  }
  const javaHome = process.env['JAVA_HOME'];
  if (javaHome !== undefined && javaHome.length > 0) {
    candidates.push(path.join(javaHome, 'bin', binary));
  }
  candidates.push('java');

  for (const candidate of candidates) {
    if (await canRunJava(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function canRunJava(executable: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }
    };

    const child = spawn(executable, ['-version'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(false);
    }, 10_000);

    child.on('error', () => { finish(false); });
    child.on('close', (code) => { finish(code === 0); });
  });
}
