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
 * Error?", "Fatal parsing error" and the rest — which makes it a far better
 * signal than the wording of any particular error. Like a banner's, its words
 * are only half of the test, because a diagram can quote them; see
 * {@link parseErrorReport}. It must match a whole text node: the report goes on
 * to echo the user's source, and a line of that source saying "retry at line 7"
 * is not the location.
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

/** A tag's `y` attribute: the baseline of a line of text, the top of a rectangle. */
const Y_ATTRIBUTE = /\sy="([^"]*)"/u;

/** A tag's `height` attribute. */
const HEIGHT_ATTRIBUTE = /\sheight="([^"]*)"/u;

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

  const page = readPage(svg);
  const report = mayBeReport ? parseErrorReport(page) : undefined;
  if (report !== undefined) {
    return report;
  }
  return mayBeBanner ? parseBanner(page) : undefined;
}

/**
 * Reads PlantUML's error report: the location header, then the source echoed
 * up to the failing line, then the error itself.
 *
 * The header is recognised by where it is printed. PlantUML puts it on a bar of
 * its own, straight on a page that draws nothing but rectangles, and carries on
 * with the report below that bar. A diagram quoting the same words draws lines
 * and arrows around them, puts them in a group of its own, or prints them
 * without a bar; a box whose text opens with them keeps the rest of that text
 * inside the box.
 */
function parseErrorReport(page: Page): ParsedRenderError | undefined {
  if ([...page.shapes].some((shape) => shape !== 'rect')) {
    return undefined;
  }
  for (const [index, header] of page.lines.entries()) {
    const captured = REPORT_HEADER.exec(header.text)?.[1];
    const bar = header.barBottom;
    if (captured === undefined || header.nested || bar === undefined) {
      continue;
    }
    const error = page.lines
      .slice(index + 1)
      .filter((line) => line.y > bar)
      .at(-1);
    if (error === undefined) {
      continue;
    }
    const line = toZeroBased(captured);
    return line === undefined ? { message: error.text } : { message: error.text, line };
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
function parseBanner(page: Page): ParsedRenderError | undefined {
  const opening = page.lines[0];
  if (page.shapes.size > 0 || opening === undefined || opening.nested) {
    return undefined;
  }
  return BANNER_LINE.test(opening.text) ? { message: opening.text } : undefined;
}

/** A line of text, where an image puts it. */
interface PageLine {
  readonly text: string;
  /** The baseline; `NaN` when the image does not give one. */
  readonly y: number;
  /**
   * Whether the line sits in a group of its own. The outermost group is the
   * page itself; a line inside a deeper group belongs to an element of a diagram.
   */
  readonly nested: boolean;
  /** The bottom edge of a rectangle drawn immediately before the line, if one was. */
  readonly barBottom?: number;
}

/** An image read as a page: its lines of text and the kinds of shape around them. */
interface Page {
  readonly lines: readonly PageLine[];
  readonly shapes: ReadonlySet<string>;
}

/**
 * Reads the lines of text of an image and the shapes it draws.
 *
 * A deliberately small scan: it only runs on images that mention a failure, and
 * it never needs to understand the SVG, only to follow its groups and read its
 * words.
 */
function readPage(svg: string): Page {
  const tags = /<(\/?)([a-z][\w:-]*)([^>]*?)(\/?)>/giu;
  const lines: PageLine[] = [];
  const shapes = new Set<string>();
  let depth = 0;
  let barBottom: number | undefined;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(svg)) !== null) {
    const name = (match[2] ?? '').toLowerCase();
    if (match[1] === '/') {
      if (name === 'g') {
        depth -= 1;
      }
      continue;
    }
    const attributes = match[3] ?? '';
    const selfClosing = match[4] === '/';
    if (name === 'text' && !selfClosing) {
      const end = svg.indexOf('</text>', tags.lastIndex);
      const text = end === -1 ? '' : readText(svg.slice(tags.lastIndex, end));
      if (text.length > 0) {
        lines.push({
          text,
          y: readNumber(attributes, Y_ATTRIBUTE),
          nested: depth > 1,
          ...(barBottom === undefined ? {} : { barBottom }),
        });
      }
    } else if (name === 'g' && !selfClosing) {
      depth += 1;
    } else if (SHAPE_ELEMENTS.has(name)) {
      shapes.add(name);
    }
    barBottom =
      name === 'rect'
        ? readNumber(attributes, Y_ATTRIBUTE) + readNumber(attributes, HEIGHT_ATTRIBUTE)
        : undefined;
  }
  return { lines, shapes };
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

/** A numeric attribute of a tag; `NaN` when the tag does not give it. */
function readNumber(attributes: string, attribute: RegExp): number {
  const value = attribute.exec(attributes)?.[1];
  return value === undefined ? Number.NaN : Number.parseFloat(value);
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
