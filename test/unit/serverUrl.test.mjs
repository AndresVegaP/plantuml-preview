/**
 * Tests for the rule that decides whether diagram text may leave the machine.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isLoopbackHost, validateServerUrl } from '../../out/shared/serverUrl.js';

describe('isLoopbackHost', () => {
  const loopback = ['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '127.255.255.255', '::1', '[::1]'];
  for (const host of loopback) {
    it(`treats ${host} as local`, () => {
      assert.equal(isLoopbackHost(host), true);
    });
  }

  const remote = ['example.com', '192.168.1.10', '10.0.0.1', '0.0.0.0', '128.0.0.1', 'localhost.evil.com', '127.0.0.1.evil.com'];
  for (const host of remote) {
    it(`treats ${host} as remote`, () => {
      assert.equal(isLoopbackHost(host), false);
    });
  }
});

describe('validateServerUrl', () => {
  it('accepts a loopback server without an opt-in', () => {
    const result = validateServerUrl('http://localhost:8080', false);
    assert.ok('url' in result);
    assert.equal(result.url.port, '8080');
  });

  it('refuses a remote server without an opt-in', () => {
    const result = validateServerUrl('https://www.plantuml.com/plantuml', false);
    assert.ok('error' in result);
    assert.match(result.error, /not on this machine/iu);
  });

  it('allows a remote server once explicitly opted in', () => {
    const result = validateServerUrl('https://plantuml.internal.example/plantuml', true);
    assert.ok('url' in result);
  });

  it('refuses an empty URL with actionable advice', () => {
    const result = validateServerUrl('', false);
    assert.ok('error' in result);
    assert.match(result.error, /plantuml\.render\.serverUrl/u);
  });

  it('refuses a malformed URL', () => {
    assert.ok('error' in validateServerUrl('not a url', false));
  });

  it('refuses a non-HTTP scheme', () => {
    for (const url of ['file:///etc/passwd', 'ftp://host/x', 'javascript:alert(1)']) {
      const result = validateServerUrl(url, true);
      assert.ok('error' in result, `${url} should be refused`);
    }
  });

  it('refuses credentials embedded in the URL', () => {
    const result = validateServerUrl('http://user:secret@localhost:8080', false);
    assert.ok('error' in result);
    assert.match(result.error, /credentials/iu);
  });

  it('is not fooled by a host that merely starts with localhost', () => {
    const result = validateServerUrl('http://localhost.evil.example/plantuml', false);
    assert.ok('error' in result);
  });
});
