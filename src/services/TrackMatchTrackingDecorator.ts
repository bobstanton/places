import { type Coordinate } from "places-shared/geo";
import { API_USAGE_SERVICES, type ApiUsageOrigin, type ApiUsageRecorder, type ITrackMatchService, type TrackMatchOptions, type TrackMatchResult } from "places-shared/services";
import { ServiceTrackingDecoratorBase } from "../ServiceDecorators";

export class TrackMatchTrackingDecorator
  extends ServiceTrackingDecoratorBase
  implements ITrackMatchService
{
  constructor(private wrappedService: ITrackMatchService, serviceName: string, recorder: ApiUsageRecorder, origin?: ApiUsageOrigin) {
    super(recorder, serviceName, API_USAGE_SERVICES.trackMatch, origin);
  }

  get providerId(): string {
    return this.wrappedService.providerId;
  }

  get displayName(): string {
    return this.wrappedService.displayName;
  }

  async matchTrack(coordinates: Coordinate[], options?: TrackMatchOptions): Promise<TrackMatchResult> {
    return this.executeAndTrack(() => this.wrappedService.matchTrack(coordinates, options));
  }

  isAvailable(): boolean {
    return this.wrappedService.isAvailable();
  }
}
