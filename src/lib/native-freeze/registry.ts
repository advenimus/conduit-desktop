export type FreezeReason = "dialog" | "popover" | "sidebar" | "drag" | "menu" | "legacy";

export interface FreezeHolder {
  readonly reason: FreezeReason;
  readonly label?: string;
  readonly since: number;
}

export type AcquireFreeze = (reason: FreezeReason, label?: string) => () => void;

export interface FreezeRegistry {
  readonly acquire: AcquireFreeze;
  readonly isFrozen: () => boolean;
  readonly subscribe: (listener: () => void) => () => void;
  readonly holders: () => ReadonlyArray<FreezeHolder>;
}

export interface FreezeRegistryOptions {
  readonly schedule?: (flush: () => void) => void;
  readonly now?: () => number;
}

function without<K, V>(map: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> {
  const next = new Map(map);
  next.delete(key);
  return next;
}

function withoutItem<T>(set: ReadonlySet<T>, item: T): ReadonlySet<T> {
  const next = new Set(set);
  next.delete(item);
  return next;
}

export function createFreezeRegistry({
  schedule = (flush) => queueMicrotask(flush),
  now = () => Date.now(),
}: FreezeRegistryOptions = {}): FreezeRegistry {
  let holders: ReadonlyMap<symbol, FreezeHolder> = new Map();
  let listeners: ReadonlySet<() => void> = new Set();
  let flushPending = false;

  const flush = () => {
    flushPending = false;
    for (const listener of listeners) {
      try {
        listener();
      } catch (err) {
        console.error("[native-freeze] subscriber failed:", err);
      }
    }
  };

  const changed = () => {
    if (flushPending) return;
    flushPending = true;
    schedule(flush);
  };

  const acquire: AcquireFreeze = (reason, label) => {
    const key = Symbol(reason);
    holders = new Map(holders).set(key, Object.freeze({ reason, label, since: now() }));
    changed();
    return () => {
      if (!holders.has(key)) return;
      holders = without(holders, key);
      changed();
    };
  };

  const subscribe = (listener: () => void) => {
    listeners = new Set(listeners).add(listener);
    return () => {
      listeners = withoutItem(listeners, listener);
    };
  };

  return {
    acquire,
    isFrozen: () => holders.size > 0,
    subscribe,
    holders: () => Array.from(holders.values()),
  };
}
