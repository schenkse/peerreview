import { describe, it, expect } from 'vitest';
import { collectPaginated } from './network-builder';

function pagesFetcher(pages: number[][], total: number) {
  // 1-indexed; pages beyond the array yield an empty page.
  return (page: number) =>
    Promise.resolve({ items: pages[page - 1] ?? [], total });
}

describe('collectPaginated', () => {
  it('collects all items across pages and stops at total', async () => {
    const out = await collectPaginated(pagesFetcher([[1, 2, 3], [4, 5]], 5), {
      pageSize: 3,
      maxWindow: 10000,
    });
    expect(out).toEqual([1, 2, 3, 4, 5]);
  });

  it('stops when a page returns zero items even if total claims more (no infinite loop)', async () => {
    const fetchPage = (page: number) =>
      Promise.resolve({ items: page === 1 ? [1, 2] : [], total: 100 });
    const out = await collectPaginated(fetchPage, { pageSize: 2, maxWindow: 10000 });
    expect(out).toEqual([1, 2]);
  });

  it('stops at the result-window cap', async () => {
    let calls = 0;
    const fetchPage = (page: number) => {
      calls++;
      return Promise.resolve({ items: [page], total: 1_000_000 });
    };
    const out = await collectPaginated(fetchPage, { pageSize: 250, maxWindow: 1000 });
    // pageSize 250, window 1000 => stop after page 4 (4*250 = 1000)
    expect(calls).toBe(4);
    expect(out).toEqual([1, 2, 3, 4]);
  });

  it('invokes onPage with the page index and total', async () => {
    const seen: Array<[number, number]> = [];
    await collectPaginated(pagesFetcher([[1], [2]], 2), {
      pageSize: 1,
      maxWindow: 10000,
      onPage: (p, t) => seen.push([p, t]),
    });
    expect(seen).toEqual([[1, 2], [2, 2]]);
  });

  it('throws AbortError when the signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      collectPaginated(pagesFetcher([[1]], 1), {
        pageSize: 1,
        maxWindow: 10,
        signal: ctrl.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
