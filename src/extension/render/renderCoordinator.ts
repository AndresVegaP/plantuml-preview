/**
 * Turns a document plus a selected diagram block into renderable source, and
 * runs the host-side backends.
 *
 * The webview never sees a file path, a URI or a configuration value — only
 * finished text. Keeping that translation in one place is what allows the
 * sandboxed JavaScript renderer to support `!include` at all without granting
 * the webview any file access.
 */

import * as path from 'node:path';

import * as vscode from 'vscode';

import { toRenderableSource, type DiagramBlock } from '../../shared/diagram.js';
import { err, ok, type Result } from '../../shared/result.js';
import {
  resolveIncludeRoots,
  validateServerUrl,
  type PlantUmlConfiguration,
} from '../config.js';
import { resolveIncludes, type IncludeProblem } from '../include/includeResolver.js';
import type { Logger } from '../logger.js';
import { JarRenderer } from './jarRenderer.js';
import type { HostRenderer, RenderFailure, RenderOutcome } from './renderer.js';
import { ServerRenderer } from './serverRenderer.js';

/** Ceiling on the total size of inlined include text, in characters. */
const MAX_INCLUDE_CHARS = 8 * 1024 * 1024;

/** Source ready to hand to a renderer, plus the map back to the document. */
export interface PreparedSource {
  readonly text: string;
  readonly includeProblems: readonly IncludeProblem[];
  /** Absolute paths of every file inlined, so the preview can watch them. */
  readonly includedFiles: readonly string[];
  /**
   * Translates a line of {@link text} into a line of the document.
   *
   * Returns `undefined` when the line has no meaningful counterpart, which
   * happens for the synthetic `@startuml` wrapper added around a file that has
   * no delimiters of its own.
   */
  toDocumentLine(renderedLine: number): number | undefined;
}

export class RenderCoordinator {
  constructor(private readonly logger: Logger) {}

  /**
   * Builds the text for one diagram block, resolving includes when enabled.
   *
   * Include failures are returned as problems rather than thrown: a diagram
   * with one broken include should still render everything else.
   */
  async prepare(
    document: vscode.TextDocument,
    block: DiagramBlock,
    config: PlantUmlConfiguration,
  ): Promise<PreparedSource> {
    // A file with no `@startuml` is wrapped so backends see a complete diagram;
    // that shifts every line by one, which the mapping below undoes.
    const wrapped = block.implicit;
    const blockSource = toRenderableSource(block);
    const wrapperOffset = wrapped ? 1 : 0;

    const identityMap = (renderedLine: number): number | undefined => {
      const withinBlock = renderedLine - wrapperOffset;
      if (withinBlock < 0) {
        return undefined;
      }
      return block.startLine + withinBlock;
    };

    if (!config.includeEnabled || document.uri.scheme !== 'file') {
      return {
        text: blockSource,
        includeProblems: [],
        includedFiles: [],
        toDocumentLine: identityMap,
      };
    }

    const { allowedRoots, searchPaths } = resolveIncludeRoots(document.uri, config);

    const resolved = await resolveIncludes(
      blockSource,
      {
        documentPath: document.uri.fsPath,
        allowedRoots,
        searchPaths,
        maxDepth: config.includeMaxDepth,
        allowOutsideRoots: config.includeAllowOutsideWorkspace,
        maxTotalChars: MAX_INCLUDE_CHARS,
      },
      async (absolutePath) => await readTextFile(absolutePath),
    );

    // Include problems are reported against the *block* source, so lift them
    // into document coordinates before they leave this function.
    const problems = resolved.problems.map((problem) => ({
      ...problem,
      line: identityMap(problem.line) ?? block.startLine,
    }));

    return {
      text: resolved.text,
      includeProblems: problems,
      includedFiles: resolved.includedFiles,
      toDocumentLine: (renderedLine: number): number | undefined => {
        const blockLine = resolved.lineMap[renderedLine];
        return blockLine === undefined ? undefined : identityMap(blockLine);
      },
    };
  }

  /**
   * Builds the host-side renderer for the configured backend.
   *
   * Returns `undefined` for the `javascript` backend, which is not a host
   * renderer at all: it lives in the webview and is driven over the message
   * channel.
   */
  createHostRenderer(
    document: vscode.TextDocument,
    config: PlantUmlConfiguration,
  ): Result<HostRenderer | undefined, RenderFailure> {
    switch (config.backend) {
      case 'javascript':
        return ok(undefined);

      case 'jar': {
        const { allowedRoots } = resolveIncludeRoots(document.uri, config);
        return ok(
          new JarRenderer({
            javaPath: config.javaPath,
            jarPath: config.jarPath,
            jvmArguments: config.jvmArguments,
            allowedRoots,
          }),
        );
      }

      case 'server': {
        const validated = validateServerUrl(config.serverUrl, config.allowRemoteServer);
        if ('error' in validated) {
          return err({ message: validated.error, configurationError: true });
        }
        this.logger.info(`Using PlantUML server at ${validated.url.origin}`);
        return ok(new ServerRenderer({ baseUrl: validated.url }));
      }

      default:
        return err({ message: 'Unknown rendering backend.', configurationError: true });
    }
  }

  /** Runs a host renderer, converting a thrown error into a failure value. */
  async render(
    renderer: HostRenderer,
    source: string,
    config: PlantUmlConfiguration,
  ): Promise<RenderOutcome> {
    try {
      return await renderer.render({
        source,
        dark: config.theme === 'dark',
        timeoutMs: config.timeoutMs,
      });
    } catch (error) {
      this.logger.error(`Backend "${renderer.id}" threw`, error);
      return err({
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Reads an included file.
 *
 * Goes through `workspace.fs` so that a file already open with unsaved changes
 * is read from the editor's buffer — otherwise the preview would show stale
 * content for the very file the user is editing alongside it.
 */
async function readTextFile(absolutePath: string): Promise<string | undefined> {
  const uri = vscode.Uri.file(absolutePath);

  const open = vscode.workspace.textDocuments.find(
    (candidate) => candidate.uri.scheme === 'file' && pathsEqual(candidate.uri.fsPath, absolutePath),
  );
  if (open !== undefined) {
    return open.getText();
  }

  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return undefined;
  }
}

function pathsEqual(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}
