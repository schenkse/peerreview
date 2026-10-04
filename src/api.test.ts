import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, searchAuthors } from './api';
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
