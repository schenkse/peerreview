import { describe, it, expect, vi, afterEach } from 'vitest';
import { RateLimiter } from './rate-limiter';

function okResponse(): Response {
  return new Response('{}', { status: 200 });
}

describe('RateLimiter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
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
