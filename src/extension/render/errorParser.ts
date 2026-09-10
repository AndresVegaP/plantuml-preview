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

/** Markers that identify PlantUML's rendered error image. */
const ERROR_IMAGE_MARKERS: readonly string[] = [
  'Syntax Error?',
  'Cannot find Graphviz',
  'Dot Executable',
  'An error has occured',
  'An error has occurred',
];

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
  if (!ERROR_IMAGE_MARKERS.some((marker) => svg.includes(marker))) {
    return undefined;
  }

  const texts = extractTextNodes(svg);
  const line = findLineNumber(texts.join('\n'));

  // The most useful sentence is the one after the "Syntax Error?" banner: it
  // names what PlantUML could not understand.
  const bannerIndex = texts.findIndex((text) =>
    ERROR_IMAGE_MARKERS.some((marker) => text.includes(marker)),
  );
  const detail = texts
    .slice(bannerIndex + 1)
    .find((text) => text.length > 0 && !/^\d+$/u.test(text));

  const banner = bannerIndex >= 0 ? texts[bannerIndex] : undefined;
  const message =
    detail !== undefined && detail !== banner
      ? `${banner ?? 'Diagram error'}: ${detail}`
      : (banner ?? 'The diagram could not be rendered.');

  return line === undefined ? { message } : { message, line };
}

function findLineNumber(text: string): number | undefined {
  for (const pattern of LINE_PATTERNS) {
    const match = pattern.exec(text);
    const captured = match?.[1];
    if (captured !== undefined) {
      const value = Number.parseInt(captured, 10);
      // PlantUML counts from 1; the rest of the extension counts from 0.
      if (Number.isFinite(value) && value >= 1) {
        return value - 1;
      }
    }
  }
  return undefined;
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
    const raw = (match[1] ?? '').replace(/<[^>]*>/gu, '');
    const decoded = decodeBasicEntities(raw).replace(/\s+/gu, ' ').trim();
    if (decoded.length > 0) {
      out.push(decoded);
    }
    if (out.length >= 100) {
      break;
    }
  }
  return out;
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
