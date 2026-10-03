import { describe, it, expect } from 'vitest';
import { TtlCache } from './cache';

describe('TtlCache', () => {
  it('evicts the oldest entry when capacity is reached', () => {
    const cache = new TtlCache<number>(1000, () => 0, 2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
  });

  it('treats a replacement as a fresh insertion without evicting another entry', () => {
    const cache = new TtlCache<number>(1000, () => 0, 2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 3);
    expect(cache.get('b')).toBe(2);
    cache.set('c', 4);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(3);
  });

  it('retains valid entries when expired entries can be reclaimed', () => {
    let t = 0;
    const cache = new TtlCache<number>(1000, () => t, 2);
    cache.set('expired', 1);
    t = 500;
    cache.set('valid', 2);
    t = 1000;
    cache.set('new', 3);
    expect(cache.get('expired')).toBeUndefined();
    expect(cache.get('valid')).toBe(2);
    expect(cache.get('new')).toBe(3);
  });
  it('returns a stored value within the TTL', () => {
    let t = 0;
    const cache = new TtlCache<number>(1000, () => t);
    cache.set('a', 42);
    t = 999;
    expect(cache.get('a')).toBe(42);
  });

  it('expires a value once the TTL has elapsed', () => {
    let t = 0;
    const cache = new TtlCache<number>(1000, () => t);
    cache.set('a', 42);
    t = 1000;
    expect(cache.get('a')).toBeUndefined();
  });

  it('returns undefined for an unknown key', () => {
    const cache = new TtlCache<number>(1000, () => 0);
    expect(cache.get('missing')).toBeUndefined();
  });

  it('keeps distinct keys independent', () => {
    let t = 0;
    const cache = new TtlCache<string>(1000, () => t);
    cache.set('a', 'x');
    t = 500;
    cache.set('b', 'y');
    t = 1000; // 'a' expired (set at 0), 'b' still valid (set at 500, expires 1500)
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe('y');
  });

  it('clear() empties the cache', () => {
    const cache = new TtlCache<number>(1000, () => 0);
    cache.set('a', 1);
    cache.clear();
    expect(cache.get('a')).toBeUndefined();
  });
});
