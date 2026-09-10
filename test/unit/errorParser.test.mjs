/**
 * Tests for recovering a usable message and line number from backend output.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseErrorImage, parseErrorText } from '../../out/extension/render/errorParser.js';

describe('parseErrorText', () => {
  it('returns undefined for empty output', () => {
    assert.equal(parseErrorText(''), undefined);
    assert.equal(parseErrorText('   \n  '), undefined);
  });

  it('converts PlantUML’s 1-based line number to a 0-based one', () => {
    const result = parseErrorText('Error line 5 in file: -\nSome diagram description contains errors');
    assert.equal(result.line, 4);
  });

  it('recognises the other line-number spellings', () => {
    assert.equal(parseErrorText('error line 3').line, 2);
    assert.equal(parseErrorText('at line 9').line, 8);
    assert.equal(parseErrorText('line 12: unexpected token').line, 11);
    assert.equal(parseErrorText('failed (line 7)').line, 6);
  });

  it('uses the first meaningful line as the message', () => {
    const result = parseErrorText('\n\nSyntax error at "foo"\ncontext line\n');
    assert.equal(result.message, 'Syntax error at "foo"');
  });

  it('omits the line when none is named', () => {
    const result = parseErrorText('Something went wrong');
    assert.equal(result.line, undefined);
    assert.equal(result.message, 'Something went wrong');
  });

  it('ignores a line number of zero, which PlantUML never emits', () => {
    assert.equal(parseErrorText('error line 0').line, undefined);
  });
});

describe('parseErrorImage', () => {
  it('ignores an ordinary diagram', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Alice</text></svg>';
    assert.equal(parseErrorImage(svg), undefined);
  });

  it('detects PlantUML’s rendered error image', () => {
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg">',
      '<text>Syntax Error?</text>',
      '<text>Error line 4 in file: -</text>',
      '</svg>',
    ].join('');
    const result = parseErrorImage(svg);
    assert.notEqual(result, undefined);
    assert.equal(result.line, 3);
    assert.match(result.message, /Syntax Error/u);
  });

  it('detects a missing Graphviz message', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Cannot find Graphviz</text></svg>';
    assert.notEqual(parseErrorImage(svg), undefined);
  });

  it('decodes entities in the recovered text', () => {
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg">',
      '<text>Syntax Error?</text>',
      '<text>unexpected &lt;tag&gt; &amp; more</text>',
      '</svg>',
    ].join('');
    const result = parseErrorImage(svg);
    assert.match(result.message, /unexpected <tag> & more/u);
  });

  it('reads text out of tspan children too', () => {
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg">',
      '<tspan>Syntax Error?</tspan>',
      '<tspan>at line 2</tspan>',
      '</svg>',
    ].join('');
    const result = parseErrorImage(svg);
    assert.equal(result.line, 1);
  });
});
