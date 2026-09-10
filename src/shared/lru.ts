/**
 * A byte-budgeted LRU cache.
 *
 * Rendering is the expensive part of the preview loop, and users retype the
 * same diagram constantly (undo, cursor moves, switching tabs). Caching keyed
 * by a content hash turns most of those into instant redraws, while the byte
 * budget keeps a long session with many large diagrams from growing without
 * bound.
 */
export class LruCache<K, V> {
  private readonly entries = new Map<K, { value: V; size: number }>();
  private currentSize = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number,
    private readonly sizeOf: (value: V) => number,
  ) {
    if (maxEntries <= 0 || maxBytes <= 0) {
      throw new Error('LruCache requires positive limits');
    }
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    // Re-insert to move the key to the most-recently-used end of the Map.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }

  set(key: K, value: V): void {
    const size = Math.max(0, this.sizeOf(value));
    this.delete(key);
    // A single value larger than the whole budget is simply not cached.
    if (size > this.maxBytes) {
      return;
    }
    this.entries.set(key, { value, size });
    this.currentSize += size;
    this.evict();
  }

  delete(key: K): void {
    const entry = this.entries.get(key);
    if (entry !== undefined) {
      this.currentSize -= entry.size;
      this.entries.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
    this.currentSize = 0;
  }

  get size(): number {
    return this.entries.size;
  }

  get byteSize(): number {
    return this.currentSize;
  }

  private evict(): void {
    while (this.entries.size > this.maxEntries || this.currentSize > this.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) {
        return;
      }
      this.delete(oldest.value);
    }
  }
}
