import { CACHE_TTL_MS } from './constants';

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

/** A minimal time-to-live cache. Entries expire lazily on read. */
export class TtlCache<V> {
  private store = new Map<string, CacheEntry<V>>();

  constructor(
    private ttlMs: number = CACHE_TTL_MS,
    private now: () => number = Date.now,
  ) {}

  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (this.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V): void {
    this.store.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  clear(): void {
    this.store.clear();
  }
}
