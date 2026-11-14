import type * as GeoJSON from "geojson";
import { CACHE_DEFAULT, describeCachePolicy, isCacheEntryStale } from "places-shared/settings";
import { type DirectionsOverlayRequest, type IsochroneOverlayRequest, type RouteOverlayCapabilities, type RouteOverlayService } from "places-shared/services";
import { getErrorMessage, hashString36, logger as rootLogger } from "places-shared/utils";

const logger = rootLogger.scope("RouteOverlays");

export const ROUTE_OVERLAY_CACHE_PREFIX = "places.routeOverlayCache.v3";
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

export class RouteOverlayCachingDecorator implements RouteOverlayService {
  constructor(private readonly wrappedService: RouteOverlayService, private readonly providerName: string, private readonly cacheStorage: RouteOverlayCacheStorage, private readonly onCacheHit?: () => void) {}

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
      this.onCacheHit?.();

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
    return `${ROUTE_OVERLAY_CACHE_PREFIX}:${this.providerName}:${kind}:${hashString36(stableStringify(normalizeRequestForCache(request)))}`;
  }

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
