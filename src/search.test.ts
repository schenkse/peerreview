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
