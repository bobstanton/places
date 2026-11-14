import type * as GeoJSON from "geojson";
import { DirectionsOverlayRequest, IsochroneOverlayRequest, RouteOverlayCapabilities, RouteOverlayService } from "places-shared/services";
import { ServiceTrackingDecoratorBase } from "../ServiceDecorators";
import { API_USAGE_SERVICES, type ApiUsageOrigin, type ApiUsageRecorder } from "places-shared/services";
import { DEFAULT_ROUTE_OVERLAY_CAPABILITIES } from "./RouteOverlayCachingDecorator";

export class RouteOverlayTrackingDecorator
  extends ServiceTrackingDecoratorBase
  implements RouteOverlayService
{
  constructor(private wrappedService: RouteOverlayService, serviceName: string, recorder: ApiUsageRecorder, origin?: ApiUsageOrigin) {
    super(recorder, serviceName, API_USAGE_SERVICES.routeOverlay, origin);
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
