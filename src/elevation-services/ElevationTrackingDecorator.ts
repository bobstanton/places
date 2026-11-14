import { Coordinate } from "places-shared/geo";
import { API_USAGE_SERVICES, IElevationService, ElevationProfile, type ApiUsageOrigin, type ApiUsageRecorder } from "places-shared/services";
import { ServiceTrackingDecoratorBase } from "../ServiceDecorators";

export class ElevationTrackingDecorator
  extends ServiceTrackingDecoratorBase
  implements IElevationService
{
  constructor(private wrappedService: IElevationService, serviceName: string, recorder: ApiUsageRecorder, origin?: ApiUsageOrigin) {
    super(recorder, serviceName, API_USAGE_SERVICES.elevation, origin);
  }

  getProviderName(): string {
    return this.wrappedService.getProviderName();
  }

  async getElevationProfile(coordinates: Coordinate[]): Promise<ElevationProfile> {
    return this.executeAndTrack(() => this.wrappedService.getElevationProfile(coordinates));
  }
}
