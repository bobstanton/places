import { Coordinate } from "places-shared/geo";
import { IElevationService, ElevationProfile } from "places-shared/services";
import {
  ServiceTrackingDecoratorBase,
  IDailyStats,
  StatsChangedCallback,
} from "../ServiceDecorators";

export class ElevationTrackingDecorator
  extends ServiceTrackingDecoratorBase<IDailyStats>
  implements IElevationService
{
  constructor(private wrappedService: IElevationService, serviceName: string, apiStatsSettings: Record<string, unknown>, onStatsChanged: StatsChangedCallback) {
    super(serviceName, "elevation", apiStatsSettings, onStatsChanged);
  }

  getProviderName(): string {
    return this.wrappedService.getProviderName();
  }

  async getElevationProfile(coordinates: Coordinate[]): Promise<ElevationProfile> {
    return this.executeAndTrack(() => this.wrappedService.getElevationProfile(coordinates));
  }
}
