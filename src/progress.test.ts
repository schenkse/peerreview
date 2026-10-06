// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProgressIndicator } from './progress';
import type { NetworkPhase } from './types';

function progress(phase: NetworkPhase) {
  return { phase, totalCoauthors: 0, completedCoauthors: 0, message: phase, fraction: 0 };
}

afterEach(() => vi.useRealTimers());

describe('ProgressIndicator timers', () => {
  it('keeps the next build visible until its own completion delay elapses', () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    const indicator = new ProgressIndicator(container);
    indicator.update(progress('done'));
    vi.advanceTimersByTime(1000);
    indicator.show();
    indicator.update(progress('fetching-root'));
    vi.advanceTimersByTime(4000);
    expect(container.classList.contains('visible')).toBe(true);
    expect(container.textContent).toBe('fetching-root');
    indicator.update(progress('done'));
    vi.advanceTimersByTime(4999);
    expect(container.classList.contains('visible')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(container.classList.contains('visible')).toBe(false);
  });

  it('does not hide a later error because of an earlier completion', () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    const indicator = new ProgressIndicator(container);
    indicator.update(progress('done'));
    indicator.update(progress('error'));
    vi.advanceTimersByTime(5000);
    expect(container.classList.contains('visible')).toBe(true);
    expect(container.textContent).toBe('error');
  });
});

it.each(['partial', 'error'] as const)('keeps %s visible until explicitly hidden or replaced', async phase => {
  vi.useFakeTimers();
  const container = document.createElement('div');
  const indicator = new ProgressIndicator(container);
  indicator.update({ phase, message: 'Incomplete coverage', totalCoauthors: 0, completedCoauthors: 0 });
  await vi.advanceTimersByTimeAsync(6000);
  expect(container.classList.contains('visible')).toBe(true);
  expect(container.textContent).toBe('Incomplete coverage');
  indicator.update({ phase: 'done', message: 'Done', totalCoauthors: 0, completedCoauthors: 0 });
  await vi.advanceTimersByTimeAsync(5000);
  expect(container.classList.contains('visible')).toBe(false);
});
