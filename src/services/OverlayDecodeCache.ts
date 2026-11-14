import { fnvHash64 } from "places-shared/utils";
import { type OverlayLoadMetrics } from "../core/OverlayLoadMetrics";
import { MapPlaceOverlay } from "places-shared/place";
import { buildOverlayFromFieldsDetailed } from "./OverlayFieldUtils";
import { geoJsonFootprint } from "places-shared/geo";

interface DecodedOverlayEntry {
  mtime?: number;
  size?: number;
  contentHash: string;
  overlay: MapPlaceOverlay | undefined;
  errors: string[];
  bytes: number;
}

const MAX_ENTRIES = 1000;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
let maxBytes = DEFAULT_MAX_BYTES;
const decodedByPath = new Map<string, DecodedOverlayEntry>();
let cachedBytes = 0;
let probationPath: string | undefined;
let admissions = 0;
const ORDINARY_ADMISSION_INTERVAL = 32;

export function overlayDecodeCacheStats(): { entries: number; estimatedBytes: number; budgetBytes: number } {
  return { entries: decodedByPath.size, estimatedBytes: cachedBytes, budgetBytes: maxBytes };
}

export function configureOverlayDecodeCache(options: { maxSizeMB?: number }): void {
  const next = options.maxSizeMB !== undefined && options.maxSizeMB > 0
    ? Math.floor(options.maxSizeMB) * 1024 * 1024
    : DEFAULT_MAX_BYTES;

  if (next === maxBytes) return;
  maxBytes = next;
  evictToBudget(0);
}

function evictToBudget(incoming: number): void {
  while (decodedByPath.size >= MAX_ENTRIES || (cachedBytes + incoming > maxBytes && decodedByPath.size > 0)) {
    const oldest = probationPath ?? decodedByPath.keys().next().value;

    if (oldest === undefined) break;
    forget(oldest);
  }
}

function contentHashOf(overlaySource: string | undefined, overlayCache: string | undefined): string {
  return fnvHash64(`${overlaySource === undefined ? '\u0000' : overlaySource}\u0001${overlayCache === undefined ? '\u0000' : overlayCache}`);
}

function forget(path: string): void {
  const entry = decodedByPath.get(path);

  if (!entry) return;
  cachedBytes -= entry.bytes;
  decodedByPath.delete(path);
  if (probationPath === path) probationPath = undefined;
}

export function decodeOverlayFieldsDetailedCached(path: string | undefined, overlaySource?: string | Uint8Array, overlayCache?: string, stat?: { mtime: number; size: number }, metrics?: OverlayLoadMetrics): { overlay?: MapPlaceOverlay; errors: string[] } {
  if (!overlaySource && !overlayCache) return { errors: [] };

  if (!path || (overlaySource !== undefined && typeof overlaySource !== 'string')) {
    if (metrics) metrics.counts.cacheBypasses++;

    return buildOverlayFromFieldsDetailed(overlaySource, overlayCache, path, undefined, metrics);
  }

  const contentHash = contentHashOf(overlaySource, overlayCache);
  const hit = decodedByPath.get(path);

  if (hit && hit.mtime === stat?.mtime && hit.size === stat?.size && hit.contentHash === contentHash) {
    if (metrics) metrics.counts.cacheHits++;
    if (probationPath === path) probationPath = undefined;
    decodedByPath.delete(path);
    decodedByPath.set(path, hit);

    return { overlay: hit.overlay, errors: hit.errors };
  }

  if (metrics) metrics.counts.cacheMisses++;
  const result = buildOverlayFromFieldsDetailed(overlaySource, overlayCache, path, undefined, metrics);

  forget(path);
  const footprint = result.overlay?.geojson ? geoJsonFootprint(result.overlay.geojson) : undefined;
  const bytes = footprint ? footprint.estimatedBytes + footprint.vertices * 16 : 128;

  if (bytes > maxBytes) return result;
  evictToBudget(bytes);
  decodedByPath.set(path, { mtime: stat?.mtime, size: stat?.size, contentHash, overlay: result.overlay, errors: result.errors, bytes });
  cachedBytes += bytes;
  probationPath = ++admissions % ORDINARY_ADMISSION_INTERVAL === 0 ? undefined : path;

  return result;
}
