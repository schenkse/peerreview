import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, searchAuthors, fetchPublications, fetchConnectionPublications, fetchConnectionPublicationsBatch, fetchAuthorProfiles } from './api';
import { rateLimiter } from './rate-limiter';

afterEach(() => vi.restoreAllMocks());

describe('API cancellation', () => {
  it('rejects aborted cache hits without sending a request', async () => {
    const enqueue = vi.spyOn(rateLimiter, 'enqueue').mockResolvedValue(
      new Response(JSON.stringify({ hits: { hits: [], total: 0 } })),
    );
    await searchAuthors('cached author');
    const controller = new AbortController();
    controller.abort();
    await expect(searchAuthors('cached author', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('does not cache a response cancelled while its body was being read', async () => {
    const controller = new AbortController();
    const enqueue = vi.spyOn(rateLimiter, 'enqueue').mockResolvedValue({
      ok: true,
      json: async () => {
        controller.abort();
        return { hits: { hits: [], total: 0 } };
      },
    } as Response);
    await expect(searchAuthors('late body', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    enqueue.mockResolvedValue(new Response(JSON.stringify({ hits: { hits: [], total: 0 } })));
    await searchAuthors('late body');
    expect(enqueue).toHaveBeenCalledTimes(2);
  });
});


it('preserves the HTTP status in API errors', async () => {
  vi.spyOn(rateLimiter, 'enqueue').mockResolvedValue(new Response('', { status: 414, statusText: 'URI too long' }));
  const error = await searchAuthors('query failure').catch(error => error);
  expect(error).toBeInstanceOf(ApiError);
  expect(error.status).toBe(414);
});


it('requests only the fields each operation consumes', async () => {
  const enqueue = vi.spyOn(rateLimiter, 'enqueue').mockImplementation(async () =>
    new Response(JSON.stringify({ hits: { hits: [], total: 0 } })),
  );
  await searchAuthors('field selection');
  await fetchPublications('Root.fields');
  await fetchConnectionPublications('Connection.fields');
  await fetchConnectionPublicationsBatch(['Batch.one', 'Batch.two']);
  await fetchAuthorProfiles([42]);
  const urls = enqueue.mock.calls.map(([url]) => new URL(url));
  expect(urls.map(url => url.searchParams.get('fields'))).toEqual([
    'name,ids,positions,control_number,stub', 'authors.recid,authors.full_name,authors.ids',
    'authors.recid', 'authors.recid', 'control_number,name,ids',
  ]);
  expect(urls.slice(1).map(url => url.searchParams.get('size'))).toEqual(['500', '500', '500', '500']);
  expect(urls[3].searchParams.get('q')).toBe('(a Batch.one or a Batch.two) and ac 1->10');
});
