import { createFloatingRefreshButton } from "places-shared/ui";
import { MarkdownPostProcessorContext, MarkdownRenderChild } from "obsidian";
import { BlockRefreshRegistry, resolveAutoRefreshSetting } from "../services/BlockRefreshRegistry";
import { parseCodeBlock } from "../services/CodeBlockParser";

interface RefreshableCodeBlockOptions {
  source: string;
  el: HTMLElement;
  ctx: MarkdownPostProcessorContext;
  process: (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => Promise<void>;
  ariaLabel?: string;
  onError?: (error: unknown) => void;
  cleanup?: () => void;
  shouldAutoRefresh?: (changedPath?: string) => boolean;
  // True when the block's settings resolve {parameter.*}; note-scoped parameter changes then re-render it.
  usesParameters?: boolean;
}

export function registerRefreshableCodeBlock(options: RefreshableCodeBlockOptions): void {
  const { source, el, ctx, process, cleanup } = options;
  const registration = BlockRefreshRegistry.register(el, {
    onRefresh: async () => {
      cleanup?.();
      el.empty();
      await process(source, el, ctx);
    },
    autoRefresh: resolveAutoRefreshSetting(parseCodeBlock(source).settings.autorefresh),
    shouldAutoRefresh: options.shouldAutoRefresh,
    sourcePath: ctx.sourcePath,
    usesParameters: options.usesParameters,
  });
  const lifecycle = new MarkdownRenderChild(el);
  lifecycle.register(() => BlockRefreshRegistry.unregister(el, registration));
  ctx.addChild(lifecycle);

  if (!options.ariaLabel) return;
  createFloatingRefreshButton({
    buttonContainer: el.createDiv('places-floating-buttons'),
    ariaLabel: options.ariaLabel,
    onRefresh: () => BlockRefreshRegistry.refreshForElement(el),
    onError: options.onError,
  });
}

// Obsidian re-indexes a note on every save, and index changes auto-refresh data blocks.
export function createOwnNoteEditRefreshGuard(source: string, sourcePath: string | undefined): (changedPath?: string) => boolean {
  // `{this.*}` (VaultQuery, in SQL) and `{note.*}` (frontmatter, in settings)
  // both make the block depend on its own note.
  const referencesCurrentNote = /\{(this|note)\./i.test(source);
  return (changedPath) => {
    if (!changedPath || !sourcePath) return true;
    return changedPath !== sourcePath || referencesCurrentNote;
  };
}

export function renderHoverPlaceholder(el: HTMLElement, text: string): boolean {
  if (!el.closest('.popover.hover-popover')) return false;
  el.createDiv({ cls: 'places-popover-placeholder', text });
  return true;
}
