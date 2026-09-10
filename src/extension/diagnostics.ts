/**
 * Diagram problems in the Problems panel.
 *
 * A preview that shows "Syntax Error?" as a picture makes the user hunt for the
 * mistake by eye. Publishing the same information as a `Diagnostic` puts a
 * squiggle on the offending line, lists it in the Problems panel and lets
 * F8 walk between errors — the workflow people already have for code.
 */

import * as vscode from 'vscode';

import type { IDisposable } from '../shared/disposable.js';
import type { IncludeProblem } from './include/includeResolver.js';
import type { RenderFailure } from './render/renderer.js';

const SOURCE = 'plantuml';

export class DiagnosticsManager implements IDisposable {
  private readonly collection: vscode.DiagnosticCollection;

  constructor() {
    this.collection = vscode.languages.createDiagnosticCollection(SOURCE);
  }

  /** Replaces every diagnostic for one document. */
  publish(
    document: vscode.TextDocument,
    includeProblems: readonly IncludeProblem[],
    failure: RenderFailure | undefined,
    toDocumentLine: (renderedLine: number) => number | undefined,
    enabled: boolean,
  ): void {
    if (!enabled) {
      this.collection.delete(document.uri);
      return;
    }

    const diagnostics: vscode.Diagnostic[] = [];

    for (const problem of includeProblems) {
      diagnostics.push(
        this.build(
          document,
          problem.line,
          problem.reason,
          problem.severity === 'error'
            ? vscode.DiagnosticSeverity.Error
            : vscode.DiagnosticSeverity.Warning,
          'include',
        ),
      );
    }

    if (failure !== undefined && failure.configurationError !== true) {
      // A backend that named a line gets a precise squiggle; one that did not
      // is attached to the top of the document rather than guessed at.
      const line =
        failure.sourceLine === undefined ? 0 : (toDocumentLine(failure.sourceLine) ?? 0);
      diagnostics.push(
        this.build(document, line, failure.message, vscode.DiagnosticSeverity.Error, 'render'),
      );
    }

    if (diagnostics.length === 0) {
      this.collection.delete(document.uri);
    } else {
      this.collection.set(document.uri, diagnostics);
    }
  }

  clear(uri: vscode.Uri): void {
    this.collection.delete(uri);
  }

  dispose(): void {
    this.collection.dispose();
  }

  /**
   * Builds a diagnostic covering a whole line.
   *
   * The line is clamped to the document because a backend can report a line
   * number from source that has since been edited, and an out-of-range range
   * would be silently dropped by VS Code.
   */
  private build(
    document: vscode.TextDocument,
    rawLine: number,
    message: string,
    severity: vscode.DiagnosticSeverity,
    code: string,
  ): vscode.Diagnostic {
    const line = Math.min(Math.max(0, rawLine), Math.max(0, document.lineCount - 1));
    const textLine = document.lineAt(line);
    const range = textLine.text.trim().length > 0 ? textLine.range : textLine.rangeIncludingLineBreak;

    const diagnostic = new vscode.Diagnostic(range, message, severity);
    diagnostic.source = SOURCE;
    diagnostic.code = code;
    return diagnostic;
  }
}
