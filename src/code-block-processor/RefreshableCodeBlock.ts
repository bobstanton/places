import { createFloatingRefreshButton } from "places-shared/obsidian/ui";
import { MarkdownPostProcessorContext, MarkdownRenderChild } from "obsidian";
import { BlockRefreshRegistry, resolveAutoRefreshSetting } from "../services/BlockRefreshRegistry";
import { createRefreshContext, resolveCurrentSourcePath } from '../services/SourcePathRenames';
import { cleanupMapContainer } from '../services/MapSurfaceCleanup';

const MAP_CONTAINER_SELECTOR = '.places-map-container';

interface RefreshableCodeBlockOptions {
  source: string;
  autoRefresh?: unknown;
  el: HTMLElement;
  ctx: MarkdownPostProcessorContext;
  process: (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => Promise<void>;
  ariaLabel?: string;
  onError?: (error: unknown) => void;
  shouldAutoRefresh?: (changedPath?: string) => boolean;
  usesParameters?: boolean;
  query?: string | null;
}

export function registerRefreshableCodeBlock(options: RefreshableCodeBlockOptions): void {
  const { source, el, ctx, process } = options;
  const registration = BlockRefreshRegistry.register(el, {
    onRefresh: async () => {
      for (const mapContainer of el.querySelectorAll<HTMLElement>(MAP_CONTAINER_SELECTOR)) cleanupMapContainer(mapContainer);
      el.empty();

      await process(source, el, createRefreshContext(ctx));
    },
    autoRefresh: resolveAutoRefreshSetting(options.autoRefresh),
    shouldAutoRefresh: options.shouldAutoRefresh,
    sourcePath: ctx.sourcePath,
    usesParameters: options.usesParameters,
    query: options.query,
  });
  const lifecycle = new MarkdownRenderChild(el);

  lifecycle.register(() => BlockRefreshRegistry.unregister(el, registration));
  ctx.addChild(lifecycle);

  if (!options.ariaLabel) return;
  createFloatingRefreshButton({
    ctx,
    buttonContainer: el.createDiv('places-floating-buttons'),
    ariaLabel: options.ariaLabel,
    onRefresh: () => BlockRefreshRegistry.refreshForElement(el),
    onError: options.onError,
  });
}

export function createOwnNoteEditRefreshGuard(source: string, sourcePath: string | undefined, readFrontmatter?: (path: string) => Record<string, unknown>): (changedPath?: string) => boolean {
  const referencesCurrentNote = /\{(this|note)[.[]/i.test(source);
  const frontmatterSignature = (path: string): string => JSON.stringify(
    Object.entries(readFrontmatter?.(path) ?? {}).filter(([key]) => key !== 'position').sort(([a], [b]) => a.localeCompare(b))
  );
  const initialFrontmatter = sourcePath && readFrontmatter ? frontmatterSignature(sourcePath) : undefined;

  return (changedPath) => {
    if (!changedPath || !sourcePath) return true;
    const currentSourcePath = resolveCurrentSourcePath(sourcePath);

    if (currentSourcePath !== sourcePath || changedPath !== currentSourcePath || referencesCurrentNote) return true;

    return initialFrontmatter !== undefined && frontmatterSignature(currentSourcePath) !== initialFrontmatter;
  };
}

export function createTrackFileRefreshGuard(
  source: string,
  sourcePath: string,
  trackInputs: readonly string[],
  resolveTrackFile: (input: string, sourcePath: string) => { path: string } | null,
): (changedPath?: string) => boolean {
  const shouldRefreshOwnNote = createOwnNoteEditRefreshGuard(source, sourcePath);
  const inputs = trackInputs.length ? trackInputs : [sourcePath];
  const dependencies = inputs.map(input => ({ input, file: resolveTrackFile(input, sourcePath) }));

  return changedPath => {
    if (!changedPath) return true;
    const currentSourcePath = resolveCurrentSourcePath(sourcePath);

    for (const dependency of dependencies) {
      const file = resolveTrackFile(dependency.input, currentSourcePath) ?? dependency.file;

      dependency.file = file;

      if (file && changedPath === resolveCurrentSourcePath(file.path)) return true;
    }

    return changedPath === currentSourcePath && shouldRefreshOwnNote(changedPath);
  };
}
