import { MarkdownPostProcessorContext, MarkdownRenderChild } from "obsidian";
import { createLoadingIndicator } from "places-shared/obsidian/ui";
import { MapRefreshService } from "../services/MapRefreshService";
import { createMapRefreshInputResolver } from "./MapRefreshInputs";

export function renderVaultQueryWaitingState(el: HTMLElement, source: string, ctx: MarkdownPostProcessorContext, reprocess: (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => Promise<void>): void {
  el.empty();
  createLoadingIndicator(el, "Indexing notes...");

  const refreshService = MapRefreshService.getInstance();
  const resolveRefreshInputs = createMapRefreshInputResolver(el, source, ctx);
  let retryTimer: number | null = null;
  let waiting = true;

  const clearRetryTimer = (): void => {
    if (retryTimer !== null) {
      window.clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  ctx.addChild(new class extends MarkdownRenderChild {
    onunload(): void {
      clearRetryTimer();
      if (!waiting) return;
      waiting = false;
      refreshService.unregisterMap(el);
    }
  }(el));

  const refreshNow = async (currentSourcePath = ctx.sourcePath): Promise<void> => {
    if (!waiting) return;
    waiting = false;
    clearRetryTimer();
    refreshService.unregisterMap(el);
    const inputs = resolveRefreshInputs(currentSourcePath);

    el.empty();

    await reprocess(inputs.source, el, inputs.ctx);
  };

  refreshService.registerMap(el, {
    sourcePath: ctx.sourcePath,
    usesVaultQuery: true,
    usesDataview: false,
    refresh: refreshNow,
  });

  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    void refreshService.refreshContainerNow(el);
  }, 1500);
}
