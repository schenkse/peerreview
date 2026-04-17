import type { NetworkProgress } from './types';

export class ProgressIndicator {
  private bar: HTMLDivElement;
  private text: HTMLSpanElement;
  private fill: HTMLDivElement;

  constructor(
    private container: HTMLElement,
    private hideDelayMs = 5000,
  ) {
    this.container.className = 'progress-container';

    this.text = document.createElement('span');
    this.text.className = 'progress-text';

    this.bar = document.createElement('div');
    this.bar.className = 'progress-bar';

    this.fill = document.createElement('div');
    this.fill.className = 'progress-fill';

    this.bar.appendChild(this.fill);
    this.container.appendChild(this.text);
    this.container.appendChild(this.bar);

    this.hide();
  }

  update(progress: NetworkProgress): void {
    this.container.classList.add('visible');
    this.text.textContent = progress.message;

    if (progress.phase === 'fetching-coauthors' && progress.totalCoauthors > 0) {
      const pct = (progress.completedCoauthors / progress.totalCoauthors) * 100;
      this.bar.classList.add('visible');
      this.fill.style.width = `${pct}%`;
    } else if (progress.phase === 'fetching-root') {
      this.bar.classList.add('visible');
      this.fill.style.width = '0%';
      this.fill.classList.add('indeterminate');
    } else {
      this.fill.classList.remove('indeterminate');
      if (progress.phase === 'done' || progress.phase === 'error') {
        this.fill.style.width = '100%';
        // Auto-hide after a delay on completion
        if (progress.phase === 'done') {
          setTimeout(() => this.hide(), this.hideDelayMs);
        }
      }
    }
  }

  show(): void {
    this.container.classList.add('visible');
  }

  hide(): void {
    this.container.classList.remove('visible');
    this.bar.classList.remove('visible');
    this.fill.classList.remove('indeterminate');
    this.fill.style.width = '0%';
    this.text.textContent = '';
  }
}
