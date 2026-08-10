// Session-scoped record of note renames. Obsidian's
// MarkdownPostProcessorContext.sourcePath goes stale for already-rendered code
// blocks after a rename, and refresh closures re-run with the path they
// captured; anything holding a captured path resolves it through here before
// trusting it. Written once per vault rename (MapRefreshService.onFileRenamed),
// read by query-parameter state keys and track-file resolution.
const renamedSourcePaths = new Map<string, string>();

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

export function recordSourcePathRename(oldPath: string, newPath: string): void {
  renamedSourcePaths.set(oldPath, newPath);
}

// Old paths recorded this session, for key-prefix migration scans.
export function renamedSourcePathKeys(): Iterable<string> {
  return renamedSourcePaths.keys();
}
