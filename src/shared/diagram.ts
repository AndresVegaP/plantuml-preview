/**
 * Pure parsing of a PlantUML source file into its individual diagram blocks.
 *
 * This module deliberately has no dependency on the `vscode` module so it can
 * be unit-tested in a plain Node process.
 *
 * PlantUML delimits every diagram with a matching `@start<kind>` / `@end<kind>`
 * pair — `@startuml`/`@enduml`, `@startmindmap`/`@endmindmap`, `@startgantt`,
 * `@startsalt`, `@startjson`, and so on. A single file may hold several blocks;
 * the built-in Markdown preview shows one document, so we mirror that by
 * previewing one *selected* block at a time and letting the cursor pick it.
 */

/** A single `@start…`/`@end…` block found in a document. */
export interface DiagramBlock {
  /** Zero-based position of this block among all blocks in the document. */
  readonly index: number;
  /** The delimiter kind, lower-cased and without the `@start` prefix (`uml`, `mindmap`, …). */
  readonly kind: string;
  /** Optional name given as `@startuml <name>`; PlantUML uses it as the output file name. */
  readonly name: string | undefined;
  /** First `title …` line inside the block, if any. */
  readonly title: string | undefined;
  /** Zero-based line of the `@start…` delimiter. */
  readonly startLine: number;
  /** Zero-based line of the `@end…` delimiter, or the last line when unterminated. */
  readonly endLine: number;
  /** Full block text, delimiters included, joined with `\n`. */
  readonly text: string;
  /**
   * True when the document contained no delimiters at all and the whole file is
   * treated as one implicit diagram.
   */
  readonly implicit: boolean;
  /** True when a `@start…` was found but its `@end…` was missing. */
  readonly unterminated: boolean;
}

const START_DELIMITER = /^[\t ]*@start([a-z][a-z0-9_]*)\b[\t ]*(.*)$/i;
const END_DELIMITER = /^[\t ]*@end([a-z][a-z0-9_]*)\b/i;
const TITLE_LINE = /^[\t ]*title[\t ]+(\S.*?)[\t ]*$/i;

/** Splits text into lines while tolerating CRLF, LF and lone CR endings. */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/u);
}

/**
 * Extracts every diagram block from a document.
 *
 * When the document has no delimiters the entire content is returned as a
 * single implicit block, matching the behaviour users expect from a scratch
 * file that only holds diagram body lines.
 */
export function parseDiagrams(text: string): readonly DiagramBlock[] {
  const lines = splitLines(text);
  const blocks: DiagramBlock[] = [];

  let openKind: string | undefined;
  let openName: string | undefined;
  let openStart = 0;

  for (let line = 0; line < lines.length; line++) {
    const raw = lines[line] ?? '';

    if (openKind === undefined) {
      const start = START_DELIMITER.exec(raw);
      if (start) {
        openKind = (start[1] ?? '').toLowerCase();
        openName = normaliseName(start[2]);
        openStart = line;
      }
      continue;
    }

    // PlantUML pairs delimiters by kind, but real-world files frequently mix
    // `@startuml`/`@end…` variants. Accepting any `@end…` keeps such files
    // usable while still refusing to swallow the rest of the document.
    if (END_DELIMITER.test(raw)) {
      blocks.push(buildBlock(blocks.length, openKind, openName, openStart, line, lines, false));
      openKind = undefined;
      openName = undefined;
    }
  }

  if (openKind !== undefined) {
    blocks.push(
      buildBlock(blocks.length, openKind, openName, openStart, lines.length - 1, lines, true),
    );
  }

  if (blocks.length === 0) {
    if (text.trim().length === 0) {
      return [];
    }
    return [
      {
        index: 0,
        kind: 'uml',
        name: undefined,
        title: findTitle(lines, 0, lines.length - 1),
        startLine: 0,
        endLine: Math.max(0, lines.length - 1),
        text,
        implicit: true,
        unterminated: false,
      },
    ];
  }

  return blocks;
}

function buildBlock(
  index: number,
  kind: string,
  name: string | undefined,
  startLine: number,
  endLine: number,
  lines: readonly string[],
  unterminated: boolean,
): DiagramBlock {
  return {
    index,
    kind,
    name,
    title: findTitle(lines, startLine, endLine),
    startLine,
    endLine,
    text: lines.slice(startLine, endLine + 1).join('\n'),
    implicit: false,
    unterminated,
  };
}

function normaliseName(rest: string | undefined): string | undefined {
  const value = (rest ?? '').trim();
  return value.length > 0 ? value : undefined;
}

function findTitle(
  lines: readonly string[],
  startLine: number,
  endLine: number,
): string | undefined {
  for (let line = startLine; line <= endLine && line < lines.length; line++) {
    const match = TITLE_LINE.exec(lines[line] ?? '');
    if (match) {
      return match[1];
    }
  }
  return undefined;
}

/**
 * Returns the block that contains `line`, or — when the cursor sits between
 * blocks — the closest block above it, falling back to the first block.
 *
 * Used to keep the preview in sync with the cursor in multi-diagram files.
 */
export function diagramAtLine(
  blocks: readonly DiagramBlock[],
  line: number,
): DiagramBlock | undefined {
  if (blocks.length === 0) {
    return undefined;
  }
  let candidate: DiagramBlock | undefined;
  for (const block of blocks) {
    if (line >= block.startLine && line <= block.endLine) {
      return block;
    }
    if (block.startLine <= line) {
      candidate = block;
    }
  }
  return candidate ?? blocks[0];
}

/**
 * Produces a stable, human-meaningful label for a block, used in the diagram
 * picker, the preview title and export file names.
 */
export function diagramLabel(block: DiagramBlock, fallback: string): string {
  const raw =
    block.name ?? block.title ?? (block.implicit ? fallback : `${fallback}-${block.index + 1}`);
  return sanitiseLabel(raw, fallback);
}

/**
 * Characters that must never reach a file name: Unicode control and format
 * characters (`\p{Cc}` / `\p{Cf}`, which covers NUL and the bidi overrides used
 * in extension-spoofing attacks), the punctuation Windows reserves, and both
 * path separators.
 */
const ILLEGAL_FILENAME_CHARS = /[\p{Cc}\p{Cf}<>:"'`|?*\\/]/gu;

/** Reserved DOS device names that cannot be used as a file name on Windows. */
const RESERVED_WINDOWS_NAMES = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu;

/**
 * Strips characters that are illegal in file names on Windows, macOS and Linux,
 * so a diagram name taken from untrusted document content can never escape the
 * chosen export directory or collide with a DOS device name.
 */
export function sanitiseLabel(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(ILLEGAL_FILENAME_CHARS, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[. ]+$/u, '');
  if (cleaned.length === 0 || cleaned === '.' || cleaned === '..') {
    return fallback;
  }
  const bounded = cleaned.length > 120 ? cleaned.slice(0, 120).trimEnd() : cleaned;
  return RESERVED_WINDOWS_NAMES.test(bounded) ? `_${bounded}` : bounded;
}

/**
 * Ensures the text handed to a renderer is a complete diagram.
 *
 * An implicit block (a file with no delimiters) is wrapped so the backend sees
 * well-formed input instead of reporting a confusing "no @startuml found".
 */
export function toRenderableSource(block: DiagramBlock): string {
  if (!block.implicit) {
    return block.text;
  }
  return `@startuml\n${block.text.replace(/\s+$/u, '')}\n@enduml`;
}
