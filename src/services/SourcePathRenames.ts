import type { App, MarkdownPostProcessorContext } from 'obsidian';

// Session-scoped record of note renames. Obsidian's
// MarkdownPostProcessorContext.sourcePath goes stale for already-rendered code
// blocks after a rename, and refresh closures re-run with the path they
// captured; anything holding a captured path resolves it through here before
// trusting it. Written once per vault rename (MapRefreshService.onFileRenamed),
// read by code-block refreshes, query-parameter state keys and track-file resolution.
const renamedSourcePaths = new Map<string, string>();
const liveContexts = new WeakSet<MarkdownPostProcessorContext>();
const sourcePathGenerations = new Map<string, number>();
let nextGeneration = 0;

export function recordSourcePathCreation(path: string): void {
  if (!renamedSourcePaths.delete(path)) return;
  sourcePathGenerations.set(path, ++nextGeneration);
}

export function sourcePathStatePrefix(path: string): string {
  path = resolveCurrentSourcePath(path);
  const generation = sourcePathGenerations.get(path);

  return generation ? `${path}:generation:${generation}` : path;
}

// Resolve a source path through every rename seen during this plugin session.
export function resolveCurrentSourcePath(sourcePath: string): string {
  let current = sourcePath;
  const visited = new Set<string>();

  while (renamedSourcePaths.has(current) && !visited.has(current)) {
    visited.add(current);
    current = renamedSourcePaths.get(current)!;
  }

  return current;
}

export function createRefreshContext(ctx: MarkdownPostProcessorContext, currentSourcePath?: string | (() => string)): MarkdownPostProcessorContext {
  if (currentSourcePath === undefined && liveContexts.has(ctx)) return ctx;
  if (ctx.sourcePath === currentSourcePath) return ctx;
  const readPath = typeof currentSourcePath === 'function' ? currentSourcePath
    : () => currentSourcePath ?? resolveCurrentSourcePath(ctx.sourcePath);
  const context = new Proxy(ctx, {
    get(target, property, receiver): unknown {
      return property === 'sourcePath' ? readPath() : Reflect.get(target, property, receiver);
    }
  });

  if (typeof currentSourcePath !== 'string') liveContexts.add(context);

  return context;
}

export function createLiveCodeBlockContext(app: App, ctx: MarkdownPostProcessorContext): MarkdownPostProcessorContext {
  if (liveContexts.has(ctx)) return ctx;
  const file = app.vault.getFileByPath(ctx.sourcePath);

  if (file) recordSourcePathCreation(file.path);

  return createRefreshContext(ctx, () => file?.path ?? resolveCurrentSourcePath(ctx.sourcePath));
}

export function recordSourcePathRename(oldPath: string, newPath: string): void {
  if (oldPath === newPath) return;
  const generation = sourcePathGenerations.has(newPath) || renamedSourcePaths.has(newPath)
    ? ++nextGeneration : sourcePathGenerations.get(oldPath) ?? 0;

  for (const [path, target] of renamedSourcePaths) {
    if (target === oldPath) renamedSourcePaths.set(path, newPath);
  }

  renamedSourcePaths.delete(newPath);
  renamedSourcePaths.set(oldPath, newPath);
  sourcePathGenerations.set(newPath, generation);
}

// Old paths recorded this session, for key-prefix migration scans.
export function renamedSourcePathKeys(): Iterable<string> {
  return renamedSourcePaths.keys();
}
