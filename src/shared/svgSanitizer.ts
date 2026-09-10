/**
 * A fail-closed SVG sanitiser.
 *
 * ## Why this exists
 *
 * A `.puml` file is untrusted input. PlantUML faithfully turns parts of it into
 * SVG constructs that carry real capability: `[[https://…]]` becomes an `<a>`,
 * `<img:…>` becomes an `<image>`, and a hostile file can try to smuggle
 * `<script>`, `<foreignObject><iframe>`, `javascript:` hrefs or CSS `@import`
 * into the markup we are about to inject into a webview DOM.
 *
 * The webview's Content-Security-Policy already blocks script execution and all
 * remote loads. This module is the second, independent layer: even if the CSP
 * were mis-authored or relaxed by a future change, the markup that reaches the
 * DOM contains nothing dangerous in the first place.
 *
 * ## Design
 *
 * The sanitiser is a small, self-contained XML tokeniser plus strict
 * allow-lists. It never uses a DOM, so it is a pure function that runs in the
 * extension host and is unit-testable in a plain Node process.
 *
 * It is **fail-closed**: any input it cannot parse with certainty is rejected
 * outright rather than passed through. Rejecting a diagram is a visible,
 * recoverable annoyance; passing through markup we did not understand is not.
 */

import { err, ok, type Result } from './result.js';

/** Upper bound on the SVG we are willing to parse, to bound worst-case work. */
const MAX_INPUT_BYTES = 32 * 1024 * 1024;

/**
 * Elements that may appear in sanitised output.
 *
 * Notably absent: `script`, `foreignObject`, `switch`, `feImage`, `animate*`
 * and `set`. The first two execute code, `switch` is a common allow-list
 * bypass, `feImage` fetches external references, and the animation elements can
 * retarget an attribute (including `href`) after sanitisation.
 */
const ALLOWED_ELEMENTS: ReadonlySet<string> = new Set([
  'svg',
  'g',
  'defs',
  'symbol',
  'use',
  'title',
  'desc',
  'style',
  'a',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'textpath',
  'image',
  'marker',
  'lineargradient',
  'radialgradient',
  'stop',
  'pattern',
  'clippath',
  'mask',
  'filter',
  'fegaussianblur',
  'feoffset',
  'feblend',
  'fecolormatrix',
  'fecomposite',
  'feflood',
  'femerge',
  'femergenode',
  'fedropshadow',
  'femorphology',
  'fetile',
  'feturbulence',
  'fedisplacementmap',
  'fefunca',
  'fefuncr',
  'fefuncg',
  'fefuncb',
  'fecomponenttransfer',
]);

/**
 * Elements whose entire subtree is discarded.
 *
 * Everything else that is merely unknown is *unwrapped* (children kept), which
 * preserves layout when PlantUML emits a construct we have not catalogued.
 * These, by contrast, are dropped whole because their children are the payload.
 */
const DROP_SUBTREE_ELEMENTS: ReadonlySet<string> = new Set([
  'script',
  'foreignobject',
  'iframe',
  'object',
  'embed',
  'video',
  'audio',
  'canvas',
  'animate',
  'animatemotion',
  'animatetransform',
  'set',
  'handler',
  'listener',
  'feimage',
  'metadata',
]);

/** Elements whose content is raw text rather than markup. */
const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set(['style', 'script']);

/**
 * Canonical spelling for the camel-cased SVG element names.
 *
 * SVG is XML, so names are **case-sensitive**: `<linearGradient>` is an element
 * and `<lineargradient>` is not. The sanitiser matches case-insensitively — a
 * hostile document must not evade an allow-list by changing case — but it has
 * to emit the correct spelling or the browser silently ignores the element.
 */
const CANONICAL_ELEMENTS: ReadonlyMap<string, string> = new Map([
  ['clippath', 'clipPath'],
  ['lineargradient', 'linearGradient'],
  ['radialgradient', 'radialGradient'],
  ['textpath', 'textPath'],
  ['feblend', 'feBlend'],
  ['fecolormatrix', 'feColorMatrix'],
  ['fecomponenttransfer', 'feComponentTransfer'],
  ['fecomposite', 'feComposite'],
  ['fedisplacementmap', 'feDisplacementMap'],
  ['fedropshadow', 'feDropShadow'],
  ['feflood', 'feFlood'],
  ['fefunca', 'feFuncA'],
  ['fefuncb', 'feFuncB'],
  ['fefuncg', 'feFuncG'],
  ['fefuncr', 'feFuncR'],
  ['fegaussianblur', 'feGaussianBlur'],
  ['femerge', 'feMerge'],
  ['femergenode', 'feMergeNode'],
  ['femorphology', 'feMorphology'],
  ['feoffset', 'feOffset'],
  ['fetile', 'feTile'],
  ['feturbulence', 'feTurbulence'],
]);

/**
 * Canonical spelling for the camel-cased SVG attribute names.
 *
 * `viewBox` is the one that matters most: emit it as `viewbox` and the image
 * loses its intrinsic size, so it renders at the default 300×150 instead of at
 * the size PlantUML drew.
 */
const CANONICAL_ATTRIBUTES: ReadonlyMap<string, string> = new Map([
  ['viewbox', 'viewBox'],
  ['preserveaspectratio', 'preserveAspectRatio'],
  ['baseprofile', 'baseProfile'],
  ['zoomandpan', 'zoomAndPan'],
  ['pathlength', 'pathLength'],
  ['textlength', 'textLength'],
  ['lengthadjust', 'lengthAdjust'],
  ['startoffset', 'startOffset'],
  ['gradientunits', 'gradientUnits'],
  ['gradienttransform', 'gradientTransform'],
  ['spreadmethod', 'spreadMethod'],
  ['patternunits', 'patternUnits'],
  ['patterncontentunits', 'patternContentUnits'],
  ['patterntransform', 'patternTransform'],
  ['clippathunits', 'clipPathUnits'],
  ['maskunits', 'maskUnits'],
  ['maskcontentunits', 'maskContentUnits'],
  ['filterunits', 'filterUnits'],
  ['primitiveunits', 'primitiveUnits'],
  ['markerwidth', 'markerWidth'],
  ['markerheight', 'markerHeight'],
  ['markerunits', 'markerUnits'],
  ['refx', 'refX'],
  ['refy', 'refY'],
  ['stddeviation', 'stdDeviation'],
  ['basefrequency', 'baseFrequency'],
  ['numoctaves', 'numOctaves'],
  ['stitchtiles', 'stitchTiles'],
  ['xchannelselector', 'xChannelSelector'],
  ['ychannelselector', 'yChannelSelector'],
  ['tablevalues', 'tableValues'],
]);

/**
 * Attributes permitted on any allowed element.
 *
 * This is an allow-list rather than a deny-list precisely so that a new
 * event-handler attribute in a future SVG revision cannot slip through.
 */
const ALLOWED_ATTRIBUTES: ReadonlySet<string> = new Set([
  // Structure and identity
  'id',
  'class',
  'xmlns',
  'xmlns:xlink',
  'xmlns:svg',
  'version',
  'baseprofile',
  'viewbox',
  'preserveaspectratio',
  'zoomandpan',
  'xml:space',
  'xml:lang',
  'lang',
  'role',
  'aria-label',
  'aria-labelledby',
  'aria-describedby',
  'aria-hidden',
  // Geometry
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'fx',
  'fy',
  'fr',
  'width',
  'height',
  'dx',
  'dy',
  'd',
  'points',
  'pathlength',
  'transform',
  'transform-origin',
  'rotate',
  'textlength',
  'lengthadjust',
  'startoffset',
  'method',
  'spacing',
  'side',
  // Painting
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'opacity',
  'color',
  'color-interpolation',
  'color-interpolation-filters',
  'display',
  'visibility',
  'overflow',
  'shape-rendering',
  'text-rendering',
  'image-rendering',
  'vector-effect',
  'paint-order',
  'style',
  // Text
  'font',
  'font-family',
  'font-size',
  'font-size-adjust',
  'font-stretch',
  'font-style',
  'font-variant',
  'font-weight',
  'text-anchor',
  'text-decoration',
  'letter-spacing',
  'word-spacing',
  'dominant-baseline',
  'alignment-baseline',
  'baseline-shift',
  'writing-mode',
  'direction',
  'unicode-bidi',
  'white-space',
  // References that the value sanitiser constrains to local fragments
  'clip-path',
  'clip-rule',
  'mask',
  'filter',
  'marker-start',
  'marker-mid',
  'marker-end',
  // Gradients, patterns, markers, masks, filters
  'gradientunits',
  'gradienttransform',
  'spreadmethod',
  'offset',
  'stop-color',
  'stop-opacity',
  'patternunits',
  'patterncontentunits',
  'patterntransform',
  'clippathunits',
  'maskunits',
  'maskcontentunits',
  'filterunits',
  'primitiveunits',
  'markerwidth',
  'markerheight',
  'markerunits',
  'refx',
  'refy',
  'orient',
  'in',
  'in2',
  'result',
  'stddeviation',
  'flood-color',
  'flood-opacity',
  'values',
  'type',
  'mode',
  'operator',
  'radius',
  'k1',
  'k2',
  'k3',
  'k4',
  'basefrequency',
  'numoctaves',
  'seed',
  'scale',
  'stitchtiles',
  'xchannelselector',
  'ychannelselector',
  'tablevalues',
  'slope',
  'intercept',
  'amplitude',
  'exponent',
  // Link targets, constrained further by sanitiseUrl()
  'href',
  'xlink:href',
  'xlink:title',
  'target',
]);

/**
 * `data-*` attributes, which are kept.
 *
 * They cannot execute or fetch anything, and PlantUML uses them to carry real
 * information: `data-source-line` says which line of the source produced a
 * shape, which is what makes click-to-source in the preview precise rather than
 * a guess. Stripping them would silently remove a feature.
 */
const DATA_ATTRIBUTE = /^data-[a-z][a-z0-9-]*$/u;

/** Elements on which a URL-bearing attribute is meaningful at all. */
const URL_ATTRIBUTE_HOSTS: ReadonlySet<string> = new Set(['a', 'use', 'image', 'textpath']);

/** Attribute names whose value is a URL and therefore needs value sanitising. */
const URL_ATTRIBUTES: ReadonlySet<string> = new Set(['href', 'xlink:href']);

/** Attributes whose value is a `url(#id)` functional reference. */
const FUNC_IRI_ATTRIBUTES: ReadonlySet<string> = new Set([
  'clip-path',
  'mask',
  'filter',
  'fill',
  'stroke',
  'marker-start',
  'marker-mid',
  'marker-end',
]);

/** Image data URLs we accept inside `<image href>`; raster formats only. */
const SAFE_IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|jpg|gif|webp|bmp);base64,[A-Za-z0-9+/=\s]+$/iu;

/** External link schemes permitted on `<a>` only. */
const SAFE_LINK_SCHEME = /^(?:https?:|mailto:)/iu;

/** A bare fragment reference such as `#gradient-3`. */
const FRAGMENT_REFERENCE = /^#[A-Za-z0-9_.:-]+$/u;

/** CSS constructs that either fetch remotely or historically executed script. */
const DANGEROUS_CSS = /@import|expression\s*\(|behaviou?r\s*:|javascript\s*:|-moz-binding|url\s*\(\s*(?!['"]?#)/iu;

/** What the sanitiser produced, plus an audit trail of what it took out. */
export interface SanitisedSvg {
  /** Markup that is safe to insert into the webview DOM. */
  readonly svg: string;
  /** Human-readable notes about removed constructs, for the output channel. */
  readonly removals: readonly string[];
}

interface Attribute {
  readonly name: string;
  readonly value: string;
}

/**
 * Sanitises PlantUML's SVG output.
 *
 * Returns an error (rather than throwing, and rather than degrading silently)
 * when the input is not parseable as the XML subset SVG uses, or when its root
 * element is not `<svg>`.
 */
export function sanitiseSvg(input: string): Result<SanitisedSvg, string> {
  if (input.length > MAX_INPUT_BYTES) {
    return err(`SVG is too large to sanitise (${input.length} characters).`);
  }

  const removals = new Set<string>();
  const out: string[] = [];
  /** Open allowed elements, innermost last, used to emit correct end tags. */
  const openTags: string[] = [];
  /** Depth of the subtree currently being discarded; 0 means "emitting". */
  let dropDepth = 0;
  /** Names of dropped-but-unwrapped ancestors, so end tags stay balanced. */
  const unwrapped: string[] = [];
  let sawRoot = false;

  let index = 0;
  const length = input.length;

  while (index < length) {
    const lt = input.indexOf('<', index);
    if (lt === -1) {
      if (dropDepth === 0) {
        out.push(escapeText(input.slice(index)));
      }
      break;
    }

    if (lt > index && dropDepth === 0) {
      out.push(escapeText(input.slice(index, lt)));
    }

    // --- Declarations, comments and CDATA -----------------------------------
    if (input.startsWith('<!--', lt)) {
      const end = input.indexOf('-->', lt + 4);
      if (end === -1) {
        return err('Malformed SVG: unterminated comment.');
      }
      removals.add('comments');
      index = end + 3;
      continue;
    }

    if (input.startsWith('<![CDATA[', lt)) {
      const end = input.indexOf(']]>', lt + 9);
      if (end === -1) {
        return err('Malformed SVG: unterminated CDATA section.');
      }
      if (dropDepth === 0) {
        out.push(escapeText(input.slice(lt + 9, end)));
      }
      index = end + 3;
      continue;
    }

    if (input.startsWith('<?', lt)) {
      const end = input.indexOf('?>', lt + 2);
      if (end === -1) {
        return err('Malformed SVG: unterminated processing instruction.');
      }
      index = end + 2;
      continue;
    }

    if (input.startsWith('<!', lt)) {
      // A DOCTYPE with an internal subset can declare entities, which is the
      // classic XXE / billion-laughs vector. We never need one, so any DOCTYPE
      // carrying a subset is a hard rejection and a plain one is dropped.
      const end = input.indexOf('>', lt);
      if (end === -1) {
        return err('Malformed SVG: unterminated declaration.');
      }
      const declaration = input.slice(lt, end + 1);
      if (declaration.includes('[')) {
        return err('Rejected SVG: it declares an internal DTD subset.');
      }
      removals.add('doctype declaration');
      index = end + 1;
      continue;
    }

    // --- End tags -----------------------------------------------------------
    if (input.startsWith('</', lt)) {
      const end = input.indexOf('>', lt);
      if (end === -1) {
        return err('Malformed SVG: unterminated end tag.');
      }
      const name = input.slice(lt + 2, end).trim().toLowerCase();
      index = end + 1;

      if (dropDepth > 0) {
        dropDepth -= 1;
        continue;
      }
      if (unwrapped.length > 0 && unwrapped[unwrapped.length - 1] === name) {
        unwrapped.pop();
        continue;
      }
      const open = openTags[openTags.length - 1];
      if (open?.toLowerCase() === name) {
        openTags.pop();
        out.push(`</${open}>`);
        continue;
      }
      // An end tag with no matching start means we lost the structure; refuse
      // rather than emit markup whose nesting we no longer model correctly.
      return err(`Malformed SVG: unexpected closing tag </${name}>.`);
    }

    // --- Start tags ---------------------------------------------------------
    const parsed = parseStartTag(input, lt);
    if (parsed === undefined) {
      return err('Malformed SVG: could not parse a start tag.');
    }
    const { name, attributes, selfClosing, nextIndex } = parsed;
    index = nextIndex;

    if (!sawRoot) {
      if (name !== 'svg') {
        return err(`Rejected SVG: root element is <${name}>, expected <svg>.`);
      }
      sawRoot = true;
    }

    if (dropDepth > 0) {
      if (!selfClosing) {
        dropDepth += 1;
      }
      continue;
    }

    if (DROP_SUBTREE_ELEMENTS.has(name)) {
      removals.add(`<${name}> element`);
      if (!selfClosing) {
        dropDepth = 1;
        // Raw-text elements never contain real markup, so skip to their close
        // directly instead of tokenising CSS or JavaScript as XML.
        if (RAW_TEXT_ELEMENTS.has(name)) {
          const closed = skipRawText(input, index, name);
          if (closed === undefined) {
            return err(`Malformed SVG: unterminated <${name}> element.`);
          }
          index = closed;
          dropDepth = 0;
        }
      }
      continue;
    }

    if (!ALLOWED_ELEMENTS.has(name)) {
      // Unknown but not known-dangerous: unwrap it, keeping the children.
      removals.add(`unknown <${name}> element`);
      if (!selfClosing) {
        unwrapped.push(name);
      }
      continue;
    }

    const canonical = CANONICAL_ELEMENTS.get(name) ?? name;
    const safeAttributes = sanitiseAttributes(name, attributes, removals);
    const rendered = safeAttributes.map((a) => ` ${a.name}="${escapeAttribute(a.value)}"`).join('');

    if (name === 'style') {
      const closed = findRawTextEnd(input, index, name);
      if (closed === undefined) {
        return err('Malformed SVG: unterminated <style> element.');
      }
      const css = input.slice(index, closed.contentEnd);
      if (DANGEROUS_CSS.test(css)) {
        removals.add('<style> content with remote or executable CSS');
      } else {
        out.push(`<style${rendered}>`, escapeText(css), '</style>');
      }
      index = closed.nextIndex;
      continue;
    }

    if (selfClosing) {
      out.push(`<${canonical}${rendered}/>`);
    } else {
      openTags.push(canonical);
      out.push(`<${canonical}${rendered}>`);
    }
  }

  if (!sawRoot) {
    return err('Rejected SVG: no <svg> root element was found.');
  }
  if (dropDepth !== 0) {
    return err('Malformed SVG: an element was left unclosed.');
  }
  // Close anything the producer left open, so the fragment we hand to the DOM
  // is balanced regardless of how the generator terminated the document.
  while (openTags.length > 0) {
    out.push(`</${openTags.pop() ?? ''}>`);
  }

  return ok({ svg: out.join(''), removals: [...removals] });
}

interface ParsedStartTag {
  readonly name: string;
  readonly attributes: readonly Attribute[];
  readonly selfClosing: boolean;
  readonly nextIndex: number;
}

function parseStartTag(input: string, start: number): ParsedStartTag | undefined {
  let i = start + 1;
  const nameStart = i;
  while (i < input.length && !isTagNameTerminator(input[i] ?? '')) {
    i += 1;
  }
  const name = input.slice(nameStart, i).toLowerCase();
  if (name.length === 0) {
    return undefined;
  }

  const attributes: Attribute[] = [];
  let selfClosing = false;

  for (;;) {
    while (i < input.length && isWhitespace(input[i] ?? '')) {
      i += 1;
    }
    if (i >= input.length) {
      return undefined;
    }
    const ch = input[i];
    if (ch === '>') {
      i += 1;
      break;
    }
    if (ch === '/') {
      if (input[i + 1] !== '>') {
        return undefined;
      }
      selfClosing = true;
      i += 2;
      break;
    }

    const attrStart = i;
    while (i < input.length && !isAttributeNameTerminator(input[i] ?? '')) {
      i += 1;
    }
    const attrName = input.slice(attrStart, i).toLowerCase();
    if (attrName.length === 0) {
      return undefined;
    }

    while (i < input.length && isWhitespace(input[i] ?? '')) {
      i += 1;
    }

    let value = '';
    if (input[i] === '=') {
      i += 1;
      while (i < input.length && isWhitespace(input[i] ?? '')) {
        i += 1;
      }
      const quote = input[i];
      if (quote === '"' || quote === "'") {
        const close = input.indexOf(quote, i + 1);
        if (close === -1) {
          return undefined;
        }
        value = decodeEntities(input.slice(i + 1, close));
        i = close + 1;
      } else {
        const valueStart = i;
        while (i < input.length && !isWhitespace(input[i] ?? '') && input[i] !== '>') {
          i += 1;
        }
        value = decodeEntities(input.slice(valueStart, i));
      }
    }

    attributes.push({ name: attrName, value });
  }

  return { name, attributes, selfClosing, nextIndex: i };
}

function sanitiseAttributes(
  element: string,
  attributes: readonly Attribute[],
  removals: Set<string>,
): Attribute[] {
  const kept: Attribute[] = [];
  const seen = new Set<string>();

  for (const attribute of attributes) {
    const name = attribute.name;

    // Event handlers are the single most important thing to strip, and they are
    // rejected by name shape rather than by enumeration so that `onanything`
    // — including attributes that do not exist yet — cannot pass.
    if (name.startsWith('on')) {
      removals.add(`event handler attribute ${name}`);
      continue;
    }
    if (!ALLOWED_ATTRIBUTES.has(name) && !DATA_ATTRIBUTE.test(name)) {
      removals.add(`attribute ${name}`);
      continue;
    }
    // A duplicate attribute is a classic parser-differential trick: keep the
    // first occurrence, which is what XML processors use.
    if (seen.has(name)) {
      removals.add(`duplicate attribute ${name}`);
      continue;
    }

    let value = attribute.value;

    if (URL_ATTRIBUTES.has(name)) {
      if (!URL_ATTRIBUTE_HOSTS.has(element)) {
        removals.add(`${name} on <${element}>`);
        continue;
      }
      const safe = sanitiseUrl(element, value);
      if (safe === undefined) {
        removals.add(`unsafe ${name} value`);
        continue;
      }
      value = safe;
    } else if (name === 'style') {
      if (DANGEROUS_CSS.test(value)) {
        removals.add('style attribute with remote or executable CSS');
        continue;
      }
    } else if (FUNC_IRI_ATTRIBUTES.has(name) && /url\s*\(/iu.test(value)) {
      // `fill="url(https://attacker/…)"` is a remote fetch; only local
      // fragment references are legitimate here.
      if (!/^url\(\s*['"]?#[A-Za-z0-9_.:-]+['"]?\s*\)$/u.test(value.trim())) {
        removals.add(`non-local url() in ${name}`);
        continue;
      }
    } else if (name === 'target') {
      // Only `<a target>` is meaningful and only `_blank` is useful; anything
      // else is dropped so a diagram cannot retarget the preview frame.
      if (element !== 'a' || value !== '_blank') {
        removals.add('target attribute');
        continue;
      }
    }

    seen.add(name);
    kept.push({ name: CANONICAL_ATTRIBUTES.get(name) ?? name, value });
  }

  // A link that survives sanitisation still opens outside the editor, so pin
  // the relationship attributes rather than trusting the document to do it.
  if (element === 'a' && seen.has('href')) {
    kept.push({ name: 'rel', value: 'noreferrer noopener' });
  }

  return kept;
}

/**
 * Constrains a URL-valued attribute.
 *
 * Local fragments are always fine. External schemes are permitted only on `<a>`
 * (where VS Code mediates the navigation), and `data:` only for raster images.
 */
function sanitiseUrl(element: string, rawValue: string): string | undefined {
  // Strip whitespace and control characters first: `java\nscript:` and
  // `java&#0;script:` are long-standing filter bypasses.
  const value = rawValue.replace(/[\s\p{Cc}\p{Cf}]/gu, '');
  if (value.length === 0) {
    return undefined;
  }
  if (FRAGMENT_REFERENCE.test(value)) {
    return value;
  }
  if (element === 'a' && SAFE_LINK_SCHEME.test(value)) {
    return rawValue.trim();
  }
  if (element === 'image' && SAFE_IMAGE_DATA_URL.test(rawValue.trim())) {
    return rawValue.trim();
  }
  return undefined;
}

function findRawTextEnd(
  input: string,
  from: number,
  name: string,
): { contentEnd: number; nextIndex: number } | undefined {
  const needle = `</${name}`;
  const lower = input.toLowerCase();
  const at = lower.indexOf(needle, from);
  if (at === -1) {
    return undefined;
  }
  const close = input.indexOf('>', at);
  if (close === -1) {
    return undefined;
  }
  return { contentEnd: at, nextIndex: close + 1 };
}

function skipRawText(input: string, from: number, name: string): number | undefined {
  return findRawTextEnd(input, from, name)?.nextIndex;
}

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
}

function isTagNameTerminator(ch: string): boolean {
  return isWhitespace(ch) || ch === '>' || ch === '/';
}

function isAttributeNameTerminator(ch: string): boolean {
  return isWhitespace(ch) || ch === '=' || ch === '>' || ch === '/';
}

/**
 * Decodes the entity forms an attribute value may legitimately contain.
 *
 * Decoding before validation is deliberate: it means `href="&#106;avascript:…"`
 * is compared in its decoded form and therefore rejected.
 */
function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/giu, (match, body: string) => {
    const token = body.toLowerCase();
    if (token.startsWith('#x')) {
      const code = Number.parseInt(token.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? safeFromCodePoint(code, match)
        : match;
    }
    if (token.startsWith('#')) {
      const code = Number.parseInt(token.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? safeFromCodePoint(code, match)
        : match;
    }
    switch (token) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        return match;
    }
  });
}

function safeFromCodePoint(code: number, fallback: string): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

/**
 * Escapes text content.
 *
 * `&` is only escaped when it does not already begin a well-formed entity, so
 * PlantUML's `&#160;` survives a round-trip unchanged.
 */
function escapeText(value: string): string {
  return value
    .replace(/&(?!(?:#x?[0-9a-fA-F]+|[a-zA-Z]+);)/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;');
}
