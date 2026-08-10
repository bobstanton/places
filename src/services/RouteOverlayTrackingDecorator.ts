import type * as GeoJSON from "geojson";
import { DirectionsOverlayRequest, IsochroneOverlayRequest, RouteOverlayCapabilities, RouteOverlayService } from "places-shared/services";
import { ServiceTrackingDecoratorBase, IDailyStats, StatsChangedCallback } from "../ServiceDecorators";
import { DEFAULT_ROUTE_OVERLAY_CAPABILITIES } from "./RouteOverlayCachingDecorator";

export class RouteOverlayTrackingDecorator
  extends ServiceTrackingDecoratorBase<IDailyStats>
  implements RouteOverlayService
{
  constructor(private wrappedService: RouteOverlayService, serviceName: string, apiStatsSettings: Record<string, unknown>, onStatsChanged: StatsChangedCallback) {
    super(serviceName, "routeOverlay", apiStatsSettings, onStatsChanged);
  }

  getProviderName(): string {
    return this.wrappedService.getProviderName();
  }

  getCapabilities(): RouteOverlayCapabilities {
    return this.wrappedService.getCapabilities?.() ?? DEFAULT_ROUTE_OVERLAY_CAPABILITIES;
  }

  async getDirectionsOverlay(request: DirectionsOverlayRequest): Promise<GeoJSON.FeatureCollection> {
    return this.executeAndTrack(() => this.wrappedService.getDirectionsOverlay(request));
  }

  async getIsochroneOverlay(request: IsochroneOverlayRequest): Promise<GeoJSON.FeatureCollection> {
    return this.executeAndTrack(() => this.wrappedService.getIsochroneOverlay(request));
  }
}
