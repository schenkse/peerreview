import { SEARCH_DEBOUNCE_MS } from './constants';
import { searchAuthors } from './api';
import type { InspireAuthorHit } from './types';

export type AuthorSelectedCallback = (bai: string, name: string, recid: number) => void;

export class SearchUI {
  private input: HTMLInputElement;
  private dropdown: HTMLDivElement;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private abortController: AbortController | null = null;

  constructor(
    container: HTMLElement,
    private onAuthorSelected: AuthorSelectedCallback,
  ) {
    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.placeholder = 'Search researcher (e.g. Higgs, Peter)';
    this.input.className = 'search-input';

    this.dropdown = document.createElement('div');
    this.dropdown.className = 'search-dropdown';

    container.appendChild(this.input);
    container.appendChild(this.dropdown);

    this.input.addEventListener('input', () => this.onInput());
    this.input.addEventListener('focus', () => {
      if (this.dropdown.children.length > 0) {
        this.dropdown.classList.add('visible');
      }
    });

    document.addEventListener('click', (e) => {
      if (!container.contains(e.target as Node)) {
        this.dropdown.classList.remove('visible');
      }
    });
  }

  private onInput(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.abortController) this.abortController.abort();

    const query = this.input.value.trim();
    if (query.length < 2) {
      this.hideDropdown();
      return;
    }

    this.debounceTimer = setTimeout(() => this.search(query), SEARCH_DEBOUNCE_MS);
  }

  private async search(query: string): Promise<void> {
    this.abortController = new AbortController();

    try {
      const result = await searchAuthors(query, this.abortController.signal);
      this.renderDropdown(result.hits.hits);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      console.error('Search failed:', err);
      this.hideDropdown();
    }
  }

  private renderDropdown(authors: InspireAuthorHit[]): void {
    this.dropdown.innerHTML = '';

    for (const author of authors) {
      if (author.metadata.stub) continue;

      const bai = author.metadata.ids?.find((id) => id.schema === 'INSPIRE BAI')?.value;
      if (!bai) continue;

      const item = document.createElement('div');
      item.className = 'search-dropdown-item';

      const name = author.metadata.name.preferred_name || author.metadata.name.value;
      const currentPosition = author.metadata.positions?.find((p) => p.current);
      const institution = currentPosition?.institution ?? '';

      item.innerHTML = `
        <span class="author-name">${this.escapeHtml(name)}</span>
        ${institution ? `<span class="author-institution">${this.escapeHtml(institution)}</span>` : ''}
        <span class="author-bai">${this.escapeHtml(bai)}</span>
      `;

      item.addEventListener('click', () => {
        this.input.value = name;
        this.hideDropdown();
        this.onAuthorSelected(bai, name, author.metadata.control_number);
      });

      this.dropdown.appendChild(item);
    }

    if (this.dropdown.children.length === 0) {
      const msg = document.createElement('div');
      msg.className = 'search-dropdown-item search-dropdown-empty';
      msg.textContent = authors.length === 0 ? 'No results found.' : 'No indexed authors found (missing INSPIRE BAI).';
      this.dropdown.appendChild(msg);
    }

    this.dropdown.classList.add('visible');
  }

  private hideDropdown(): void {
    this.dropdown.classList.remove('visible');
    this.dropdown.innerHTML = '';
  }

  private escapeHtml(str: string): string {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}
