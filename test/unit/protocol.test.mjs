/**
 * Tests for webview-message validation.
 *
 * The webview is untrusted by the host, so these assert the *rejections* as
 * carefully as the acceptances: a message that slips through unvalidated is a
 * message whose fields reach host code that never expected them.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseWebviewMessage } from '../../out/shared/protocol.js';

describe('parseWebviewMessage / rejection', () => {
  const rejected = [
    ['null', null],
    ['undefined', undefined],
    ['a string', 'rendered'],
    ['a number', 42],
    ['an array', []],
    ['no type', { token: 1 }],
    ['an unknown type', { type: 'executeCommand', command: 'rm -rf /' }],
    ['rendered without a token', { type: 'rendered', svg: '<svg/>' }],
    ['rendered with a non-numeric token', { type: 'rendered', token: '1', svg: '<svg/>' }],
    ['rendered with a NaN token', { type: 'rendered', token: Number.NaN, svg: '<svg/>' }],
    ['rendered without svg', { type: 'rendered', token: 1 }],
    ['rendered with non-string svg', { type: 'rendered', token: 1, svg: { toString: () => 'x' } }],
    ['log with an unknown level', { type: 'log', level: 'fatal', message: 'x' }],
    ['zoomChanged with a negative zoom', { type: 'zoomChanged', zoom: -1 }],
    ['zoomChanged with a zero zoom', { type: 'zoomChanged', zoom: 0 }],
    ['exportResult with a bad format', { type: 'exportResult', token: 1, format: 'exe', base64: 'AA==' }],
    ['exportResult with non-base64 payload', { type: 'exportResult', token: 1, format: 'png', base64: '../../etc' }],
    ['exportResult with a data URL', { type: 'exportResult', token: 1, format: 'png', base64: 'data:image/png;base64,AA==' }],
  ];

  for (const [name, input] of rejected) {
    it(`rejects ${name}`, () => {
      assert.equal(parseWebviewMessage(input), undefined);
    });
  }

  it('rejects an oversized string field', () => {
    const huge = 'x'.repeat(65 * 1024 * 1024);
    assert.equal(parseWebviewMessage({ type: 'rendered', token: 1, svg: huge }), undefined);
  });

  it('rejects a removals array that is not entirely strings', () => {
    const result = parseWebviewMessage({
      type: 'rendered',
      token: 1,
      svg: '<svg/>',
      removals: ['ok', 5],
    });
    // A malformed removals list degrades to empty rather than failing the whole
    // message: it is diagnostic metadata, not something the host acts on.
    assert.notEqual(result, undefined);
    assert.deepEqual(result.removals, []);
  });
});

describe('parseWebviewMessage / acceptance', () => {
  it('accepts a minimal ready message', () => {
    assert.deepEqual(parseWebviewMessage({ type: 'ready', engineAvailable: true }), {
      type: 'ready',
      engineAvailable: true,
    });
  });

  it('treats a missing engineAvailable as false rather than trusting it', () => {
    const result = parseWebviewMessage({ type: 'ready' });
    assert.equal(result.engineAvailable, false);
  });

  it('accepts a rendered message and normalises optional fields', () => {
    const result = parseWebviewMessage({ type: 'rendered', token: 7, svg: '<svg/>' });
    assert.deepEqual(result, {
      type: 'rendered',
      token: 7,
      svg: '<svg/>',
      durationMs: 0,
      removals: [],
    });
  });

  it('accepts a strict base64 export payload', () => {
    const result = parseWebviewMessage({
      type: 'exportResult',
      token: 3,
      format: 'png',
      base64: 'iVBORw0KGgo=',
    });
    assert.equal(result.format, 'png');
    assert.equal(result.base64, 'iVBORw0KGgo=');
  });

  it('accepts each log level', () => {
    for (const level of ['info', 'warn', 'error']) {
      const result = parseWebviewMessage({ type: 'log', level, message: 'x' });
      assert.equal(result.level, level);
    }
  });

  it('accepts revealSource', () => {
    assert.deepEqual(parseWebviewMessage({ type: 'revealSource' }), { type: 'revealSource' });
  });

  it('ignores extra properties rather than passing them through', () => {
    const result = parseWebviewMessage({
      type: 'revealSource',
      __proto__: { polluted: true },
      extra: 'ignored',
    });
    assert.deepEqual(Object.keys(result), ['type']);
  });
});
