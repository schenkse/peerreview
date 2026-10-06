/// <reference types="vite/client" />
// @vitest-environment jsdom
import html from '../index.html?raw';
import { afterEach, expect, it, vi } from 'vitest';
import { searchAuthors } from './api';
import { NetworkBuilder } from './network-builder';
import type { GraphState } from './graph-state';

vi.mock('./api', () => ({ searchAuthors: vi.fn() }));
vi.mock('./graph-renderer', () => ({ GraphRenderer: class {} }));
vi.mock('./network-builder', () => ({
  NetworkBuilder: vi.fn(class {
    constructor(public graph: GraphState) {}
    cancel = vi.fn();
    build = vi.fn(async (bai: string, name: string, recid: number) => {
      this.graph.addNode({ id: String(recid), recid, name, bai, isRoot: true });
    });
  }),
}));

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('returns from the graph to home through the existing accessible button', async () => {
  vi.useFakeTimers();
  document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
  document.body.dataset.view = 'landing';
  vi.mocked(searchAuthors).mockResolvedValue({ hits: { total: 1, hits: [{
    id: '1', metadata: { control_number: 1, name: { value: 'Root' },
      ids: [{ schema: 'INSPIRE BAI', value: 'Root.1' }] },
  }] } });
  await import('./main');
  const input = document.querySelector<HTMLInputElement>('.search-input')!;
  input.value = 'Root';
  input.dispatchEvent(new Event('input'));
  await vi.advanceTimersByTimeAsync(300);
  document.querySelector<HTMLElement>('[role="option"]')!.click();
  expect(document.body.dataset.view).toBe('graph');
  expect(document.querySelector('#publication-filter')?.textContent).toBe('Papers with at most 10 authors');
  expect(document.querySelector('#bar-search .search-input')).toBe(input);
  expect(document.querySelector('#summary')?.textContent).toContain('Root has 0 co-authors here, with 0 connections in this network.');
  const home = document.querySelector<HTMLButtonElement>('#home')!;
  expect(home.getAttribute('aria-label')).toBe('Return to home');
  expect(home.querySelector('.home-icon')?.getAttribute('aria-hidden')).toBe('true');
  home.click();
  const builder = vi.mocked(NetworkBuilder).mock.results[0].value;
  expect(builder.cancel).toHaveBeenCalledTimes(2);
  expect((builder as unknown as { graph: GraphState }).graph.nodeCount).toBe(0);
  expect(document.body.dataset.view).toBe('landing');
  expect(document.querySelector('.hero .search-input')).toBe(input);
  expect(input.value).toBe('');
  expect(document.querySelector('#summary')?.textContent).toBe('');
  expect(document.querySelector('#progress')?.classList.contains('visible')).toBe(false);
});
