import { ensureMapSurfaceLifecycle } from "places-shared/map";
import type { MapRenderPlan } from "places-shared/render";
import type { IMapBlockProcessor } from "places-shared/services";
import { logger as rootLogger } from "places-shared/utils";
import { runMapDataRefresh } from "./MapDataRefreshRunner";
import type { MapSurfaceDriver } from "./MapSurfaceController";

const logger = rootLogger.scope('MapSurface');

export interface DomMapSurfaceDriverOptions {
  container: () => HTMLElement;
  provider: () => IMapBlockProcessor | null;
  providerName: () => string;
  render: (plan: MapRenderPlan) => Promise<{ rendered: boolean; reason?: string }>;
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
    onLifecycleEvent: listener => ensureMapSurfaceLifecycle(options.container()).subscribe(listener),
    render: plan => options.render(plan),
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
    rerender: reason => options.rerender(reason),
    warn: (message, details) => logger.warn(message, details),
    debug: (message, details) => logger.debug(message, details),
  };
}
