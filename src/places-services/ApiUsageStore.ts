import { DateParser } from "places-shared/settings";
import type { ApiUsageEvent, ApiUsageRecorder } from "places-shared/services";
import { emptyDailyStats, emptyOriginStats, emptyUsageStats, normalizeServiceOrigins, normalizeUsageStats, type IOriginStats, type IPlacesUsageStats } from "./PlacesUsageStats";

export const API_STATS_RETENTION_DAYS = 90;

export const ORIGIN_RETENTION_DAYS = 30;
export const MAX_NOTE_ORIGINS_PER_SERVICE = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

function trackingKeyFor(provider: string, service: string): string {
  return `${provider}:${service}`;
}

export interface ApiUsageState {
  stats: Record<string, unknown>;
  origins: Record<string, unknown>;
}

export class ApiUsageStore implements ApiUsageRecorder {
  private readonly normalized = new Map<string, IPlacesUsageStats>();

  constructor(private readonly state: () => ApiUsageState, private readonly onChanged: () => void) {}

  clear(): void {
    const state = this.state();

    for (const records of [state.stats, state.origins]) {
      for (const key of Object.keys(records)) delete records[key];
    }

    this.normalized.clear();
    this.onChanged();
  }

  record(event: ApiUsageEvent): void {
    const key = trackingKeyFor(event.provider, event.service);
    const now = Date.now();
    const today = DateParser.formatDateISO(new Date(now));

    this.recordServiceStats(key, event, now, today);
    this.recordOrigins(key, event, now);
    this.onChanged();
  }

  private recordServiceStats(key: string, event: ApiUsageEvent, now: number, today: string): void {
    const state = this.state();
    const cached = this.normalized.get(key);
    const stats = cached === state.stats[key] && cached !== undefined
      ? cached
      : normalizeUsageStats(state.stats[key] ?? emptyUsageStats());

    stats.totalCalls += 1;
    stats.successfulCalls += event.success ? 1 : 0;
    stats.failedCalls += event.success ? 0 : 1;
    stats.cacheHits += event.cached ? 1 : 0;
    stats.totalTime += event.durationMs;
    stats.firstCall ??= now;
    stats.lastCall = now;

    const day = stats.dailyHistory[today] ?? emptyDailyStats();

    day.totalCalls += 1;
    day.successfulCalls += event.success ? 1 : 0;
    day.failedCalls += event.success ? 0 : 1;
    day.cacheHits += event.cached ? 1 : 0;
    day.totalTime += event.durationMs;
    stats.dailyHistory[today] = day;

    this.pruneDailyHistory(stats, now);
    state.stats[key] = stats;
    this.normalized.set(key, stats);
  }

  private pruneDailyHistory(stats: IPlacesUsageStats, now: number): void {
    const oldest = DateParser.formatDateISO(new Date(now - API_STATS_RETENTION_DAYS * DAY_MS));

    for (const date of Object.keys(stats.dailyHistory)) {
      if (date < oldest) delete stats.dailyHistory[date];
    }
  }

  private recordOrigins(key: string, event: ApiUsageEvent, now: number): void {
    const { sourcePath, blockType } = event.origin ?? {};

    if (!sourcePath && !blockType) return;

    const state = this.state();
    const origins = normalizeServiceOrigins(state.origins[key]);

    if (sourcePath) this.applyOrigin(origins.notes, sourcePath, event, now);
    if (blockType) this.applyOrigin(origins.blocks, blockType, event, now);

    this.pruneOrigins(origins.notes, now, MAX_NOTE_ORIGINS_PER_SERVICE);
    this.pruneOrigins(origins.blocks, now);
    state.origins[key] = origins;
  }

  private applyOrigin(bucket: Record<string, IOriginStats>, key: string, event: ApiUsageEvent, now: number): void {
    const entry = bucket[key] ?? emptyOriginStats();

    entry.calls += 1;
    entry.cacheHits += event.cached ? 1 : 0;
    entry.failedCalls += event.success ? 0 : 1;
    entry.lastCall = now;
    bucket[key] = entry;
  }

  private pruneOrigins(bucket: Record<string, IOriginStats>, now: number, maxEntries?: number): void {
    const oldest = now - ORIGIN_RETENTION_DAYS * DAY_MS;

    for (const [key, entry] of Object.entries(bucket)) {
      if (entry.lastCall < oldest) delete bucket[key];
    }

    if (maxEntries === undefined) return;
    const keys = Object.keys(bucket);

    if (keys.length <= maxEntries) return;

    keys
      .sort((left, right) => bucket[left].lastCall - bucket[right].lastCall)
      .slice(0, keys.length - maxEntries)
      .forEach(key => delete bucket[key]);
  }
}
