/** Tests for the byte-budgeted render cache. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LruCache } from '../../out/shared/lru.js';

/** A cache of strings whose size is their length. */
function cache(maxEntries, maxBytes) {
  return new LruCache(maxEntries, maxBytes, (value) => value.length);
}

describe('LruCache', () => {
  it('stores and retrieves values', () => {
    const lru = cache(4, 1000);
    lru.set('a', 'one');
    assert.equal(lru.get('a'), 'one');
    assert.equal(lru.has('a'), true);
    assert.equal(lru.get('missing'), undefined);
  });

  it('evicts the least recently used entry when full', () => {
    const lru = cache(2, 1000);
    lru.set('a', '1');
    lru.set('b', '2');
    lru.set('c', '3');
    assert.equal(lru.get('a'), undefined);
    assert.equal(lru.get('b'), '2');
    assert.equal(lru.get('c'), '3');
  });

  it('counts a read as a use', () => {
    const lru = cache(2, 1000);
    lru.set('a', '1');
    lru.set('b', '2');
    lru.get('a');
    lru.set('c', '3');
    assert.equal(lru.get('a'), '1', 'a was used most recently and should survive');
    assert.equal(lru.get('b'), undefined);
  });

  it('evicts to stay inside the byte budget', () => {
    const lru = cache(100, 10);
    lru.set('a', 'xxxxx');
    lru.set('b', 'yyyyy');
    lru.set('c', 'zzzzz');
    assert.equal(lru.get('a'), undefined);
    assert.ok(lru.byteSize <= 10);
  });

  it('refuses to cache a value larger than the whole budget', () => {
    const lru = cache(10, 5);
    lru.set('big', 'xxxxxxxxxx');
    assert.equal(lru.get('big'), undefined);
    assert.equal(lru.size, 0);
    assert.equal(lru.byteSize, 0);
  });

  it('keeps the byte count correct when a key is overwritten', () => {
    const lru = cache(10, 100);
    lru.set('a', 'xxxxx');
    lru.set('a', 'y');
    assert.equal(lru.byteSize, 1);
    assert.equal(lru.size, 1);
    assert.equal(lru.get('a'), 'y');
  });

  it('keeps the byte count correct on delete and clear', () => {
    const lru = cache(10, 100);
    lru.set('a', 'xxx');
    lru.set('b', 'yy');
    lru.delete('a');
    assert.equal(lru.byteSize, 2);
    lru.clear();
    assert.equal(lru.byteSize, 0);
    assert.equal(lru.size, 0);
  });

  it('rejects nonsensical limits at construction', () => {
    assert.throws(() => cache(0, 10));
    assert.throws(() => cache(10, 0));
    assert.throws(() => cache(-1, -1));
  });
});
