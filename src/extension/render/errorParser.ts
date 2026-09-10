/**
 * Turning backend failure output into something actionable.
 *
 * PlantUML reports a syntax error in two different ways depending on how it is
 * driven: as text on stderr, and — always — as a rendered "error diagram" that
 * would otherwise be shown to the user as if it were their diagram. Both forms
 * are decoded here so the preview can show a real message and the Problems
 * panel can point at the offending line.
 */

/** A failure recovered from backend output. */
export interface ParsedRenderError {
  readonly message: string;
  /** 0-based line within the rendered source, when the backend named one. */
  readonly line?: number;
}

/**
 * Patterns PlantUML uses to name the failing line.
 *
 * Ordered from most to least specific; the first match wins.
 */
const LINE_PATTERNS: readonly RegExp[] = [
  /\berror\s+line\s+(\d+)\s+in\s+file\b/iu,
  /\berror\s+line\s+(\d+)\b/iu,
  /\bat\s+line\s+(\d+)\b/iu,
  /\bline\s+(\d+)\s*:/iu,
  /\(line\s+(\d+)\)/iu,
];

/**
 * The location header of PlantUML's error report, as in
 * `[From textarea (line 3) ]`.
 *
 * PlantUML prints it above every error it can place in the source — "Syntax
 * Error?", "Fatal parsing error" and the rest — and an ordinary diagram never
 * contains it, even one whose own labels say "Syntax Error?". That makes it a
 * far better signal than the wording of any particular error. It must match a
 * whole text node: the report goes on to echo the user's source, and a line of
 * that source saying "retry at line 7" is not the location.
 */
const REPORT_HEADER = /^\[From\s.*\(line\s+(\d+)\)\s*\]$/u;

/**
 * The first line of a failure PlantUML draws without a location header:
 * PlantUML or Graphviz crashing ("An error has occurred!", "An error has
 * occurred : java.lang…", spelt "occured" by older releases), and a missing
 * Graphviz ("Dot Executable: /usr/bin/dot").
 *
 * The wording is only half of the test; see {@link parseBanner}.
 */
const BANNER_LINE = /^(?:An error has occurr?ed|Dot Executable|Cannot find Graphviz)\b/u;

/** Substrings that let an ordinary diagram skip the banner check entirely. */
const BANNER_HINTS: readonly string[] = ['An error has occur', 'Dot Executable', 'Cannot find Graphviz'];

/** The elements a diagram draws its boxes, lines and arrows with. */
const SHAPE_ELEMENTS: ReadonlySet<string> = new Set([
  'rect',
  'line',
  'path',
  'polygon',
  'polyline',
  'ellipse',
  'circle',
]);

const UNKNOWN_FAILURE = 'The diagram could not be rendered.';

/**
 * Extracts a failure description from a backend's textual output.
 *
 * Returns `undefined` when the output does not look like an error at all.
 */
export function parseErrorText(output: string): ParsedRenderError | undefined {
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const line = findLineNumber(trimmed);
  // Prefer the first line that actually says something; PlantUML's report
  // format puts the human-readable summary first and context after it.
  const firstMeaningful =
    trimmed
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .find((entry) => entry.length > 0) ?? trimmed;

  return line === undefined
    ? { message: firstMeaningful }
    : { message: firstMeaningful, line };
}

/**
 * Detects PlantUML's rendered error image and recovers its text.
 *
 * This matters because the error image is a perfectly valid SVG: without this
 * check the preview would cheerfully display "Syntax Error?" as though the
 * render had succeeded, and the Problems panel would stay empty.
 */
export function parseErrorImage(svg: string): ParsedRenderError | undefined {
  // Every rendered diagram passes through here, so an ordinary one is turned
  // away by substring checks before anything else is examined.
  const mayBeReport = svg.includes('[From ');
  const mayBeBanner = BANNER_HINTS.some((hint) => svg.includes(hint));
  if (!mayBeReport && !mayBeBanner) {
    return undefined;
  }

  const report = mayBeReport ? parseErrorReport(extractTextNodes(svg)) : undefined;
  if (report !== undefined) {
    return report;
  }
  return mayBeBanner ? parseBanner(svg) : undefined;
}

/**
 * Reads PlantUML's error report: the location header, then the source echoed
 * up to the failing line, then the error itself.
 */
function parseErrorReport(texts: readonly string[]): ParsedRenderError | undefined {
  for (const [index, text] of texts.entries()) {
    const captured = REPORT_HEADER.exec(text)?.[1];
    if (captured === undefined) {
      continue;
    }
    const last = texts[texts.length - 1];
    const message = index < texts.length - 1 && last !== undefined ? last : UNKNOWN_FAILURE;
    const line = toZeroBased(captured);
    return line === undefined ? { message } : { message, line };
  }
  return undefined;
}

/**
 * Reads a failure that PlantUML announces with a banner instead of a location.
 *
 * The words prove nothing on their own: "An error has occurred" is a perfectly
 * good label for an arrow. The page they are printed on does. PlantUML writes
 * these reports as bare lines of text, banner first, with no boxes, lines or
 * arrows. A diagram using the same words draws shapes around them or, when it
 * is nothing but a title, puts that title in a group of its own.
 */
function parseBanner(svg: string): ParsedRenderError | undefined {
  const opening = openingLineOfTextPage(svg);
  return opening !== undefined && BANNER_LINE.test(opening) ? { message: opening } : undefined;
}

/**
 * Returns the first line of an image that is only a page of text: it draws no
 * shapes, and that line is not nested in a group of its own.
 */
function openingLineOfTextPage(svg: string): string | undefined {
  const tags = /<(\/?)([a-z][\w:-]*)[^>]*?(\/?)>/giu;
  let depth = 0;
  let opening: string | undefined;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(svg)) !== null) {
    const closing = match[1] === '/';
    const name = (match[2] ?? '').toLowerCase();
    const selfClosing = match[3] === '/';
    if (SHAPE_ELEMENTS.has(name)) {
      return undefined;
    }
    if (name === 'g' && !selfClosing) {
      depth += closing ? -1 : 1;
    } else if (name === 'text' && !closing && !selfClosing && opening === undefined) {
      const end = svg.indexOf('</text>', tags.lastIndex);
      const line = end === -1 ? '' : readText(svg.slice(tags.lastIndex, end));
      if (line.length > 0) {
        // The outermost group is the page itself; a line inside a deeper group
        // belongs to an element of a diagram.
        if (depth > 1) {
          return undefined;
        }
        opening = line;
      }
    }
  }
  return opening;
}

function findLineNumber(text: string): number | undefined {
  for (const pattern of LINE_PATTERNS) {
    const captured = pattern.exec(text)?.[1];
    const line = captured === undefined ? undefined : toZeroBased(captured);
    if (line !== undefined) {
      return line;
    }
  }
  return undefined;
}

/** PlantUML counts lines from 1; the rest of the extension counts from 0. */
function toZeroBased(captured: string): number | undefined {
  const value = Number.parseInt(captured, 10);
  return Number.isFinite(value) && value >= 1 ? value - 1 : undefined;
}

/**
 * Pulls the text content out of `<text>` and `<tspan>` nodes.
 *
 * A deliberately small, allocation-light scan: this runs on every failed render
 * and never needs to understand the SVG, only to read its words.
 */
function extractTextNodes(svg: string): string[] {
  const out: string[] = [];
  const pattern = /<(?:text|tspan)\b[^>]*>([\s\S]*?)<\/(?:text|tspan)>/giu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(svg)) !== null) {
    const text = readText(match[1] ?? '');
    if (text.length > 0) {
      out.push(text);
    }
    if (out.length >= 100) {
      break;
    }
  }
  return out;
}

/** The words of a text node: markup stripped, entities decoded, spacing collapsed. */
function readText(markup: string): string {
  return decodeBasicEntities(markup.replace(/<[^>]*>/gu, '')).replace(/\s+/gu, ' ').trim();
}

function decodeBasicEntities(value: string): string {
  return value
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#(\d+);/gu, (_match, code: string) => {
      const point = Number.parseInt(code, 10);
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : _match;
    })
    .replace(/&amp;/gu, '&');
}
