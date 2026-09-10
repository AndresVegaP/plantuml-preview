/**
 * Small async primitives used by the render pipeline.
 *
 * Kept free of the `vscode` module so they can be unit-tested directly.
 */
import type { IDisposable } from './disposable.js';

/**
 * Coalesces bursts of calls into a single trailing invocation.
 *
 * The preview re-renders as the user types; without this every keystroke would
 * spawn a render. `cancel()` is exposed so the owner can stop a pending run
 * during disposal.
 */
export class Debouncer implements IDisposable {
  private handle: ReturnType<typeof setTimeout> | undefined;
  private pending: (() => void) | undefined;

  constructor(private readonly delayMs: number) {}

  schedule(action: () => void): void {
    this.pending = action;
    if (this.handle !== undefined) {
      clearTimeout(this.handle);
    }
    this.handle = setTimeout(() => {
      this.handle = undefined;
      const run = this.pending;
      this.pending = undefined;
      run?.();
    }, this.delayMs);
  }

  /** Runs any pending action immediately. */
  flush(): void {
    if (this.handle === undefined) {
      return;
    }
    clearTimeout(this.handle);
    this.handle = undefined;
    const run = this.pending;
    this.pending = undefined;
    run?.();
  }

  cancel(): void {
    if (this.handle !== undefined) {
      clearTimeout(this.handle);
      this.handle = undefined;
    }
    this.pending = undefined;
  }

  dispose(): void {
    this.cancel();
  }
}

/**
 * Serialises async work so that only the newest request survives.
 *
 * When a render is already running and two more are queued, the middle one is
 * dropped: its output would be discarded anyway, and dropping it keeps the
 * preview latency bounded by one render instead of by the queue length.
 */
export class LatestOnlyQueue {
  private running = false;
  private queued: (() => Promise<void>) | undefined;

  async run(task: () => Promise<void>): Promise<void> {
    if (this.running) {
      this.queued = task;
      return;
    }
    this.running = true;
    try {
      await task();
      while (this.queued !== undefined) {
        const next = this.queued;
        this.queued = undefined;
        await next();
      }
    } finally {
      this.running = false;
    }
  }
}

/** Rejects with `reason` once `ms` elapses; resolves to `value` otherwise. */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => void,
): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    const handle = setTimeout(() => {
      onTimeout();
      resolve(undefined);
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(handle);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(handle);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
