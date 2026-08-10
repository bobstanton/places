import { IPlacesUsageStats } from './PlacesUsageStats';
import { DateParser } from "places-shared/settings";

export class PlacesStatsCalculator {

  static calculateSingleServiceStats(storedStats: IPlacesUsageStats): IPlacesUsageStats {
    const dailyHistory = storedStats.dailyHistory || {};
    const today = DateParser.formatDateISO(new Date());
    const currentMonth = today.substring(0, 7);

    const stats = Object.entries(dailyHistory).reduce(
      (acc, [date, dayStats]) => ({
        totalCalls: acc.totalCalls + dayStats.totalCalls,
        successfulCalls: acc.successfulCalls + dayStats.successfulCalls,
        failedCalls: acc.failedCalls + dayStats.failedCalls,
        totalTime: acc.totalTime + dayStats.totalTime,
        dailyCalls: date === today ? dayStats.totalCalls : acc.dailyCalls,
        monthlyCalls: acc.monthlyCalls + (date.startsWith(currentMonth) ? dayStats.totalCalls : 0)
      }),
      { totalCalls: 0, successfulCalls: 0, failedCalls: 0, totalTime: 0, dailyCalls: 0, monthlyCalls: 0 }
    );

    return {
      ...storedStats,
      ...stats,
      averageTime: stats.totalCalls > 0 ? stats.totalTime / stats.totalCalls : 0
    };
  }

  static calculateAggregateStats(apiStats: Record<string, IPlacesUsageStats>): {
    totalCalls: number;
    successfulCalls: number;
    failedCalls: number;
    totalTime: number;
    dailyCalls: number;
    monthlyCalls: number;
    averageTime: number;
    earliestFirstCall?: number;
    latestLastCall?: number;
  } {
    const now = new Date();
    const today = DateParser.formatDateISO(now);
    const currentMonth = today.substring(0, 7);

    let totalCalls = 0;
    let successfulCalls = 0;
    let failedCalls = 0;
    let totalTime = 0;
    let dailyCalls = 0;
    let monthlyCalls = 0;
    let earliestFirstCall: number | undefined;
    let latestLastCall: number | undefined;

    for (const stats of Object.values(apiStats)) {
      const dailyHistory = stats.dailyHistory || {};

      const firstCall = stats.firstCall;
      const lastCall = stats.lastCall;

      if (firstCall) {
        earliestFirstCall = earliestFirstCall ? Math.min(earliestFirstCall, firstCall) : firstCall;
      }
      if (lastCall) {
        latestLastCall = latestLastCall ? Math.max(latestLastCall, lastCall) : lastCall;
      }

      for (const [date, dayStats] of Object.entries(dailyHistory)) {
        const dailyStatsObj = dayStats;
        const dayCalls = dailyStatsObj.totalCalls || 0;
        const daySuccessful = dailyStatsObj.successfulCalls || 0;
        const dayFailed = dailyStatsObj.failedCalls || 0;
        const dayTime = dailyStatsObj.totalTime || 0;

        totalCalls += dayCalls;
        successfulCalls += daySuccessful;
        failedCalls += dayFailed;
        totalTime += dayTime;

        if (date === today) {
          dailyCalls += dayCalls;
        }

        if (date.startsWith(currentMonth)) {
          monthlyCalls += dayCalls;
        }
      }
    }

    const averageTime = totalCalls > 0 ? totalTime / totalCalls : 0;

    return {
      totalCalls,
      successfulCalls,
      failedCalls,
      totalTime,
      dailyCalls,
      monthlyCalls,
      averageTime,
      earliestFirstCall,
      latestLastCall
    };
  }

  static getDailyCallDataForDates(stats: IPlacesUsageStats, dates: string[]): number[] {
    if (!stats || !stats.dailyHistory) {
      return Array.from({ length: dates.length }, () => 0);
    }

    const dailyHistory = stats.dailyHistory;

    return dates.map(date => {
      const dayStats = dailyHistory[date];
      return dayStats ? (dayStats).totalCalls || 0 : 0;
    });
  }
}
