import type { NetworkProgress } from './types';

// Shows build progress as text in `container` and as a meter appended to `barContainer`.
export class ProgressIndicator {
  private bar: HTMLDivElement;
  private text: HTMLSpanElement;
  private fill: HTMLDivElement;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private container: HTMLElement,
    barContainer: HTMLElement = container,
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
    barContainer.appendChild(this.bar);

    this.hide();
  }

  update(progress: NetworkProgress): void {
    this.clearHideTimer();
    this.container.classList.add('visible');
    this.text.textContent = progress.message;

    if (progress.phase === 'fetching-root' || progress.phase === 'fetching-coauthors') {
      this.bar.classList.add('visible');
      const f = Math.max(0, Math.min(1, progress.fraction ?? 0));
      this.fill.style.width = `${f * 100}%`;
    } else if (progress.phase === 'done' || progress.phase === 'error') {
      // The meter fills up, then fades out (see .progress-bar in style.css).
      this.fill.style.width = '100%';
      this.bar.classList.remove('visible');
      if (progress.phase === 'done') {
        this.hideTimer = setTimeout(() => this.hide(), this.hideDelayMs);
      }
    }
  }

  show(): void {
    this.clearHideTimer();
    this.container.classList.add('visible');
    this.fill.style.width = '0%';
  }

  hide(): void {
    this.clearHideTimer();
    this.container.classList.remove('visible');
    this.bar.classList.remove('visible');
    this.fill.style.width = '0%';
    this.text.textContent = '';
  }

  private clearHideTimer(): void {
    if (this.hideTimer !== null) clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }
}
