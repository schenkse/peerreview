import { CACHE_TTL_MS } from './constants';

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

/** A bounded TTL cache. Expired entries are removed on reads and insertions. */
export class TtlCache<V> {
  private store = new Map<string, CacheEntry<V>>();

  constructor(
    private ttlMs: number = CACHE_TTL_MS,
    private now: () => number = Date.now,
    private maxEntries = 128,
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
    if (this.maxEntries <= 0) return;
    const now = this.now();
    for (const [storedKey, entry] of this.store) {
      if (now >= entry.expiresAt) this.store.delete(storedKey);
    }
    this.store.delete(key);
    if (this.store.size >= this.maxEntries) {
      this.store.delete(this.store.keys().next().value!);
    }
    this.store.set(key, { value, expiresAt: now + this.ttlMs });
  }

  clear(): void {
    this.store.clear();
  }
}
