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

    if (progress.phase === 'fetching-root' || progress.phase === 'fetching-coauthors') {
      this.bar.classList.add('visible');
      const f = Math.max(0, Math.min(1, progress.fraction ?? 0));
      this.fill.style.width = `${f * 100}%`;
    } else if (progress.phase === 'done' || progress.phase === 'error') {
      this.fill.style.width = '100%';
      if (progress.phase === 'done') {
        setTimeout(() => this.hide(), this.hideDelayMs);
      }
    }
  }

  show(): void {
    this.container.classList.add('visible');
  }

  hide(): void {
    this.container.classList.remove('visible');
    this.bar.classList.remove('visible');
    this.fill.style.width = '0%';
    this.text.textContent = '';
  }
}
