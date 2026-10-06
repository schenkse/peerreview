import { RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_MS } from './constants';

export type RequestPriority = 'interactive' | 'background';

interface QueueEntry {
  priority: RequestPriority;
  order: number;
  url: string;
  signal?: AbortSignal;
  resolve: (res: Response) => void;
  reject: (err: Error) => void;
  removeAbortListener?: () => void;
  retries: number;
}

export class RateLimiter {
  private nextOrder = 0;
  private timestamps: number[] = [];
  private queue: QueueEntry[] = [];
  private drainScheduled = false;
  private remaining: number | null = null;
  private resetAt: number | null = null;
  private retryAt = 0;

  enqueue(url: string, signal?: AbortSignal, priority: RequestPriority = 'background'): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }

      const entry: QueueEntry = { url, signal, resolve, reject, retries: 0, priority, order: this.nextOrder++ };

      if (signal) {
        const onAbort = () => {
          const idx = this.queue.indexOf(entry);
          if (idx !== -1) {
            this.queue.splice(idx, 1);
            this.settle(entry);
            reject(new DOMException('Aborted', 'AbortError'));
          }
        };
        signal.addEventListener('abort', onAbort);
        entry.removeAbortListener = () => signal.removeEventListener('abort', onAbort);
      }

      this.queue.push(entry);
      this.drain();
    });
  }

  private drain(): void {
    const now = Date.now();

    // Remove expired timestamps from the sliding window
    this.timestamps = this.timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);

    // Retries keep their original place within their priority class.
    this.queue.sort((a, b) => Number(b.priority === 'interactive') - Number(a.priority === 'interactive') || a.order - b.order);
    while (this.queue.length > 0 && this.canSend(now)) {
      const entry = this.queue.shift()!;

      if (entry.signal?.aborted) {
        this.settle(entry);
        entry.reject(new DOMException('Aborted', 'AbortError'));
        continue;
      }

      this.timestamps.push(now);
      if (this.remaining !== null) this.remaining--;

      this.executeRequest(entry);
    }

    // Schedule next drain if queue is non-empty
    if (this.queue.length > 0 && !this.drainScheduled) {
      this.drainScheduled = true;
      const delay = this.getNextSlotDelay(now);
      setTimeout(() => {
        this.drainScheduled = false;
        this.drain();
      }, delay);
    }
  }

  private canSend(now: number): boolean {
    if (now < this.retryAt) return false;
    // If we have API-reported remaining count, use it
    if (this.remaining !== null && this.resetAt !== null) {
      if (this.remaining <= 0 && now < this.resetAt) {
        return false;
      }
    }

    // Fall back to local sliding window
    return this.timestamps.length < RATE_LIMIT_MAX_REQUESTS;
  }

  private getNextSlotDelay(now: number): number {
    const localReset = this.timestamps.length >= RATE_LIMIT_MAX_REQUESTS
      ? this.timestamps[0] + RATE_LIMIT_WINDOW_MS
      : now;
    const serverReset = this.remaining !== null && this.remaining <= 0
      ? this.resetAt ?? now
      : now;
    return Math.max(this.retryAt, localReset, serverReset, now) - now + 50;
  }

  private settle(entry: QueueEntry): void {
    entry.removeAbortListener?.();
    entry.removeAbortListener = undefined;
  }

  private async executeRequest(entry: QueueEntry): Promise<void> {
    try {
      const timeoutSignal = AbortSignal.timeout(30_000);
      const signal = entry.signal
        ? AbortSignal.any([entry.signal, timeoutSignal])
        : timeoutSignal;
      const res = await fetch(entry.url, { signal });

      this.updateFromHeaders(res.headers);

      if (res.status === 429) {
        const retryAfter = res.headers.get('Retry-After');
        const now = Date.now();
        const seconds = retryAfter !== null ? Number(retryAfter) : NaN;
        const deadline = Number.isFinite(seconds)
          ? now + Math.max(0, seconds) * 1000
          : Date.parse(retryAfter ?? '');
        // Ordinary response headers must never shorten a 429 cooldown.
        this.retryAt = Math.max(this.retryAt, now + RATE_LIMIT_WINDOW_MS,
          Number.isFinite(deadline) ? deadline : 0, this.resetAt ?? 0);
        if (entry.retries < 3) {
          entry.retries++;
          void res.body?.cancel().catch(() => {});
          this.queue.unshift(entry);
          this.drain();
          return;
        }
      }

      this.settle(entry);
      entry.resolve(res);
    } catch (err) {
      this.settle(entry);
      entry.reject(err as Error);
    }
  }

  private updateFromHeaders(headers: Headers): void {
    const remaining = headers.get('X-RateLimit-Remaining');
    const reset = headers.get('X-RateLimit-Reset');

    if (remaining !== null) {
      const parsed = parseInt(remaining, 10);
      if (Number.isFinite(parsed)) this.remaining = parsed;
    }
    if (reset !== null) {
      const parsed = parseInt(reset, 10);
      if (Number.isFinite(parsed)) this.resetAt = parsed * 1000; // convert seconds to ms
    }
  }
}

export const rateLimiter = new RateLimiter();
