import { MapPlace } from "places-shared/overlay";
import { classifyMapRenderPlanChanges, diffMapRenderPlans, summarizeMapRenderPlanDiff, type MapRenderPlan } from "places-shared/render";
import { type MapRenderRequest } from "places-shared/settings";
import { IMapBlockProcessor } from "places-shared/services";
import { getErrorMessage, hashString36 } from "places-shared/utils";

export interface MapDataRefreshLogger {
  debug(message: string, details?: Record<string, unknown>): void;
}

export interface MapDataRefreshRequest {
  provider: IMapBlockProcessor;
  mapContainer: HTMLElement;
  places: MapPlace[];
  renderRequest: MapRenderRequest;
  previousPlan?: MapRenderPlan | null;
  nextPlan?: MapRenderPlan | null;
  providerName?: string;
  logger?: MapDataRefreshLogger;
}

export interface MapDataRefreshResult {
  refreshed: boolean;
  status?: 'requires-rebuild' | 'temporarily-unavailable';
  reason?: string;
}

export async function runMapDataRefresh(request: MapDataRefreshRequest): Promise<MapDataRefreshResult> {
  const {
    provider,
    mapContainer,
    places,
    renderRequest,
    previousPlan,
    nextPlan,
    providerName,
    logger,
  } = request;

  const planDiff = nextPlan ? diffMapRenderPlans(previousPlan, nextPlan) : null;

  try {
    if (!previousPlan || !nextPlan) {
      return { refreshed: false, status: 'requires-rebuild', reason: 'canonical render plans are required for incremental updates' };
    }
    const changes = classifyMapRenderPlanChanges(previousPlan, nextPlan, planDiff ?? undefined);
    const capabilities = provider.getIncrementalUpdateCapabilities();
    const unsupported = [...changes].filter(change => !capabilities[change]);
    if (unsupported.length > 0) {
      return {
        refreshed: false,
        status: 'requires-rebuild',
        reason: `provider requires rebuild for: ${unsupported.join(', ')}`,
      };
    }

    logger?.debug('map data update started', {
      provider: providerName,
      places: places.length,
      previousPlanHash: previousPlan ? hashString36(previousPlan.signature) : undefined,
      nextPlanHash: nextPlan ? hashString36(nextPlan.signature) : undefined,
      planDiff: planDiff ? summarizeMapRenderPlanDiff(planDiff) : undefined,
    });

    const result = await provider.updateMapData(mapContainer, places, renderRequest, {
      previousPlan,
      nextPlan,
      planDiff,
    });
    if (!result.updated) {
      logger?.debug('map data update rejected by provider', {
        provider: providerName,
        places: places.length,
        reason: result.reason
      });
      return { refreshed: false, status: result.status, reason: result.reason };
    }

    logger?.debug('map data update complete', {
      provider: providerName,
      places: places.length
    });
    return { refreshed: true };
  } catch (error) {
    logger?.debug('map data update failed', {
      provider: providerName,
      error
    });
    return { refreshed: false, status: 'temporarily-unavailable', reason: getErrorMessage(error) };
  }
}
