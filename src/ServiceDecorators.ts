import type { ApiUsageOrigin, ApiUsageRecorder, ApiUsageService } from "places-shared/services";

export abstract class ServiceTrackingDecoratorBase {
  constructor(private readonly recorder: ApiUsageRecorder, private readonly provider: string, private readonly service: ApiUsageService, private readonly origin?: ApiUsageOrigin) {}

  protected async executeAndTrack<T>(fn: () => Promise<T>): Promise<T> {
    const startTime = performance.now();
    let success = false;

    try {
      const result = await fn();

      success = true;

      return result;
    } finally {
      this.recorder.record({
        provider: this.provider,
        service: this.service,
        success,
        durationMs: performance.now() - startTime,
        ...(this.origin ? { origin: this.origin } : {}),
      });
    }
  }
}
