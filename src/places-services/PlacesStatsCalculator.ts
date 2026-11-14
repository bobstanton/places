import { DateParser } from "places-shared/settings";
import { normalizeServiceOrigins, normalizeUsageStats } from './PlacesUsageStats';

export interface UsageTotals {
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  cacheHits: number;
  totalTime: number;
  averageTime: number;
}

export interface ServiceSummary {
  key: string;
  provider: string;
  service: string;
  lifetime: UsageTotals;
  todayCalls: number;
  weekCalls: number;
  monthCalls: number;
  firstCall?: number;
  lastCall?: number;
}

export interface DaySummary {
  date: string;
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  cacheHits: number;
  averageTime: number;
}

export interface OriginSummary {
  key: string;
  calls: number;
  cacheHits: number;
  failedCalls: number;
  lastCall: number;
  providers: string[];
}

function emptyTotals(): UsageTotals {
  return { totalCalls: 0, successfulCalls: 0, failedCalls: 0, cacheHits: 0, totalTime: 0, averageTime: 0 };
}

function withAverage(totals: UsageTotals): UsageTotals {
  return { ...totals, averageTime: totals.totalCalls > 0 ? totals.totalTime / totals.totalCalls : 0 };
}

function weekStartISO(now: Date): string {
  const start = new Date(now);

  start.setDate(now.getDate() - now.getDay());

  return DateParser.formatDateISO(start);
}

export class PlacesStatsCalculator {
  static summarizeService(key: string, raw: unknown, now = new Date()): ServiceSummary {
    const stats = normalizeUsageStats(raw);
    const today = DateParser.formatDateISO(now);
    const weekStart = weekStartISO(now);
    const month = today.substring(0, 7);

    let todayCalls = 0;
    let weekCalls = 0;
    let monthCalls = 0;

    for (const [date, dayStats] of Object.entries(stats.dailyHistory)) {
      if (date === today) todayCalls += dayStats.totalCalls;
      if (date >= weekStart && date <= today) weekCalls += dayStats.totalCalls;
      if (date.startsWith(month)) monthCalls += dayStats.totalCalls;
    }

    const separator = key.indexOf(':');

    return {
      key,
      provider: separator > 0 ? key.substring(0, separator) : key,
      service: separator > 0 ? key.substring(separator + 1) : '',
      lifetime: withAverage({
        totalCalls: stats.totalCalls,
        successfulCalls: stats.successfulCalls,
        failedCalls: stats.failedCalls,
        cacheHits: stats.cacheHits,
        totalTime: stats.totalTime,
        averageTime: 0,
      }),
      todayCalls,
      weekCalls,
      monthCalls,
      ...(stats.firstCall ? { firstCall: stats.firstCall } : {}),
      ...(stats.lastCall ? { lastCall: stats.lastCall } : {}),
    };
  }

  static summarizeDays(apiStats: Record<string, unknown> | undefined, key: string): DaySummary[] {
    const stats = normalizeUsageStats(apiStats?.[key]);

    return Object.entries(stats.dailyHistory)
      .filter(([, day]) => day.totalCalls > 0)
      .sort(([left], [right]) => right.localeCompare(left))
      .map(([date, day]) => ({
        date,
        totalCalls: day.totalCalls,
        successfulCalls: day.successfulCalls,
        failedCalls: day.failedCalls,
        cacheHits: day.cacheHits,
        averageTime: day.totalCalls > 0 ? day.totalTime / day.totalCalls : 0,
      }));
  }

  static summarizeServices(apiStats: Record<string, unknown> | undefined, now = new Date()): ServiceSummary[] {
    return Object.entries(apiStats ?? {})
      .map(([key, raw]) => this.summarizeService(key, raw, now))
      .filter(summary => summary.lifetime.totalCalls > 0)
      .sort((left, right) => right.lifetime.totalCalls - left.lifetime.totalCalls);
  }

  static aggregate(summaries: ServiceSummary[]): {
    lifetime: UsageTotals;
    todayCalls: number;
    weekCalls: number;
    monthCalls: number;
    firstCall?: number;
    lastCall?: number;
  } {
    const lifetime = emptyTotals();
    let todayCalls = 0;
    let weekCalls = 0;
    let monthCalls = 0;
    let firstCall: number | undefined;
    let lastCall: number | undefined;

    for (const summary of summaries) {
      lifetime.totalCalls += summary.lifetime.totalCalls;
      lifetime.successfulCalls += summary.lifetime.successfulCalls;
      lifetime.failedCalls += summary.lifetime.failedCalls;
      lifetime.cacheHits += summary.lifetime.cacheHits;
      lifetime.totalTime += summary.lifetime.totalTime;
      todayCalls += summary.todayCalls;
      weekCalls += summary.weekCalls;
      monthCalls += summary.monthCalls;
      if (summary.firstCall) firstCall = firstCall ? Math.min(firstCall, summary.firstCall) : summary.firstCall;
      if (summary.lastCall) lastCall = lastCall ? Math.max(lastCall, summary.lastCall) : summary.lastCall;
    }

    return {
      lifetime: withAverage(lifetime),
      todayCalls,
      weekCalls,
      monthCalls,
      ...(firstCall ? { firstCall } : {}),
      ...(lastCall ? { lastCall } : {}),
    };
  }

  static dailySeries(raw: unknown, dates: string[]): number[] {
    const { dailyHistory } = normalizeUsageStats(raw);

    return dates.map(date => dailyHistory[date]?.totalCalls ?? 0);
  }

  static summarizeOrigins(apiOrigins: Record<string, unknown>, dimension: 'notes' | 'blocks', onlyService?: string): OriginSummary[] {
    const merged = new Map<string, OriginSummary & { providerCalls: Map<string, number> }>();

    for (const [serviceKey, raw] of Object.entries(apiOrigins)) {
      if (onlyService !== undefined && serviceKey !== onlyService) continue;
      const separator = serviceKey.indexOf(':');
      const provider = separator > 0 ? serviceKey.substring(0, separator) : serviceKey;

      for (const [key, stats] of Object.entries(normalizeServiceOrigins(raw)[dimension])) {
        const entry = merged.get(key) ?? { key, calls: 0, cacheHits: 0, failedCalls: 0, lastCall: 0, providers: [], providerCalls: new Map<string, number>() };

        entry.calls += stats.calls;
        entry.cacheHits += stats.cacheHits;
        entry.failedCalls += stats.failedCalls;
        entry.lastCall = Math.max(entry.lastCall, stats.lastCall);
        entry.providerCalls.set(provider, (entry.providerCalls.get(provider) ?? 0) + stats.calls);
        merged.set(key, entry);
      }
    }

    return [...merged.values()]
      .map(({ providerCalls, ...entry }) => ({
        ...entry,
        providers: [...providerCalls.entries()].sort((left, right) => right[1] - left[1]).map(([name]) => name),
      }))
      .sort((left, right) => right.calls - left.calls);
  }

  static lastDays(count: number, now = new Date()): string[] {
    return Array.from({ length: count }, (_unused, index) => {
      const date = new Date(now);

      date.setDate(now.getDate() - (count - 1 - index));

      return DateParser.formatDateISO(date);
    });
  }
}
