export type ExtensionReloadHandler = (pluginIds: readonly string[]) => void | Promise<void>;

export class ExtensionReloadScheduler {
  private readonly pending = new Set<string>();
  private timer: number | null = null;

  constructor(private readonly reload: ExtensionReloadHandler, private readonly delayMs = 500, private readonly onError: (error: unknown) => void = () => {}) {}

  schedule(pluginId: string): void {
    this.pending.add(pluginId);
    this.restartTimer();
  }

  scheduleAll(pluginIds: Iterable<string>): void {
    for (const pluginId of pluginIds) this.pending.add(pluginId);
    if (this.pending.size > 0) this.restartTimer();
  }

  cancel(pluginId: string): void {
    this.pending.delete(pluginId);
  }

  dispose(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }

  private restartTimer(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      const pluginIds = [...this.pending];

      this.pending.clear();
      void Promise.resolve(this.reload(pluginIds)).catch(this.onError);
    }, this.delayMs);
  }
}
