/**
 * Typed, validated access to the extension's settings.
 *
 * `workspace.getConfiguration().get<T>()` is unsound: a workspace `.vscode/
 * settings.json` is untrusted content, and it can contain a string where the
 * manifest promised a number. Every value is therefore re-validated here, and a
 * bad value falls back to the documented default instead of propagating into
 * the render pipeline.
 *
 * Settings that select an *executable*, a *jar* or a *server* are additionally
 * gated on workspace trust, so opening an untrusted repository cannot cause the
 * extension to run a program that repository chose.
 */

import * as path from 'node:path';

import * as vscode from 'vscode';

export { isLoopbackHost, validateServerUrl } from '../shared/serverUrl.js';

export const CONFIG_SECTION = 'plantuml';

export type RenderBackend = 'javascript' | 'jar' | 'server';
export type UpdateMode = 'live' | 'onSave' | 'manual';
export type ThemeMode = 'auto' | 'light' | 'dark';
export type ExportFormat = 'svg' | 'png';

export interface PlantUmlConfiguration {
  readonly backend: RenderBackend;
  readonly javaPath: string;
  readonly jarPath: string;
  readonly jvmArguments: readonly string[];
  readonly serverUrl: string;
  readonly allowRemoteServer: boolean;
  readonly timeoutMs: number;

  readonly updateMode: UpdateMode;
  readonly debounceMs: number;
  readonly theme: ThemeMode;
  readonly scrollPreviewWithEditor: boolean;
  readonly doubleClickToSource: boolean;
  readonly zoomStep: number;

  readonly includeEnabled: boolean;
  readonly includePaths: readonly string[];
  readonly includeMaxDepth: number;
  readonly includeAllowOutsideWorkspace: boolean;

  readonly exportFormat: ExportFormat;
  readonly exportPngScale: number;
  readonly exportDirectory: string;

  readonly diagnosticsEnabled: boolean;
}

/**
 * Reads the configuration for a specific resource.
 *
 * Resource scope matters: include paths and the export directory are commonly
 * set per workspace folder in a multi-root workspace.
 */
export function readConfiguration(resource: vscode.Uri | undefined): PlantUmlConfiguration {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION, resource ?? null);
  const trusted = vscode.workspace.isTrusted;

  const requestedBackend = enumValue<RenderBackend>(
    config.get('render.backend'),
    ['javascript', 'jar', 'server'],
    'javascript',
  );

  return {
    // In an untrusted workspace the only backend allowed is the sandboxed
    // in-webview engine: the other two start a process or open a socket.
    backend: trusted ? requestedBackend : 'javascript',
    javaPath: trusted ? trimmedString(config.get('render.javaPath')) : '',
    jarPath: trusted ? trimmedString(config.get('render.jarPath')) : '',
    jvmArguments: trusted ? stringArray(config.get('render.jvmArguments'), 64) : [],
    serverUrl: trusted ? trimmedString(config.get('render.serverUrl')) : '',
    allowRemoteServer: booleanValue(config.get('render.allowRemoteServer'), false),
    timeoutMs: numberInRange(config.get('render.timeoutMs'), 1_000, 600_000, 20_000),

    updateMode: enumValue<UpdateMode>(
      config.get('preview.updateMode'),
      ['live', 'onSave', 'manual'],
      'live',
    ),
    debounceMs: numberInRange(config.get('preview.debounceMs'), 0, 10_000, 400),
    theme: enumValue<ThemeMode>(config.get('preview.theme'), ['auto', 'light', 'dark'], 'auto'),
    scrollPreviewWithEditor: booleanValue(config.get('preview.scrollPreviewWithEditor'), true),
    doubleClickToSource: booleanValue(config.get('preview.doubleClickToSource'), true),
    zoomStep: numberInRange(config.get('preview.zoomStep'), 1.01, 4, 1.2),

    includeEnabled: booleanValue(config.get('include.enabled'), true),
    includePaths: trusted ? stringArray(config.get('include.paths'), 64) : [],
    includeMaxDepth: Math.round(numberInRange(config.get('include.maxDepth'), 0, 64, 10)),
    includeAllowOutsideWorkspace:
      trusted && booleanValue(config.get('include.allowOutsideWorkspace'), false),

    exportFormat: enumValue<ExportFormat>(config.get('export.format'), ['svg', 'png'], 'svg'),
    exportPngScale: numberInRange(config.get('export.pngScale'), 1, 8, 2),
    exportDirectory: trimmedString(config.get('export.directory')),

    diagnosticsEnabled: booleanValue(config.get('diagnostics.enabled'), true),
  };
}

/**
 * Resolves the folders an `!include` may read from.
 *
 * The document's own folder is always allowed — a diagram that includes a
 * sibling file is the common case and needs no configuration. Everything else
 * must be opted into through the workspace or `plantuml.include.paths`.
 */
export function resolveIncludeRoots(
  documentUri: vscode.Uri,
  config: PlantUmlConfiguration,
): { allowedRoots: string[]; searchPaths: string[] } {
  const allowedRoots = new Set<string>();
  const searchPaths: string[] = [];

  if (documentUri.scheme === 'file') {
    allowedRoots.add(path.dirname(documentUri.fsPath));
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
  const workspaceRoot =
    workspaceFolder?.uri.scheme === 'file' ? workspaceFolder.uri.fsPath : undefined;
  if (workspaceRoot !== undefined) {
    allowedRoots.add(workspaceRoot);
  }

  for (const entry of config.includePaths) {
    const resolved = path.isAbsolute(entry)
      ? path.resolve(entry)
      : workspaceRoot === undefined
        ? undefined
        : path.resolve(workspaceRoot, entry);
    if (resolved !== undefined) {
      allowedRoots.add(resolved);
      searchPaths.push(resolved);
    }
  }

  return { allowedRoots: [...allowedRoots], searchPaths };
}

// ---------------------------------------------------------------------------
// Value coercion
// ---------------------------------------------------------------------------

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function numberInRange(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

function trimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stringArray(value: unknown, maxItems: number): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim().length > 0) {
      out.push(item.trim());
    }
    if (out.length >= maxItems) {
      break;
    }
  }
  return out;
}
