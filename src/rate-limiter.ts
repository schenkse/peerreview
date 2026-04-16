import { RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_MS } from './constants';

interface QueueEntry {
  url: string;
  signal?: AbortSignal;
  resolve: (res: Response) => void;
  reject: (err: Error) => void;
}

export class RateLimiter {
  private timestamps: number[] = [];
  private queue: QueueEntry[] = [];
  private drainScheduled = false;
  private remaining: number | null = null;
  private resetAt: number | null = null;

  enqueue(url: string, signal?: AbortSignal): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }

      this.queue.push({ url, signal, resolve, reject });

      signal?.addEventListener('abort', () => {
        const idx = this.queue.findIndex((e) => e.url === url && e.resolve === resolve);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
          reject(new DOMException('Aborted', 'AbortError'));
        }
      });

      this.drain();
    });
  }

  private drain(): void {
    const now = Date.now();

    // Remove expired timestamps from the sliding window
    this.timestamps = this.timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);

    while (this.queue.length > 0 && this.canSend(now)) {
      const entry = this.queue.shift()!;

      if (entry.signal?.aborted) {
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
    // If API told us when the reset happens, use that
    if (this.resetAt !== null && now < this.resetAt) {
      return this.resetAt - now + 50; // small buffer
    }

    // Otherwise wait until the oldest timestamp expires
    if (this.timestamps.length > 0) {
      const oldest = this.timestamps[0];
      return oldest + RATE_LIMIT_WINDOW_MS - now + 50;
    }

    return RATE_LIMIT_WINDOW_MS;
  }

  private async executeRequest(entry: QueueEntry): Promise<void> {
    try {
      const res = await fetch(entry.url, { signal: entry.signal });

      this.updateFromHeaders(res.headers);

      if (res.status === 429) {
        // Re-queue at front and wait for reset
        this.queue.unshift(entry);
        const retryAfter = res.headers.get('Retry-After');
        if (retryAfter) {
          this.resetAt = Date.now() + parseInt(retryAfter, 10) * 1000;
        } else {
          this.resetAt = Date.now() + RATE_LIMIT_WINDOW_MS;
        }
        this.remaining = 0;
        this.drain();
        return;
      }

      entry.resolve(res);
    } catch (err) {
      entry.reject(err as Error);
    }
  }

  private updateFromHeaders(headers: Headers): void {
    const remaining = headers.get('X-RateLimit-Remaining');
    const reset = headers.get('X-RateLimit-Reset');

    if (remaining !== null) {
      this.remaining = parseInt(remaining, 10);
    }
    if (reset !== null) {
      this.resetAt = parseInt(reset, 10) * 1000; // convert seconds to ms
    }
  }
}

export const rateLimiter = new RateLimiter();
