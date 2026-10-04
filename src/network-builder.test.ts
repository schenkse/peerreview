import { describe, it, expect, vi } from 'vitest';
import { visitPaginated } from './network-builder';

function pagesFetcher(pages: number[][], total: number) {
  // 1-indexed; pages beyond the array yield an empty page.
  return (page: number) =>
    Promise.resolve({ items: pages[page - 1] ?? [], total });
}

describe('visitPaginated', () => {
  it('stops oversized batch queries after the first page without processing them', async () => {
    const fetchPage = vi.fn().mockResolvedValue({ items: [1, 2, 3], total: 10001 });
    const onItems = vi.fn();
    const result = await visitPaginated<number>(fetchPage, { itemId: item => item, pageSize: 500, maxWindow: 10000, stopOnOverflow: true, onItems });
    expect(result).toEqual({ count: 0, total: 10001, complete: false });
    expect(fetchPage).toHaveBeenCalledOnce();
    expect(onItems).not.toHaveBeenCalled();
  });
  it('visits all items across pages and stops at total', async () => {
    const items: number[] = [];
    const out = await visitPaginated(pagesFetcher([[1, 2, 3], [4, 5]], 5), {
      itemId: item => item, pageSize: 3,
      maxWindow: 10000,
      onItems: page => items.push(...page),
    });
    expect(items).toEqual([1, 2, 3, 4, 5]);
    expect(out).toEqual({ count: 5, total: 5, complete: true });
  });

  it('stops when a page returns zero items even if total claims more (no infinite loop)', async () => {
    const fetchPage = (page: number) =>
      Promise.resolve({ items: page === 1 ? [1, 2] : [], total: 100 });
    const out = await visitPaginated(fetchPage, { itemId: item => item, pageSize: 2, maxWindow: 10000 });
    expect(out).toEqual({ count: 2, total: 100, complete: false });
  });

  it('stops at the result-window cap', async () => {
    let calls = 0;
    const fetchPage = (page: number) => {
      calls++;
      return Promise.resolve({ items: [page], total: 1_000_000 });
    };
    const out = await visitPaginated<number>(fetchPage, { itemId: item => item, pageSize: 500, maxWindow: 1000 });
    // pageSize 500, window 1000 => stop after page 2 (2*500 = 1000)
    expect(calls).toBe(2);
    expect(out).toEqual({ count: 2, total: 1_000_000, complete: false });
  });

  it('invokes onPage with the page index and total', async () => {
    const seen: Array<[number, number]> = [];
    await visitPaginated(pagesFetcher([[1], [2]], 2), {
      itemId: item => item, pageSize: 1,
      maxWindow: 10000,
      onPage: (p, t) => seen.push([p, t]),
    });
    expect(seen).toEqual([[1, 2], [2, 2]]);
  });

  it('throws AbortError when the signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      visitPaginated(pagesFetcher([[1]], 1), {
        itemId: item => item, pageSize: 1,
        maxWindow: 10,
        signal: ctrl.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});


it('delivers unique IDs once and reports missing records despite a full row count', async () => {
  const fetchPage = vi.fn(pagesFetcher([[1, 2], [2, 3]], 4));
  const items: number[] = [];
  const result = await visitPaginated(fetchPage, {
    itemId: item => item, pageSize: 2, maxWindow: 10000, onItems: page => items.push(...page),
  });
  expect(items).toEqual([1, 2, 3]);
  expect(fetchPage).toHaveBeenCalledTimes(2);
  expect(result).toEqual({ count: 3, total: 4, complete: false });
});

it('does not keep requesting duplicate-only pages past the result window', async () => {
  const fetchPage = vi.fn(async () => ({ items: [1, 1], total: 100 }));
  const result = await visitPaginated(fetchPage, { itemId: item => item, pageSize: 2, maxWindow: 6 });
  expect(fetchPage).toHaveBeenCalledTimes(3);
  expect(result).toEqual({ count: 1, total: 100, complete: false });
});
