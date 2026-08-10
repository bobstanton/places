import type * as GeoJSON from "geojson";
import { type DirectionsOverlayRequest, type IsochroneOverlayRequest, type RouteOverlayCapabilities, type RouteOverlayService } from "places-shared/services";
import { CACHE_DEFAULT, describeCachePolicy, isCacheEntryStale } from "places-shared/settings";
import { getErrorMessage, hashString36, logger as rootLogger } from "places-shared/utils";

const logger = rootLogger.scope("RouteOverlays");
const CACHE_PREFIX = "places.routeOverlayCache.v3";
// What `cache: true` means for route overlays: keep the entry until capacity
// eviction removes it. A road network does not change on a schedule, and age is
// only a limit when the block asks for one (`cache: 7d`, `cache: 2027-01-01`).
const ROUTE_OVERLAY_DEFAULT_MAX_AGE_MS = Infinity;
export const ROUTE_OVERLAY_MAX_CACHE_ENTRIES = 100;
export const DEFAULT_ROUTE_OVERLAY_CAPABILITIES: RouteOverlayCapabilities = {
  routeOptimization: false,
  distanceIsochrones: false,
  polygonIsochrones: false,
};

export interface CachedRouteOverlay {
  t: number;
  d: GeoJSON.FeatureCollection;
}

export interface RouteOverlayCacheStorage {
  get(key: string, options?: { ignoreErrors?: boolean }): CachedRouteOverlay | null;
  set(key: string, entry: CachedRouteOverlay): void | Promise<void>;
}

class LocalStorageRouteOverlayCacheStorage implements RouteOverlayCacheStorage {
  get(key: string, options: { ignoreErrors?: boolean } = {}): CachedRouteOverlay | null {
    try {
      const raw = activeWindow.localStorage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as CachedRouteOverlay;
      return isCachedRouteOverlay(parsed) ? parsed : null;
    } catch (error) {
      if (!options.ignoreErrors) {
        logger.warn("Failed to read route overlay cache", { key, error });
      }
      return null;
    }
  }

  set(key: string, entry: CachedRouteOverlay): void {
    try {
      activeWindow.localStorage.setItem(key, JSON.stringify(entry));
      this.prune();
    } catch (error) {
      logger.warn("Failed to write route overlay cache", { key, error });
    }
  }

  private prune(): void {
    const keys: string[] = [];
    for (let index = 0; index < activeWindow.localStorage.length; index++) {
      const key = activeWindow.localStorage.key(index);
      if (key?.startsWith(`${CACHE_PREFIX}:`)) keys.push(key);
    }
    if (keys.length <= ROUTE_OVERLAY_MAX_CACHE_ENTRIES) return;

    // Entries are written by this class as {"t":...,"d":...}; reading the
    // timestamp from the prefix avoids JSON.parsing every multi-KB payload
    // just to sort by age. Unreadable entries sort oldest and get pruned.
    const timestampOf = (key: string): number => {
      const raw = activeWindow.localStorage.getItem(key);
      const match = raw?.slice(0, 32).match(/"t"\s*:\s*(\d+)/);
      return match ? Number(match[1]) : 0;
    };

    keys
      .map(key => ({ key, timestamp: timestampOf(key) }))
      .sort((left, right) => left.timestamp - right.timestamp)
      .slice(0, keys.length - ROUTE_OVERLAY_MAX_CACHE_ENTRIES)
      .forEach(entry => activeWindow.localStorage.removeItem(entry.key));
  }
}

export class RouteOverlayCachingDecorator implements RouteOverlayService {
  constructor(
    private readonly wrappedService: RouteOverlayService,
    private readonly providerName: string,
    private readonly cacheStorage: RouteOverlayCacheStorage = new LocalStorageRouteOverlayCacheStorage(),
  ) {}

  getProviderName(): string {
    return this.wrappedService.getProviderName();
  }

  getCapabilities(): RouteOverlayCapabilities {
    return this.wrappedService.getCapabilities?.() ?? DEFAULT_ROUTE_OVERLAY_CAPABILITIES;
  }

  async getDirectionsOverlay(request: DirectionsOverlayRequest): Promise<GeoJSON.FeatureCollection> {
    return this.executeWithCache("directions", request, () => this.wrappedService.getDirectionsOverlay(request));
  }

  async getIsochroneOverlay(request: IsochroneOverlayRequest): Promise<GeoJSON.FeatureCollection> {
    return this.executeWithCache("isochrones", request, () => this.wrappedService.getIsochroneOverlay(request));
  }

  private async executeWithCache(kind: "directions" | "isochrones", request: DirectionsOverlayRequest | IsochroneOverlayRequest, fetchOverlay: () => Promise<GeoJSON.FeatureCollection>): Promise<GeoJSON.FeatureCollection> {
    // Traffic-aware isochrones reflect current conditions, and must never be
    // served from the persistent cache.
    const isTrafficRequest = "traffic" in request && request.traffic === true;
    const policy = request.cache ?? CACHE_DEFAULT;
    if (!policy.enabled || isTrafficRequest) {
      logger.debug("route overlay cache bypassed", { provider: this.providerName, kind, reason: isTrafficRequest ? "traffic" : "cache disabled", request: summarizeRequest(request) });
      return this.decorateCachedResult(kind, request, await fetchOverlay());
    }

    const cacheKey = this.getCacheKey(kind, request);
    const cached = this.cacheStorage.get(cacheKey);
    if (cached && !isCacheEntryStale(policy, cached.t, ROUTE_OVERLAY_DEFAULT_MAX_AGE_MS)) {
      logger.debug("route overlay cache hit", {
        provider: this.providerName,
        kind,
        cachedAt: new Date(cached.t).toISOString(),
        cacheKey,
        request: summarizeRequest(request),
      });
      return this.decorateCachedResult(kind, request, cached.d);
    }
    if (cached) {
      logger.debug("route overlay cache entry expired", {
        provider: this.providerName,
        kind,
        cachedAt: new Date(cached.t).toISOString(),
        cachePolicy: describeCachePolicy(policy),
        cacheKey,
      });
    }

    try {
      logger.debug("route overlay fetch started", {
        provider: this.providerName,
        kind,
        cacheKey,
        request: summarizeRequest(request),
      });
      const result = this.decorateCachedResult(kind, request, await fetchOverlay());
      logger.debug("route overlay fetch complete", {
        provider: this.providerName,
        kind,
        cacheKey,
        featureCount: result.features?.length ?? 0,
      });
      // write() stringifies into localStorage, and the caller can keep this
      // object without a defensive clone.
      await this.write(cacheKey, result);
      return result;
    } catch (error) {
      logger.warn("route overlay fetch failed", {
        provider: this.providerName,
        kind,
        cacheKey,
        request: summarizeRequest(request),
        error: getErrorMessage(error),
      });
      throw error;
    }
  }

  private getCacheKey(kind: "directions" | "isochrones", request: DirectionsOverlayRequest | IsochroneOverlayRequest): string {
    // hashString36 output must never change: these keys index localStorage-persisted entries.
    return `${CACHE_PREFIX}:${this.providerName}:${kind}:${hashString36(stableStringify(normalizeRequestForCache(request)))}`;
  }

  // Decorates in place. Every input is already a private object - a fresh
  // provider fetch or a fresh JSON.parse from localStorage.
  private decorateCachedResult(kind: "directions" | "isochrones", request: DirectionsOverlayRequest | IsochroneOverlayRequest, geojson: GeoJSON.FeatureCollection): GeoJSON.FeatureCollection {
    if (kind !== "isochrones" || !("ranges" in request)) {
      return geojson;
    }

    for (const feature of geojson.features ?? []) {
      feature.properties = {
        ...(feature.properties ?? {}),
        mode: request.mode,
      };
    }

    return geojson;
  }

  private async write(key: string, geojson: GeoJSON.FeatureCollection): Promise<void> {
    try {
      await this.cacheStorage.set(key, {
        t: Date.now(),
        d: geojson,
      });
    } catch (error) {
      logger.warn("Failed to write route overlay cache", { key, error });
    }
  }
}

export function isCachedRouteOverlay(value: unknown): value is CachedRouteOverlay {
  const entry = value as CachedRouteOverlay | null | undefined;
  return typeof entry?.t === "number"
    && entry.d?.type === "FeatureCollection"
    && Array.isArray(entry.d.features);
}

function summarizeRequest(request: DirectionsOverlayRequest | IsochroneOverlayRequest): Record<string, unknown> {
  if ("ranges" in request) {
    return {
      mode: request.mode,
      rangeType: request.rangeType,
      ranges: request.ranges,
      centers: request.centers.map((center) => ({
        name: center.name,
        latitude: center.latitude,
        longitude: center.longitude,
      })),
      polygons: request.polygons,
    };
  }

  return {
    mode: request.mode,
    routeCount: request.routes.length,
    waypointCounts: request.routes.map((route) => route.length),
    optimize: request.optimize === true,
    metricLabels: request.metricLabels ?? "total",
    };
}

function normalizeRequestForCache(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeRequestForCache);
  }
  if (value && typeof value === "object") {
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      // `zoom` is render-only and `cache` is a freshness policy, not part of
      // the request's identity - changing `cache: 1h` to `cache: 2h` must
      // re-check the same entry, not address a different one.
      if (key === "zoom" || key === "cache") continue;
      const raw = (value as Record<string, unknown>)[key];
      if (typeof raw === "number") {
        normalized[key] = Number.isFinite(raw) ? Number(raw.toFixed(6)) : raw;
      } else {
        normalized[key] = normalizeRequestForCache(raw);
      }
    }
    return normalized;
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeRequestForCache(value));
}

