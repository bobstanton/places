import { ISnapService, SnapRequest, SnapResult } from "places-shared/services";
import { ServiceTrackingDecoratorBase } from "../ServiceDecorators";
import { API_USAGE_SERVICES, type ApiUsageOrigin, type ApiUsageRecorder } from "places-shared/services";

export class SnapTrackingDecorator
  extends ServiceTrackingDecoratorBase
  implements ISnapService
{
  constructor(private wrappedService: ISnapService, serviceName: string, recorder: ApiUsageRecorder, origin?: ApiUsageOrigin) {
    super(recorder, serviceName, API_USAGE_SERVICES.snap, origin);
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
