import { SEARCH_DEBOUNCE_MS } from './constants';
import { searchAuthors } from './api';
import type { InspireAuthorHit } from './types';

export type AuthorSelectedCallback = (bai: string, name: string, recid: number) => void;

export class SearchUI {
  private input: HTMLInputElement;
  private dropdown: HTMLDivElement;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private abortController: AbortController | null = null;
  private activeIndex = -1;

  constructor(
    container: HTMLElement,
    private onAuthorSelected: AuthorSelectedCallback,
  ) {
    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.placeholder = 'Search researcher (e.g. Higgs, Peter)';
    this.input.className = 'search-input';
    this.input.setAttribute('role', 'combobox');
    this.input.setAttribute('aria-label', 'Search researcher');
    this.input.setAttribute('aria-autocomplete', 'list');
    this.input.setAttribute('aria-expanded', 'false');
    this.input.setAttribute('aria-controls', 'author-suggestions');

    this.dropdown = document.createElement('div');
    this.dropdown.className = 'search-dropdown';
    this.dropdown.id = 'author-suggestions';
    this.dropdown.setAttribute('role', 'listbox');
    this.dropdown.setAttribute('aria-label', 'Researcher suggestions');

    container.appendChild(this.input);
    container.appendChild(this.dropdown);

    this.input.addEventListener('input', () => this.onInput());
    container.addEventListener('keydown', event => this.onKeyDown(event));
    this.input.addEventListener('focus', () => {
      if (this.dropdown.children.length > 0) {
        this.showDropdown();
      }
    });

    document.addEventListener('click', (e) => {
      if (!container.contains(e.target as Node)) {
        this.cancelSearch();
        this.hideDropdown();
      }
    });
  }

  private onInput(): void {
    this.cancelSearch();
    this.hideDropdown();

    const query = this.input.value.trim();
    if (query.length < 2) {
      this.hideDropdown();
      return;
    }

    this.debounceTimer = setTimeout(() => this.search(query), SEARCH_DEBOUNCE_MS);
  }

  private cancelSearch(): void {
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    this.abortController?.abort();
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Tab' && this.dropdown.querySelector('button')) return;
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape' && this.dropdown.classList.contains('visible')) event.preventDefault();
      this.cancelSearch();
      this.hideDropdown();
      return;
    }
    if (event.target !== this.input) return;
    const options = this.dropdown.querySelectorAll<HTMLDivElement>('[role="option"]');
    if (options.length === 0) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      this.activeIndex = this.activeIndex === -1
        ? direction === 1 ? 0 : options.length - 1
        : (this.activeIndex + direction + options.length) % options.length;
      this.showDropdown();
      options.forEach((option, index) => option.setAttribute('aria-selected', String(index === this.activeIndex)));
      const active = options[this.activeIndex];
      this.input.setAttribute('aria-activedescendant', active.id);
      active.scrollIntoView?.({ block: 'nearest' });
    } else if (event.key === 'Enter' && this.activeIndex >= 0) {
      event.preventDefault();
      options[this.activeIndex].click();
    }
  }

  private async search(query: string): Promise<void> {
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    this.renderMessage('Searching...');

    try {
      const result = await searchAuthors(query, signal);
      signal.throwIfAborted();
      this.renderDropdown(result.hits.hits);
    } catch (err) {
      if (signal.aborted || (err as Error).name === 'AbortError') return;
      this.renderMessage('Search failed. Please try again.', true);
    }
  }

  private renderMessage(message: string, retry = false): void {
    this.hideDropdown();
    const status = document.createElement('div');
    status.className = 'search-dropdown-item search-dropdown-empty';
    status.setAttribute('role', 'status');
    status.textContent = message;
    this.dropdown.append(status);
    if (retry) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'search-retry';
      button.textContent = 'Retry';
      button.addEventListener('click', event => {
        event.stopPropagation();
        const query = this.input.value.trim();
        this.cancelSearch();
        this.hideDropdown();
        this.input.focus({ preventScroll: true });
        if (query.length >= 2) void this.search(query);
      });
      this.dropdown.append(button);
    }
    this.showDropdown();
  }

  private renderDropdown(authors: InspireAuthorHit[]): void {
    this.dropdown.replaceChildren();
    this.activeIndex = -1;
    this.input.removeAttribute('aria-activedescendant');

    for (const author of authors) {
      if (author.metadata.stub) continue;

      const bai = author.metadata.ids?.find((id) => id.schema === 'INSPIRE BAI')?.value;
      if (!bai) continue;

      const item = document.createElement('div');
      item.className = 'search-dropdown-item';
      item.id = `author-option-${author.metadata.control_number}`;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', 'false');
      item.addEventListener('mousedown', event => event.preventDefault());

      const name = author.metadata.name.preferred_name || author.metadata.name.value;
      const currentPosition = author.metadata.positions?.find((p) => p.current);
      const institution = currentPosition?.institution ?? '';

      for (const [className, text] of [
        ['author-name', name], ['author-institution', institution], ['author-bai', bai],
      ]) {
        if (!text) continue;
        const span = document.createElement('span');
        span.className = className;
        span.textContent = text;
        item.appendChild(span);
      }

      item.addEventListener('click', () => {
        this.cancelSearch();
        this.input.value = name;
        this.hideDropdown();
        this.onAuthorSelected(bai, name, author.metadata.control_number);
      });

      this.dropdown.appendChild(item);
    }

    if (this.dropdown.children.length === 0) {
      const msg = document.createElement('div');
      msg.className = 'search-dropdown-item search-dropdown-empty';
      msg.setAttribute('role', 'status');
      msg.textContent = authors.length === 0 ? 'No results found.' : 'No indexed authors found (missing INSPIRE BAI).';
      this.dropdown.appendChild(msg);
    }

    this.showDropdown();
  }

  private showDropdown(): void {
    this.dropdown.classList.add('visible');
    this.input.setAttribute('aria-expanded', 'true');
  }

  private hideDropdown(): void {
    this.dropdown.classList.remove('visible');
    this.dropdown.replaceChildren();
    this.activeIndex = -1;
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
  }
}
