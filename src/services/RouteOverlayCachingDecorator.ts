import { isCachedRouteOverlay, ROUTE_OVERLAY_CACHE_PREFIX, ROUTE_OVERLAY_MAX_CACHE_ENTRIES, RouteOverlayCachingDecorator as CoreRouteOverlayCachingDecorator, type CachedRouteOverlay, type RouteOverlayCacheStorage } from 'places/core';
import type { RouteOverlayService } from "places-shared/services";
import { logger as rootLogger } from "places-shared/utils";

// `activeWindow` follows the user's popout windows, which a plain `window` reference would not.

const logger = rootLogger.scope("RouteOverlays");

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

      if (key?.startsWith(`${ROUTE_OVERLAY_CACHE_PREFIX}:`)) keys.push(key);
    }

    if (keys.length <= ROUTE_OVERLAY_MAX_CACHE_ENTRIES) return;

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

export class RouteOverlayCachingDecorator extends CoreRouteOverlayCachingDecorator {
  constructor(wrappedService: RouteOverlayService, providerName: string, cacheStorage: RouteOverlayCacheStorage = new LocalStorageRouteOverlayCacheStorage(), onCacheHit?: () => void) {
    super(wrappedService, providerName, cacheStorage, onCacheHit);
  }
}

export { DEFAULT_ROUTE_OVERLAY_CAPABILITIES, isCachedRouteOverlay, ROUTE_OVERLAY_MAX_CACHE_ENTRIES, type CachedRouteOverlay, type RouteOverlayCacheStorage } from "places/core";
