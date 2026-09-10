/**
 * Resolution of PlantUML `!include` directives.
 *
 * ## Why the extension does this instead of the renderer
 *
 * The default renderer is the PlantUML JavaScript engine, which runs inside the
 * preview webview and therefore has no file system at all. Rather than give the
 * webview file access — the single change most likely to turn a diagram
 * previewer into a file-disclosure bug — the host inlines includes *before*
 * handing the source over. The webview only ever sees text.
 *
 * That choice also fixes a real problem with the `jar` backend: `plantuml.jar`
 * reading from stdin has no notion of "the folder the document lives in", so
 * relative includes silently fail there.
 *
 * ## Containment
 *
 * A `.puml` file is untrusted. `!include ../../../../../.ssh/id_rsa` must not
 * put a private key on screen. Every resolved path is therefore checked against
 * an explicit set of allowed roots, and remote includes are refused outright
 * rather than fetched.
 */

import * as path from 'node:path';

import { parseDiagrams, splitLines } from '../../shared/diagram.js';

/** Reads a file as text, or returns `undefined` when it cannot be read. */
export type ReadTextFile = (absolutePath: string) => Promise<string | undefined>;

export interface IncludeOptions {
  /** Absolute path of the document being previewed. */
  readonly documentPath: string;
  /** Absolute directories that includes may read from. */
  readonly allowedRoots: readonly string[];
  /** Additional directories searched when a relative include is not found. */
  readonly searchPaths: readonly string[];
  /** Maximum nesting depth before the resolver gives up. */
  readonly maxDepth: number;
  /** When true, containment is not enforced (opt-in, off by default). */
  readonly allowOutsideRoots: boolean;
  /** Upper bound on the combined size of all inlined text, in characters. */
  readonly maxTotalChars: number;
}

/** A problem encountered while inlining, surfaced as a diagnostic. */
export interface IncludeProblem {
  /** Line in the *original* document where the directive appeared, 0-based. */
  readonly line: number;
  readonly directive: string;
  readonly reason: string;
  readonly severity: 'error' | 'warning';
}

export interface IncludeResult {
  /** Source with every resolvable local include inlined. */
  readonly text: string;
  /** Files that were read, so the caller can watch them for changes. */
  readonly includedFiles: readonly string[];
  readonly problems: readonly IncludeProblem[];
  /**
   * Maps each line of {@link text} back to a line of the original source.
   *
   * Inlining shifts every line below an `!include`, so without this a renderer
   * reporting "error on line 42" would highlight the wrong place — or a place
   * that no longer exists. Lines that came from an included file are attributed
   * to the `!include` directive that pulled them in, which is the closest thing
   * to a meaningful location in the file the user is actually editing.
   */
  readonly lineMap: readonly number[];
}

/**
 * Matches the include family of preprocessor directives.
 *
 * PlantUML accepts `!include`, `!include_once`, `!include_many`, `!includesub`,
 * `!includedef` and `!includeurl`, optionally preceded by whitespace.
 */
const INCLUDE_DIRECTIVE =
  /^([\t ]*)!(include_once|include_many|includesub|includedef|includeurl|include)[\t ]+(.+?)[\t ]*$/i;

/** A URL-shaped include target, which is never fetched. */
const REMOTE_TARGET = /^[a-z][a-z0-9+.-]*:\/\//iu;

/**
 * Standard-library includes such as `!include <C4/C4_Container>`.
 *
 * These resolve inside the PlantUML engine itself, so they are passed through
 * untouched rather than looked for on disk.
 */
const STDLIB_TARGET = /^<.+>$/u;

/**
 * Inlines the include graph rooted at `text`.
 *
 * The function never throws: unreadable, forbidden and circular includes are
 * reported as problems and the directive is replaced with a comment, so the
 * user still gets a preview of everything that *did* resolve.
 */
export async function resolveIncludes(
  text: string,
  options: IncludeOptions,
  readFile: ReadTextFile,
): Promise<IncludeResult> {
  const problems: IncludeProblem[] = [];
  const includedFiles = new Set<string>();
  /** Files already inlined on the current branch, for cycle detection. */
  const activeStack: string[] = [path.resolve(options.documentPath)];
  /** Targets of `!include_once`, which must not be inlined twice. */
  const onceSeen = new Set<string>();
  const budget = { remaining: options.maxTotalChars };

  const output = await expand(
    text,
    path.dirname(path.resolve(options.documentPath)),
    0,
    /* rootLine */ 0,
    /* trackLines */ true,
  );

  return {
    text: output.lines.join('\n'),
    includedFiles: [...includedFiles],
    problems,
    lineMap: output.map,
  };

  async function expand(
    source: string,
    baseDir: string,
    depth: number,
    rootLineOffset: number,
    trackLines: boolean,
  ): Promise<{ lines: string[]; map: number[] }> {
    const lines = splitLines(source);
    const out: string[] = [];
    const map: number[] = [];
    /** Records a line together with the source line it should be blamed on. */
    const emit = (line: string, origin: number): void => {
      out.push(line);
      map.push(origin);
    };

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i] ?? '';
      const origin = trackLines ? i : rootLineOffset;
      const match = INCLUDE_DIRECTIVE.exec(raw);
      if (match === null) {
        emit(raw, origin);
        continue;
      }

      const indent = match[1] ?? '';
      const keyword = (match[2] ?? '').toLowerCase();
      const target = stripInlineComment(match[3] ?? '');
      // Problems are only anchored to real document lines for the top-level
      // file; inside an included file the numbers would not map to anything
      // the user can click, so they are attributed to the directive itself.
      const reportLine = origin;

      if (STDLIB_TARGET.test(target)) {
        emit(raw, origin);
        continue;
      }

      if (keyword === 'includeurl' || REMOTE_TARGET.test(target)) {
        problems.push({
          line: reportLine,
          directive: raw.trim(),
          reason:
            'Remote includes are not fetched by the preview. Download the file and include it by path instead.',
          severity: 'warning',
        });
        emit(`${indent}' [preview] remote include skipped: ${sanitiseForComment(target)}`, origin);
        continue;
      }

      if (depth >= options.maxDepth) {
        problems.push({
          line: reportLine,
          directive: raw.trim(),
          reason: `Include nesting is deeper than ${options.maxDepth} levels; stopping here.`,
          severity: 'error',
        });
        emit(`${indent}' [preview] include depth limit reached`, origin);
        continue;
      }

      const { filePart, selector } = splitSelector(target);
      const candidates = resolveTargetPaths(filePart, baseDir, options);
      if (candidates.length === 0) {
        problems.push({
          line: reportLine,
          directive: raw.trim(),
          reason: options.allowOutsideRoots
            ? `Could not resolve "${filePart}".`
            : `"${filePart}" is outside the workspace and the configured include paths. ` +
              'Add its folder to plantuml.include.paths, or enable plantuml.include.allowOutsideWorkspace.',
          severity: 'error',
        });
        emit(`${indent}' [preview] include not allowed: ${sanitiseForComment(filePart)}`, origin);
        continue;
      }

      // Each allowed location is tried in order, so `plantuml.include.paths`
      // acts as a real search path rather than only as a permission list.
      let resolved: string | undefined;
      let content: string | undefined;
      for (const candidate of candidates) {
        const attempt = await readFile(candidate);
        if (attempt !== undefined) {
          resolved = candidate;
          content = attempt;
          break;
        }
      }

      if (resolved === undefined || content === undefined) {
        problems.push({
          line: reportLine,
          directive: raw.trim(),
          reason:
            candidates.length === 1
              ? `Could not read "${candidates[0] ?? filePart}".`
              : `Could not find "${filePart}" in any of: ${candidates.join(', ')}.`,
          severity: 'error',
        });
        emit(`${indent}' [preview] include not found: ${sanitiseForComment(filePart)}`, origin);
        continue;
      }

      if (activeStack.includes(resolved)) {
        problems.push({
          line: reportLine,
          directive: raw.trim(),
          reason: `Circular include: "${path.basename(resolved)}" already includes this file.`,
          severity: 'error',
        });
        emit(`${indent}' [preview] circular include skipped`, origin);
        continue;
      }

      const onceKey = `${keyword === 'include_once' ? 'once' : 'any'}:${resolved}:${selector ?? ''}`;
      if (keyword === 'include_once' && onceSeen.has(onceKey)) {
        continue;
      }
      onceSeen.add(onceKey);

      includedFiles.add(resolved);

      const selected = selectSection(content, selector);
      if (selected === undefined) {
        problems.push({
          line: reportLine,
          directive: raw.trim(),
          reason: `"${path.basename(resolved)}" has no section "${selector ?? ''}".`,
          severity: 'error',
        });
        emit(`${indent}' [preview] include section not found`, origin);
        continue;
      }

      if (selected.length > budget.remaining) {
        problems.push({
          line: reportLine,
          directive: raw.trim(),
          reason: 'Included files exceed the size limit for a single preview.',
          severity: 'error',
        });
        emit(`${indent}' [preview] include size limit reached`, origin);
        continue;
      }
      budget.remaining -= selected.length;

      activeStack.push(resolved);
      const expanded = await expand(
        selected,
        path.dirname(resolved),
        depth + 1,
        reportLine,
        /* trackLines */ false,
      );
      activeStack.pop();

      for (let k = 0; k < expanded.lines.length; k++) {
        const line = expanded.lines[k] ?? '';
        emit(indent.length > 0 ? indent + line : line, expanded.map[k] ?? origin);
      }
    }

    return { lines: out, map };
  }
}

/**
 * Splits `file.puml!section` into its two halves.
 *
 * Windows paths contain no `!`, so splitting on the last one is unambiguous.
 */
function splitSelector(target: string): { filePart: string; selector: string | undefined } {
  const unquoted = unquote(target);
  const bang = unquoted.lastIndexOf('!');
  if (bang <= 0) {
    return { filePart: unquoted, selector: undefined };
  }
  return { filePart: unquoted.slice(0, bang), selector: unquoted.slice(bang + 1) };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * Strips a trailing PlantUML line comment from a directive argument.
 *
 * Only an unquoted `'` that follows whitespace starts a comment, so a file name
 * that legitimately contains an apostrophe still resolves.
 */
function stripInlineComment(value: string): string {
  const match = /^(.*?)(?:\s+'.*)?$/u.exec(value);
  return (match?.[1] ?? value).trim();
}

/**
 * Turns an include target into the absolute paths it may legitimately refer to.
 *
 * The document's own folder comes first, then each configured include path, so
 * a local file always wins over a shared one of the same name. Locations that
 * fail containment are dropped here rather than later, so a forbidden path is
 * never even opened.
 *
 * An empty result means "not allowed anywhere", which the caller reports
 * differently from "allowed but missing".
 */
export function resolveTargetPaths(
  target: string,
  baseDir: string,
  options: Pick<IncludeOptions, 'searchPaths' | 'allowedRoots' | 'allowOutsideRoots'>,
): string[] {
  if (target.length === 0) {
    return [];
  }

  const candidates: string[] = [];
  if (path.isAbsolute(target)) {
    candidates.push(path.resolve(target));
  } else {
    candidates.push(path.resolve(baseDir, target));
    for (const searchPath of options.searchPaths) {
      candidates.push(path.resolve(searchPath, target));
    }
  }

  const allowed = candidates.filter(
    (candidate) => options.allowOutsideRoots || isContained(candidate, options.allowedRoots),
  );
  return [...new Set(allowed)];
}

/**
 * True when `candidate` lies inside one of `roots`.
 *
 * The comparison is done on resolved paths with a trailing separator so that
 * `/srcx` is not treated as living inside `/src`, and case-insensitively on
 * Windows where the file system is.
 */
export function isContained(candidate: string, roots: readonly string[]): boolean {
  const normalise = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };

  const target = normalise(candidate);
  for (const root of roots) {
    const base = normalise(root);
    if (target === base) {
      return true;
    }
    const withSeparator = base.endsWith(path.sep) ? base : base + path.sep;
    if (target.startsWith(withSeparator)) {
      return true;
    }
  }
  return false;
}

/**
 * Extracts the part of an included file that the directive asked for.
 *
 * With no selector the whole file is used, minus its `@start…`/`@end…`
 * delimiters — PlantUML drops those when inlining, and leaving them in would
 * nest one diagram inside another.
 */
export function selectSection(content: string, selector: string | undefined): string | undefined {
  if (selector === undefined || selector.length === 0) {
    return stripDelimiters(content);
  }

  // A numeric selector picks the n-th diagram block in the file.
  if (/^\d+$/u.test(selector)) {
    const blocks = parseDiagrams(content);
    const block = blocks[Number.parseInt(selector, 10)];
    return block === undefined ? undefined : stripDelimiters(block.text);
  }

  // A named selector picks a `!startsub NAME` … `!endsub` section.
  const lines = splitLines(content);
  const startPattern = new RegExp(`^[\\t ]*!startsub[\\t ]+${escapeRegExp(selector)}[\\t ]*$`, 'iu');
  const endPattern = /^[\t ]*!endsub\b/iu;

  const collected: string[] = [];
  let inside = false;
  let found = false;
  for (const line of lines) {
    if (!inside) {
      if (startPattern.test(line)) {
        inside = true;
        found = true;
      }
      continue;
    }
    if (endPattern.test(line)) {
      inside = false;
      continue;
    }
    collected.push(line);
  }

  return found ? collected.join('\n') : undefined;
}

function stripDelimiters(content: string): string {
  return splitLines(content)
    .filter((line) => !/^[\t ]*@(?:start|end)[a-z][a-z0-9_]*\b/iu.test(line))
    .join('\n');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Makes a rejected target safe to echo back into the diagram source.
 *
 * Without this, a crafted include path could inject PlantUML syntax through the
 * comment we substitute for it.
 */
function sanitiseForComment(value: string): string {
  const collapsed = value.replace(/[\r\n]+/gu, ' ').replace(/[@!]/gu, '_');
  return collapsed.length > 200 ? `${collapsed.slice(0, 200)}…` : collapsed;
}
