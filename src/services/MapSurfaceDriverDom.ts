import { cleanupMapProviderStates, ensureMapSurfaceLifecycle, hasActiveMapProviderState, isNonInteractivePlace, MapStateManager } from "places-shared/map";
import { PlacesBoundingBox } from "places-shared/geo";
import { extendBoundingBoxWithOverlays } from "places-shared/overlay";
import { resolveCameraIntent } from "places-shared/render";
import type { IMapBlockProcessor } from "places-shared/services";
import { getErrorMessage, logger as rootLogger, renderMapSurfaceError } from "places-shared/utils";
import { runMapDataRefresh } from "./MapDataRefreshRunner";
import type { MapSurfaceDriver } from "./MapSurfaceController";

const logger = rootLogger.scope('MapSurface');

export interface DomMapSurfaceDriverOptions {
  container: () => HTMLElement;
  provider: () => IMapBlockProcessor | null;
  providerName: () => string;
  rerender: (reason: string) => Promise<void>;
}

export function createDomMapSurfaceDriver(options: DomMapSurfaceDriverOptions): MapSurfaceDriver {
  return {
    isAttached: () => options.container().isConnected,
    hasLayoutSize: () => {
      const el = options.container();

      return el.isConnected && el.clientWidth > 0 && el.clientHeight > 0;
    },
    lifecycle: () => ensureMapSurfaceLifecycle(options.container()).getState(),
    onLifecycleEvent: listener => {
      const container = options.container();
      const lifecycle = ensureMapSurfaceLifecycle(container);
      const unsubscribe = lifecycle.subscribe(listener);
      const observer = new ResizeObserver(entries => {
        for (const entry of entries) {
          lifecycle.reportSize(entry.contentRect.width, entry.contentRect.height);
        }
      });

      observer.observe(container);

      return () => { observer.disconnect(); unsubscribe(); };
    },
    render: async plan => {
      const mapContainer = options.container();

      if (hasActiveMapProviderState(mapContainer)) {
        cleanupMapProviderStates(mapContainer, error => logger.error('Error during map cleanup:', error));
      }

      if (plan.runtime.isStale?.()) {
        logger.debug('map surface render abandoned - caller superseded', { source: plan.runtime.source.path });

        return { rendered: false, reason: 'superseded' };
      }

      const provider = options.provider();

      if (!provider) {
        return { rendered: false, reason: 'no map provider' };
      }

      try {
        await provider.processPlaceCodeBlock(plan.places, mapContainer, { config: plan.config, runtime: plan.runtime });

        if (plan.runtime.isStale?.()) {
          cleanupMapProviderStates(mapContainer, error => logger.error('Error cleaning up superseded map surface:', error));

          return { rendered: false, reason: 'superseded' };
        }

        return { rendered: true };
      } catch (error) {
        logger.error('Error rendering map surface', error);
        cleanupMapProviderStates(mapContainer, cleanupError => logger.error('Error cleaning up failed map surface:', cleanupError));
        const reason = getErrorMessage(error);

        renderMapSurfaceError(mapContainer, {
          icon: '⚠️',
          title: 'Map Render Error',
          message: reason,
        });

        return { rendered: false, reason };
      }
    },
    update: async (previous, next) => {
      const provider = options.provider();

      if (!provider) {
        return { refreshed: false, reason: 'no map instance found' };
      }

      return runMapDataRefresh({
        provider,
        mapContainer: options.container(),
        places: next.places,
        renderRequest: { config: next.config, runtime: next.runtime },
        previousPlan: previous,
        nextPlan: next,
        providerName: options.providerName(),
        logger,
      });
    },
    applyCamera: (camera, request) => {
      const provider = options.provider();

      if (!provider) {
        return { applied: false, reason: 'no map instance found' };
      }

      if (!provider.applyCamera) {
        return { applied: false, reason: 'provider does not support applyCamera' };
      }

      return provider.applyCamera(options.container(), camera, request);
    },
    applyMarkerVisibility: hiddenPlaceIds => {
      options.provider()?.applyMarkerVisibility?.(options.container(), hiddenPlaceIds);
    },
    rememberFittedViewport: plan => {
      const source = plan.runtime.source;
      const key = MapStateManager.getStateKey(source);

      if (!key) return;
      const saved = MapStateManager.getSavedState(source);

      if (saved && !saved.automatic) return;
      const bounds = new PlacesBoundingBox();

      for (const place of plan.places) {
        if (isNonInteractivePlace(place)) continue;
        bounds.update(place.latitude, place.longitude);
        if (bounds.isValid()) break;
      }

      if (!bounds.isValid()) extendBoundingBoxWithOverlays(bounds, plan.overlays);
      if (!bounds.isValid()) return;
      const view = options.provider()?.getMapControlHandle?.(options.container())?.getViewState?.();

      if (!view || !Number.isFinite(view.zoom) || !Number.isFinite(view.center.latitude) || !Number.isFinite(view.center.longitude)) return;
      MapStateManager.saveState(key, { zoom: view.zoom, center: { lat: view.center.latitude, lng: view.center.longitude }, automatic: true });
    },
    resolveCamera: plan => {
      const view = options.provider()?.getMapControlHandle?.(options.container())?.getViewState?.();

      return view ? { kind: 'explicit', center: [view.center.longitude, view.center.latitude], zoom: view.zoom }
        : resolveCameraIntent(plan.config, plan.runtime.source);
    },
    rerender: reason => options.rerender(reason),
    warn: (message, details) => logger.warn(message, details),
    debug: (message, details) => logger.debug(message, details),
  };
}
