/**
 * Tests for the SVG sanitiser.
 *
 * These run against the compiled output in `out/`, so they exercise exactly the
 * bytes that ship rather than a separately-transpiled copy.
 *
 * The attack cases below are the ones that actually matter for this extension:
 * everything PlantUML can be made to emit from a hostile `.puml` file, plus the
 * classic sanitiser bypasses that a naive allow-list gets wrong.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sanitiseSvg } from '../../out/shared/svgSanitizer.js';

/** Renders a minimal valid SVG wrapper around `body`. */
function svg(body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${body}</svg>`;
}

/** Sanitises and asserts success, returning the cleaned markup. */
function clean(input) {
  const result = sanitiseSvg(input);
  assert.equal(result.ok, true, `expected success, got: ${result.ok ? '' : result.error}`);
  return result.value.svg;
}

describe('sanitiseSvg / valid input', () => {
  it('keeps a plain PlantUML-shaped diagram intact', () => {
    const input = svg(
      '<g><rect x="1" y="1" width="8" height="4" fill="#FEFECE" stroke="#A80036"/>' +
        '<text x="2" y="3" font-family="sans-serif" font-size="11">Alice</text></g>',
    );
    const output = clean(input);
    assert.match(output, /<rect /u);
    assert.match(output, />Alice</u);
    assert.match(output, /fill="#FEFECE"/u);
  });

  it('preserves numeric entities in text', () => {
    const output = clean(svg('<text>a&#160;b &amp; c</text>'));
    assert.match(output, /a&#160;b/u);
    assert.match(output, /&amp; c/u);
  });

  it('keeps data-* attributes, which carry PlantUML’s source-line mapping', () => {
    const output = clean(
      svg('<g data-source-line="3" data-qualified-name="Order" data-link-type="dependency"><rect width="1"/></g>'),
    );
    assert.match(output, /data-source-line="3"/u);
    assert.match(output, /data-qualified-name="Order"/u);
    assert.match(output, /data-link-type="dependency"/u);
  });

  it('still rejects an attribute that only looks like a data attribute', () => {
    const output = clean(svg('<rect datax-source="1" data_source="2" width="1"/>'));
    assert.doesNotMatch(output, /datax-source/u);
    assert.doesNotMatch(output, /data_source/u);
  });

  it('keeps internal fragment references used by gradients and markers', () => {
    const output = clean(
      svg('<defs><linearGradient id="g1"><stop offset="0"/></linearGradient></defs>' +
        '<rect fill="url(#g1)" width="4" height="4"/>'),
    );
    assert.match(output, /url\(#g1\)/u);
  });

  it('accepts an XML declaration before the root element', () => {
    const output = clean(`<?xml version="1.0" encoding="UTF-8" standalone="no"?>${svg('<g/>')}`);
    assert.match(output, /^<svg/u);
  });
});

describe('sanitiseSvg / script execution', () => {
  it('removes a script element and its contents', () => {
    const output = clean(svg('<script>alert(1)</script><rect width="1" height="1"/>'));
    assert.doesNotMatch(output, /script/iu);
    assert.doesNotMatch(output, /alert/u);
    assert.match(output, /<rect/u);
  });

  it('removes every on* event handler, including unknown ones', () => {
    const output = clean(
      svg('<rect onload="a()" onclick="b()" onfocusin="c()" onsomethingnew="d()" width="1"/>'),
    );
    assert.doesNotMatch(output, /on[a-z]+=/iu);
    assert.match(output, /width="1"/u);
  });

  it('drops foreignObject together with the HTML it smuggles', () => {
    const output = clean(
      svg('<foreignObject><iframe src="https://evil.example"></iframe></foreignObject><g/>'),
    );
    assert.doesNotMatch(output, /foreignObject/iu);
    assert.doesNotMatch(output, /iframe/iu);
  });

  it('drops animation elements that could retarget an attribute after sanitising', () => {
    const output = clean(
      svg('<rect width="1"><animate attributeName="href" to="javascript:alert(1)"/></rect>'),
    );
    assert.doesNotMatch(output, /animate/iu);
    assert.doesNotMatch(output, /javascript/iu);
  });
});

describe('sanitiseSvg / URL handling', () => {
  it('strips a javascript: href', () => {
    const output = clean(svg('<a href="javascript:alert(1)"><text>x</text></a>'));
    assert.doesNotMatch(output, /javascript:/iu);
    assert.match(output, />x</u, 'the link text should survive');
  });

  it('strips a javascript: href hidden behind entity encoding', () => {
    const output = clean(svg('<a href="&#106;avascript:alert(1)"><text>x</text></a>'));
    assert.doesNotMatch(output, /avascript:alert/iu);
  });

  it('strips a javascript: href broken up by whitespace and control characters', () => {
    const output = clean(svg('<a href="java\nscript:alert(1)"><text>x</text></a>'));
    assert.doesNotMatch(output, /script:alert/iu);
  });

  it('keeps an ordinary https link and pins its rel', () => {
    const output = clean(svg('<a href="https://example.com/docs"><text>doc</text></a>'));
    assert.match(output, /href="https:\/\/example\.com\/docs"/u);
    assert.match(output, /rel="noreferrer noopener"/u);
  });

  it('refuses an external href on elements other than <a>', () => {
    const output = clean(svg('<use href="https://evil.example/x.svg#a"/>'));
    assert.doesNotMatch(output, /evil\.example/u);
  });

  it('refuses a remote image and keeps an embedded raster one', () => {
    const remote = clean(svg('<image href="https://evil.example/tracker.png" width="1" height="1"/>'));
    assert.doesNotMatch(remote, /evil\.example/u);

    const embedded = clean(
      svg('<image href="data:image/png;base64,iVBORw0KGgo=" width="1" height="1"/>'),
    );
    assert.match(embedded, /data:image\/png;base64,/u);
  });

  it('refuses an svg data: image, which would be a nested document', () => {
    const output = clean(svg('<image href="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" width="1"/>'));
    assert.doesNotMatch(output, /svg\+xml/u);
  });

  it('refuses a remote url() in a paint attribute', () => {
    const output = clean(svg('<rect fill="url(https://evil.example/x#a)" width="1"/>'));
    assert.doesNotMatch(output, /evil\.example/u);
  });
});

describe('sanitiseSvg / CSS', () => {
  it('drops a style element that imports remotely', () => {
    const output = clean(svg('<style>@import url(https://evil.example/x.css);</style><g/>'));
    assert.doesNotMatch(output, /evil\.example/u);
    assert.doesNotMatch(output, /@import/u);
  });

  it('drops a style element that fetches a remote background', () => {
    const output = clean(svg('<style>rect{fill:url(https://evil.example/p.png)}</style><g/>'));
    assert.doesNotMatch(output, /evil\.example/u);
  });

  it('keeps ordinary PlantUML CSS', () => {
    const output = clean(svg('<style>text{font-family:sans-serif;fill:#333}</style><g/>'));
    assert.match(output, /font-family:sans-serif/u);
  });

  it('drops a style attribute containing an expression', () => {
    const output = clean(svg('<rect style="width:expression(alert(1))" height="1"/>'));
    assert.doesNotMatch(output, /expression/u);
    assert.match(output, /height="1"/u);
  });

  it('keeps an ordinary style attribute', () => {
    const output = clean(svg('<text style="font-weight:bold">x</text>'));
    assert.match(output, /font-weight:bold/u);
  });
});

describe('sanitiseSvg / parser differentials', () => {
  it('keeps only the first of a duplicated attribute', () => {
    const output = clean(svg('<a href="#safe" href="javascript:alert(1)"><text>x</text></a>'));
    assert.match(output, /href="#safe"/u);
    assert.doesNotMatch(output, /javascript/iu);
  });

  it('unwraps an unknown element but keeps its children', () => {
    const output = clean(svg('<madeUpTag><text>kept</text></madeUpTag>'));
    assert.doesNotMatch(output, /madeUpTag/iu);
    assert.match(output, />kept</u);
  });

  it('escapes stray angle brackets in text rather than emitting markup', () => {
    const output = clean(svg('<text>a &lt;script&gt; b</text>'));
    assert.doesNotMatch(output, /<script/u);
  });
});

describe('sanitiseSvg / fail-closed behaviour', () => {
  const rejected = [
    ['a non-SVG root', '<html><body>hi</body></html>'],
    ['no root element at all', 'just text'],
    ['an internal DTD subset', '<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg"/>'],
    ['an unterminated comment', `${'<svg xmlns="http://www.w3.org/2000/svg">'}<!-- oops`],
    ['an unbalanced closing tag', svg('</g>')],
    ['an unterminated CDATA section', `${'<svg xmlns="http://www.w3.org/2000/svg">'}<![CDATA[ oops`],
  ];

  for (const [name, input] of rejected) {
    it(`rejects ${name}`, () => {
      const result = sanitiseSvg(input);
      assert.equal(result.ok, false);
      assert.equal(typeof result.error, 'string');
      assert.ok(result.error.length > 0);
    });
  }

  it('rejects input larger than the parse budget', () => {
    const huge = `${'<svg xmlns="http://www.w3.org/2000/svg">'}${'x'.repeat(33 * 1024 * 1024)}</svg>`;
    const result = sanitiseSvg(huge);
    assert.equal(result.ok, false);
  });
});

describe('sanitiseSvg / reporting', () => {
  it('reports what it removed so the log can explain a changed diagram', () => {
    const result = sanitiseSvg(svg('<script>x</script><rect onclick="y()" width="1"/>'));
    assert.equal(result.ok, true);
    assert.ok(result.value.removals.some((entry) => entry.includes('script')));
    assert.ok(result.value.removals.some((entry) => entry.includes('onclick')));
  });

  it('reports nothing for clean input', () => {
    const result = sanitiseSvg(svg('<rect width="1" height="1"/>'));
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.removals, []);
  });
});

describe('sanitiseSvg / case sensitivity', () => {
  it('emits viewBox with its capital B', () => {
    // SVG is XML: `viewbox` is not `viewBox`. Getting this wrong strips the
    // image's intrinsic size and it renders at the browser default of 300x150.
    const output = clean('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><g/></svg>');
    assert.match(output, /viewBox="0 0 100 50"/u);
    assert.doesNotMatch(output, /viewbox=/u);
  });

  it('emits camel-cased element names correctly', () => {
    const output = clean(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">' +
        '<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" spreadMethod="pad">' +
        '<stop offset="0"/></linearGradient>' +
        '<clipPath id="c" clipPathUnits="userSpaceOnUse"><rect width="1" height="1"/></clipPath>' +
        '<filter id="f"><feGaussianBlur stdDeviation="2"/><feDropShadow dx="1" dy="1"/></filter>' +
        '</defs><rect width="1" height="1"/></svg>',
    );
    for (const name of ['linearGradient', 'clipPath', 'feGaussianBlur', 'feDropShadow']) {
      assert.ok(output.includes(`<${name} `), `${name} should keep its spelling`);
      assert.ok(
        output.includes(`</${name}>`) || new RegExp(`<${name}[^>]*/>`, 'u').test(output),
        `${name} should close correctly`,
      );
    }
    for (const attribute of ['gradientUnits', 'spreadMethod', 'clipPathUnits', 'stdDeviation']) {
      assert.match(output, new RegExp(`${attribute}=`, 'u'), `${attribute} should keep its spelling`);
    }
  });

  it('still matches the allow-list regardless of the case used in the input', () => {
    const output = clean(
      '<SVG xmlns="http://www.w3.org/2000/svg" VIEWBOX="0 0 1 1"><ScRiPt>x</ScRiPt><RECT WIDTH="1"/></SVG>',
    );
    assert.doesNotMatch(output, /script/iu, 'case must not defeat the drop-list');
    assert.match(output, /viewBox="0 0 1 1"/u);
    assert.match(output, /<rect width="1"/u);
  });

  it('closes a camel-cased element with the same spelling it opened', () => {
    const output = clean(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">' +
        '<defs><LINEARGRADIENT id="g"><stop offset="0"/></LINEARGRADIENT></defs></svg>',
    );
    const opens = (output.match(/<linearGradient\b/gu) ?? []).length;
    const closes = (output.match(/<\/linearGradient>/gu) ?? []).length;
    assert.equal(opens, 1);
    assert.equal(closes, 1);
  });
});
