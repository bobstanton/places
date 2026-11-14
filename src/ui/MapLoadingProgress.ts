import { MarkdownRenderChild } from 'obsidian';

export class MapLoadingProgress extends MarkdownRenderChild {
  private readonly bar: HTMLElement;
  private readonly label: HTMLElement;
  private readonly timer: number;
  private phase = 'Loading places...';
  private indexing = false;

  constructor(container: HTMLElement, private readonly readProgress: () => { current: number; total: number } | undefined) {
    super(container);
    this.bar = container.createDiv({
      cls: 'places-refresh-progress places-map-startup-progress',
      attr: { role: 'progressbar', 'aria-label': 'Loading places' },
    });
    this.label = container.createDiv({ cls: 'places-loading-text places-map-startup-status' });
    this.update();
    this.timer = window.setInterval(() => this.update(), 250);
  }

  setPhase(phase: string, indexing = false): void {
    this.phase = phase;
    this.indexing = indexing;
    this.update();
  }

  private update(): void {
    if (this.bar.parentElement !== this.containerEl) this.containerEl.append(this.bar);
    if (this.label.parentElement !== this.containerEl) this.containerEl.append(this.label);
    const progress = this.indexing ? this.readProgress() : undefined;
    const measured = progress && Number.isFinite(progress.current) && Number.isFinite(progress.total) && progress.total > 0;

    this.bar.toggleClass('is-determinate', Boolean(measured));
    let text = this.phase;

    if (measured) {
      const current = Math.max(0, Math.min(progress.current, progress.total));

      this.bar.setAttribute('aria-valuemin', '0');
      this.bar.setAttribute('aria-valuemax', String(progress.total));
      this.bar.setAttribute('aria-valuenow', String(current));
      this.bar.style.setProperty('--places-startup-progress', `${current / progress.total * 100}%`);
      text = `Indexing notes (${current.toLocaleString()} / ${progress.total.toLocaleString()})`;
    } else {
      this.bar.removeAttribute('aria-valuenow');
      this.bar.removeAttribute('aria-valuemin');
      this.bar.removeAttribute('aria-valuemax');
    }

    this.bar.setAttribute('aria-valuetext', text);
    this.bar.setAttribute('aria-label', this.indexing ? 'Indexing notes' : 'Loading places');
    this.label.textContent = text;
  }

  override onunload(): void { this.remove(); }

  remove(): void {
    window.clearInterval(this.timer);
    this.bar.remove();
    this.label.remove();
  }
}
