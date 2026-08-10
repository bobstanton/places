import type { MapSurfaceRenderOptions } from "./MapSurfaceRenderer";
import type { HostMapSurfaceRequest } from "places-shared/services";

// A host-facade surface renders the caller's plan as given; it builds no plan of its own.
export function buildHostSurfaceRenderOptions(request: HostMapSurfaceRequest): MapSurfaceRenderOptions {
  return {
    host: request.host,
    mapContainer: request.mapContainer,
    places: request.renderPlan.places,
    providerName: request.providerName,
    ctx: request.ctx,
    config: request.renderPlan.config,
    clusteringEnabled: request.renderPlan.clusteringEnabled,
    renderPlan: request.renderPlan,
  };
}
