// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { searchAuthors } from './api';
import { SEARCH_DEBOUNCE_MS } from './constants';
import { SearchUI, type AuthorSelectedCallback } from './search';
import type { InspireAuthorHit } from './types';

vi.mock('./api', () => ({ searchAuthors: vi.fn() }));

function author(recid: number, name = `Author ${recid}`): InspireAuthorHit {
  return { id: String(recid), metadata: { control_number: recid,
    name: { value: name }, ids: [{ schema: 'INSPIRE BAI', value: `Author.${recid}` }] } };
}

let container: HTMLDivElement;
let input: HTMLInputElement;
let onSelected: Mock<AuthorSelectedCallback>;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.replaceChildren(container);
  onSelected = vi.fn();
  new SearchUI(container, onSelected);
  input = container.querySelector('input')!;
  vi.mocked(searchAuthors).mockResolvedValue({ hits: { hits: [author(1), author(2)], total: 2 } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

async function search(query = 'Author') {
  input.value = query;
  input.dispatchEvent(new Event('input'));
  await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
}

describe('SearchUI', () => {
  it('keeps focus on the combobox while arrows and Enter select an author', async () => {
    input.focus();
    await search();
    expect(input.getAttribute('aria-expanded')).toBe('true');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(input.getAttribute('aria-activedescendant')).toBe('author-option-1');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(input.getAttribute('aria-activedescendant')).toBe('author-option-2');
    expect(container.querySelector('[aria-selected="true"]')?.id).toBe('author-option-2');
    expect(document.activeElement).toBe(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onSelected).toHaveBeenCalledWith('Author.2', 'Author 2', 2);
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
  });

  it('ArrowUp initially selects the last suggestion and navigation wraps', async () => {
    await search();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    expect(input.getAttribute('aria-activedescendant')).toBe('author-option-2');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(input.getAttribute('aria-activedescendant')).toBe('author-option-1');
  });

  it('Escape cancels pending results and Tab leaves normal focus navigation intact', async () => {
    let resolve!: (result: {hits: {hits: InspireAuthorHit[]; total: number}}) => void;
    vi.mocked(searchAuthors).mockReturnValue(new Promise(r => { resolve = r; }));
    await search();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    resolve({ hits: { hits: [author(1)], total: 1 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(input.getAttribute('aria-expanded')).toBe('false');
    vi.mocked(searchAuthors).mockResolvedValue({ hits: { hits: [author(1)], total: 1 } });
    await search('Next author');
    const tab = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
    input.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  it('does not select the empty-results message with the keyboard', async () => {
    vi.mocked(searchAuthors).mockResolvedValue({ hits: { hits: [], total: 0 } });
    await search();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(onSelected).not.toHaveBeenCalled();
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
  });
  it('renders API values as plain text and selects the original author', async () => {
    const name = '<img src=x onerror=alert(1)>';
    const result = author(1, name);
    result.metadata.positions = [{ current: true, institution: '<script>bad()</script>' }];
    vi.mocked(searchAuthors).mockResolvedValue({ hits: { hits: [result], total: 1 } });
    await search();
    expect(container.querySelector('img, script')).toBeNull();
    expect(container.querySelector('.author-name')?.textContent).toBe(name);
    expect(container.querySelector('.author-institution')?.textContent).toBe('<script>bad()</script>');
    (container.querySelector('.search-dropdown-item') as HTMLElement).click();
    expect(onSelected).toHaveBeenCalledWith('Author.1', name, 1);
    expect(input.value).toBe(name);
  });
});
