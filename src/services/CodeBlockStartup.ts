import { App, MarkdownRenderChild, type MarkdownPostProcessorContext } from 'obsidian';
import { createLoadingIndicator } from "places-shared/obsidian/ui";
import { createLiveCodeBlockContext } from './SourcePathRenames';

type Processor = (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => void | Promise<void>;

class PendingBlock extends MarkdownRenderChild {
  constructor(el: HTMLElement, private readonly cancel: () => void) { super(el); }
  override onunload(): void { this.cancel(); }
}

export class CodeBlockStartup {
  private layoutReady: boolean;
  private metadataResolved = false;
  private disposed = false;
  private readonly pending = new Map<HTMLElement, { ctx: MarkdownPostProcessorContext; render: () => void; cancel: () => void }>();
  private readonly unsubscribe: Array<() => void> = [];

  constructor(private readonly app: App, private readonly onError: (error: unknown, el: HTMLElement) => void) {
    this.layoutReady = app.workspace.layoutReady;
    const changed = app.metadataCache.on('changed', () => this.flush());
    const resolved = app.metadataCache.on('resolved', () => {
      this.metadataResolved = true;
      this.flush();
    });

    this.unsubscribe.push(() => app.metadataCache.offref(changed), () => app.metadataCache.offref(resolved));
    app.workspace.onLayoutReady(() => {
      if (this.disposed) return;
      this.layoutReady = true;
      this.flush();
    });
  }

  process(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext, handler: Processor): void | Promise<void> {
    if (this.disposed) return;
    this.pending.get(el)?.cancel();
    ctx = createLiveCodeBlockContext(this.app, ctx);
    if (this.canRender(ctx)) return handler(source, el, ctx);

    const loading = createLoadingIndicator(el, 'Loading note...');
    let active = true;
    let queued = false;
    const cancel = (): void => {
      active = false;
      if (this.pending.get(el) === entry) this.pending.delete(el);
      loading.remove();
    };
    const entry = {
      ctx,
      cancel,
      render: (): void => {
        if (queued) return;
        queued = true;
        loading.remove();
        void Promise.resolve().then(() => {
          if (!active || this.disposed) return;
          this.pending.delete(el);

          return handler(source, el, ctx);
        }).catch(error => this.onError(error, el));
      },
    };

    this.pending.set(el, entry);
    ctx.addChild(new PendingBlock(el, cancel));
  }

  private canRender(ctx: MarkdownPostProcessorContext): boolean {
    if (!this.layoutReady) return false;
    const file = this.app.vault.getFileByPath(ctx.sourcePath);

    return !file || this.app.metadataCache.getFileCache(file) != null || this.metadataResolved;
  }

  private flush(): void {
    if (this.disposed) return;

    for (const entry of this.pending.values()) {
      if (this.canRender(entry.ctx)) entry.render();
    }
  }

  cleanup(): void {
    this.disposed = true;
    for (const entry of this.pending.values()) entry.cancel();
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
  }
}
