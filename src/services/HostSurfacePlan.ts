import type { MapSurfaceRenderOptions } from "./MapSurfaceRenderer";
import type { HostMapSurfaceRequest } from "places-shared/obsidian/services";

export function buildHostSurfaceRenderOptions(request: HostMapSurfaceRequest): MapSurfaceRenderOptions {
  return {
    host: request.host,
    mapContainer: request.mapContainer,
    mapContainerClass: request.mapContainerClass,
    height: request.height,
    places: request.renderPlan.places,
    providerName: request.providerName,
    ctx: request.ctx,
    config: request.renderPlan.config,
    clusteringEnabled: request.renderPlan.clusteringEnabled,
    renderPlan: request.renderPlan,
    isStale: request.isStale,
    onRerenderRequested: request.onRerenderRequested,
  };
}
