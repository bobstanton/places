import { ISnapService, SnapRequest, SnapResult } from "places-shared/services";
import { ServiceTrackingDecoratorBase, IDailyStats, StatsChangedCallback } from "../ServiceDecorators";

export class SnapTrackingDecorator
  extends ServiceTrackingDecoratorBase<IDailyStats>
  implements ISnapService
{
  constructor(private wrappedService: ISnapService, serviceName: string, apiStatsSettings: Record<string, unknown>, onStatsChanged: StatsChangedCallback) {
    super(serviceName, "snap", apiStatsSettings, onStatsChanged);
  }

  getProviderName(): string {
    return this.wrappedService.getProviderName();
  }

  async snapPoints(request: SnapRequest): Promise<SnapResult> {
    return this.executeAndTrack(() => this.wrappedService.snapPoints(request));
  }

  // Pass-through: the decorator counts calls, it does not change what the provider supports.
  describeUnsupportedRequest(request: SnapRequest): string[] {
    return this.wrappedService.describeUnsupportedRequest?.(request) ?? [];
  }
}
