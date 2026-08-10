import { App } from "obsidian";
import { MapPlaceOverlay } from "places-shared/place";
import { buildOverlayFromFieldsDetailed } from "./OverlayFieldUtils";

interface DecodedOverlayEntry {
  mtime: number;
  size: number;
  overlay: MapPlaceOverlay | undefined;
  errors: string[];
}

const MAX_ENTRIES = 1000;
const decodedByPath = new Map<string, DecodedOverlayEntry>();

// One mtime+size keyed decode shared by the VaultQuery, Dataview, and
// frontmatter paths. A hit returns the previously built overlay object;
// downstream per-overlay hashes memoize on that reference stability.
//
// `stat` supplies the note's mtime+size directly (the VaultQuery path reads
// the `note_modified`/`note_size` view columns); omitted, the stat resolves
// from the vault.
export function decodeOverlayFieldsCached(app: App, path: string | undefined, overlaySource?: string, overlayCache?: string, stat?: { mtime: number; size: number }): MapPlaceOverlay | undefined {
  return decodeOverlayFieldsDetailedCached(app, path, overlaySource, overlayCache, stat).overlay;
}

export function decodeOverlayFieldsDetailedCached(app: App, path: string | undefined, overlaySource?: string, overlayCache?: string, stat?: { mtime: number; size: number }): { overlay?: MapPlaceOverlay; errors: string[] } {
  if (!overlaySource && !overlayCache) return { errors: [] };

  const resolvedStat = stat ?? (path ? app.vault.getFileByPath(path)?.stat : undefined);
  if (!path || !resolvedStat) {
    return buildOverlayFromFieldsDetailed(overlaySource, overlayCache, path);
  }

  const hit = decodedByPath.get(path);
  if (hit && hit.mtime === resolvedStat.mtime && hit.size === resolvedStat.size) {
    decodedByPath.delete(path);
    decodedByPath.set(path, hit);
    return { overlay: hit.overlay, errors: hit.errors };
  }

  const result = buildOverlayFromFieldsDetailed(overlaySource, overlayCache, path);
  decodedByPath.set(path, { mtime: resolvedStat.mtime, size: resolvedStat.size, overlay: result.overlay, errors: result.errors });
  if (decodedByPath.size > MAX_ENTRIES) {
    const oldest = decodedByPath.keys().next().value;
    if (oldest !== undefined) decodedByPath.delete(oldest);
  }
  return result;
}
