import { MarkdownPostProcessorContext } from "obsidian";
import { createLoadingIndicator } from "places-shared/ui";
import { MapRefreshService } from "../services/MapRefreshService";
import { createMapRefreshInputResolver } from "./MapRefreshInputs";

// Renders while VaultQuery's API is still starting or its database is still being prepared.
export function renderVaultQueryWaitingState(el: HTMLElement, source: string, ctx: MarkdownPostProcessorContext, reprocess: (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => Promise<void>): void {
  el.empty();
  createLoadingIndicator(el, "Waiting for VaultQuery to finish starting or preparing the database...");

  const refreshService = MapRefreshService.getInstance();
  const resolveRefreshInputs = createMapRefreshInputResolver(el, source, ctx);
  let retryTimer: number | null = null;

  const clearRetryTimer = (): void => {
    if (retryTimer !== null) {
      window.clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const refreshNow = async (currentSourcePath = ctx.sourcePath): Promise<void> => {
    // A successful render registers its own refresh entry.
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
