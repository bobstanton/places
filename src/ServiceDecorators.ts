// Caching decorators live in ServiceCachingDecoratorBase in places-shared.

import { DateParser } from "places-shared/settings";

// Schedules settings persistence after stats change.
export type StatsChangedCallback = () => void;

export interface ICallResult<TCategory = void> {
  success: boolean;
  duration: number;
  category?: TCategory;
}

export interface IDailyStats {
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  totalTime: number;
}

export interface IUsageStats<TDailyStats extends IDailyStats = IDailyStats> {
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  averageTime: number;
  dailyHistory?: Record<string, TDailyStats>;
}

export abstract class ServiceTrackingDecoratorBase<
  TDailyStats extends IDailyStats = IDailyStats,
  TCategory = void
> {
  private serviceName: string;
  private serviceType: string;
  private apiStatsSettings: Record<string, unknown>;
  private onStatsChanged: StatsChangedCallback;

  constructor(serviceName: string, serviceType: string, apiStatsSettings: Record<string, unknown>, onStatsChanged: StatsChangedCallback) {
    this.serviceName = serviceName;
    this.serviceType = serviceType;
    this.apiStatsSettings = apiStatsSettings;
    this.onStatsChanged = onStatsChanged;
  }

  protected getTrackingKey(): string {
    return `${this.serviceName}:${this.serviceType}`;
  }

  protected async executeAndTrack<T>(
    fn: () => Promise<T>,
    category?: TCategory
  ): Promise<T> {
    const startTime = performance.now();
    let success = false;

    try {
      const result = await fn();
      success = true;
      return result;
    } finally {
      const duration = performance.now() - startTime;
      this.recordCall({ success, duration, category });
    }
  }

  private recordCall(result: ICallResult<TCategory>): void {
    const trackingKey = this.getTrackingKey();
    const today = DateParser.formatDateISO(new Date());

    const stats = (this.apiStatsSettings[trackingKey] as IUsageStats<TDailyStats>) || {
      totalCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      averageTime: 0,
      dailyHistory: {}
    };

    const newTotalCalls = stats.totalCalls + 1;
    stats.totalCalls = newTotalCalls;
    stats.successfulCalls += result.success ? 1 : 0;
    stats.failedCalls += result.success ? 0 : 1;
    stats.averageTime = ((stats.averageTime * (newTotalCalls - 1)) + result.duration) / newTotalCalls;

    if (!stats.dailyHistory) {
      stats.dailyHistory = {};
    }

    const existingDailyStats = stats.dailyHistory[today] || this.createEmptyDailyStats();
    stats.dailyHistory[today] = this.updateDailyStats(existingDailyStats, result);

    this.apiStatsSettings[trackingKey] = stats;
    this.onStatsChanged();
  }

  protected createEmptyDailyStats(): TDailyStats {
    return {
      totalCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      totalTime: 0,
    } as TDailyStats;
  }

  protected updateDailyStats(existing: TDailyStats, result: ICallResult<TCategory>): TDailyStats {
    return {
      ...existing,
      totalCalls: existing.totalCalls + 1,
      successfulCalls: existing.successfulCalls + (result.success ? 1 : 0),
      failedCalls: existing.failedCalls + (result.success ? 0 : 1),
      totalTime: existing.totalTime + result.duration,
    };
  }
}
