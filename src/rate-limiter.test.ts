import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { RateLimiter } from './rate-limiter';

function okResponse(): Response {
  return new Response('{}', { status: 200 });
}

describe('RateLimiter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('keeps the 429 cooldown when a concurrent success reports available quota', async () => {
    const resolvers: ((res: Response) => void)[] = [];
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => resolvers.push(resolve))));
    const limiter = new RateLimiter();
    const limited = limiter.enqueue('https://x/limited');
    const concurrent = limiter.enqueue('https://x/concurrent');
    resolvers[0](new Response('', { status: 429, headers: { 'Retry-After': '10' } }));
    await Promise.resolve();
    resolvers[1](new Response('', { headers: {
      'X-RateLimit-Remaining': '13',
      'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 5),
    } }));
    await concurrent;
    const next = limiter.enqueue('https://x/next');
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(9999);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(51);
    expect(fetch).toHaveBeenCalledTimes(4);
    resolvers[2](okResponse());
    resolvers[3](okResponse());
    await Promise.all([limited, next]);
  });

  it('bounds retries when the server keeps returning 429', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('', { status: 429 })));
    const pending = new RateLimiter().enqueue('https://x/limited');
    await vi.advanceTimersByTimeAsync(16000);
    expect((await pending).status).toBe(429);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('supports an HTTP date in Retry-After', async () => {
    const retryAt = Math.ceil(Date.now() / 1000) * 1000 + 10000;
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': new Date(retryAt).toUTCString() } }))
      .mockResolvedValueOnce(okResponse()));
    const pending = new RateLimiter().enqueue('https://x/date');
    await vi.advanceTimersByTimeAsync(retryAt - Date.now() - 1);
    expect(fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(51);
    expect((await pending).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('prioritizes searches under exhausted quota and preserves FIFO within each priority', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(url); return okResponse(); }));
    const limiter = new RateLimiter();
    await Promise.all(Array.from({ length: 15 }, (_, i) => limiter.enqueue(`initial-${i}`)));
    const queued = [limiter.enqueue('background-1'), limiter.enqueue('background-2'),
      limiter.enqueue('search-1', undefined, 'interactive'), limiter.enqueue('search-2', undefined, 'interactive')];
    const controller = new AbortController();
    const cancelled = limiter.enqueue('cancelled-search', controller.signal, 'interactive');
    const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await rejected;
    await vi.advanceTimersByTimeAsync(5050);
    await Promise.all(queued);
    expect(calls.slice(15)).toEqual(['search-1', 'search-2', 'background-1', 'background-2']);
  });

  it('retains interactive priority and FIFO when retrying after a server cooldown', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      return calls.length === 1 ? new Response('', { status: 429, headers: { 'Retry-After': '10' } }) : okResponse();
    }));
    const limiter = new RateLimiter();
    const first = limiter.enqueue('search-1', undefined, 'interactive');
    await Promise.resolve();
    const background = limiter.enqueue('background');
    const second = limiter.enqueue('search-2', undefined, 'interactive');
    await vi.advanceTimersByTimeAsync(9999);
    expect(calls).toEqual(['search-1']);
    await vi.advanceTimersByTimeAsync(51);
    await Promise.all([first, background, second]);
    expect(calls).toEqual(['search-1', 'search-1', 'search-2', 'background']);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const rl = new RateLimiter();
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(rl.enqueue('https://x/1', ctrl.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('resolves a request with the fetched response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse()));
    const rl = new RateLimiter();
    const res = await rl.enqueue('https://x/1');
    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('rejects a queued request when its signal aborts before it is sent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse()));
    const rl = new RateLimiter();
    // Saturate the window (RATE_LIMIT_MAX_REQUESTS = 15) so the next one stays queued.
    for (let i = 0; i < 15; i++) rl.enqueue(`https://x/${i}`);
    const ctrl = new AbortController();
    const pending = rl.enqueue('https://x/queued', ctrl.signal);
    ctrl.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
