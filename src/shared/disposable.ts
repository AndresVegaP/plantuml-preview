/**
 * Disposal helpers.
 *
 * Everything this extension creates — event subscriptions, panels, child
 * processes, timers — is owned by exactly one `DisposableStore`, and every
 * store is ultimately owned by the extension context. That single rule is what
 * keeps the extension leak-free across reloads.
 */

export interface IDisposable {
  dispose(): void;
}

export class DisposableStore implements IDisposable {
  private readonly items = new Set<IDisposable>();
  private disposed = false;

  /** Adds a disposable to the store and returns it for convenient chaining. */
  add<T extends IDisposable>(item: T): T {
    if (this.disposed) {
      // Adding to a disposed store would silently leak; dispose immediately instead.
      item.dispose();
      return item;
    }
    this.items.add(item);
    return item;
  }

  delete(item: IDisposable): void {
    this.items.delete(item);
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const errors: unknown[] = [];
    for (const item of this.items) {
      try {
        item.dispose();
      } catch (error) {
        // One faulty disposable must not prevent the rest from being released.
        errors.push(error);
      }
    }
    this.items.clear();
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Errors occurred while disposing');
    }
  }
}

export function toDisposable(fn: () => void): IDisposable {
  return { dispose: fn };
}

/** A disposable that owns nothing, used where a caller demands one. */
export const NO_OP_DISPOSABLE: IDisposable = Object.freeze({
  dispose(): void {
    // Intentionally empty.
  },
});
