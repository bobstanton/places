export interface IDailyStats {
  totalCalls: number;

  successfulCalls: number;

  failedCalls: number;

  cacheHits: number;

  totalTime: number;
}

export interface IOriginStats {
  calls: number;

  cacheHits: number;

  failedCalls: number;

  lastCall: number;
}

export interface IServiceOrigins {
  notes: Record<string, IOriginStats>;

  blocks: Record<string, IOriginStats>;
}

export interface IPlacesUsageStats {
  totalCalls: number;

  successfulCalls: number;

  failedCalls: number;

  cacheHits: number;

  totalTime: number;

  firstCall?: number;

  lastCall?: number;

  dailyHistory: Record<string, IDailyStats>;
}

export function emptyDailyStats(): IDailyStats {
  return { totalCalls: 0, successfulCalls: 0, failedCalls: 0, cacheHits: 0, totalTime: 0 };
}

export function emptyOriginStats(): IOriginStats {
  return { calls: 0, cacheHits: 0, failedCalls: 0, lastCall: 0 };
}

export function emptyUsageStats(): IPlacesUsageStats {
  return { totalCalls: 0, successfulCalls: 0, failedCalls: 0, cacheHits: 0, totalTime: 0, dailyHistory: {} };
}

function readNumber(source: Record<string, unknown>, key: string): number {
  const value = source[key];

  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function normalizeDailyStats(raw: unknown): IDailyStats {
  if (typeof raw !== 'object' || raw === null) return emptyDailyStats();
  const source = raw as Record<string, unknown>;

  return {
    totalCalls: readNumber(source, 'totalCalls'),
    successfulCalls: readNumber(source, 'successfulCalls'),
    failedCalls: readNumber(source, 'failedCalls'),
    cacheHits: readNumber(source, 'cacheHits'),
    totalTime: readNumber(source, 'totalTime'),
  };
}

export function normalizeUsageStats(raw: unknown): IPlacesUsageStats {
  if (typeof raw !== 'object' || raw === null) return emptyUsageStats();
  const source = raw as Record<string, unknown>;

  const totalCalls = readNumber(source, 'totalCalls');
  const storedTotalTime = readNumber(source, 'totalTime');
  const totalTime = storedTotalTime > 0 ? storedTotalTime : readNumber(source, 'averageTime') * totalCalls;

  const dailyHistory: Record<string, IDailyStats> = {};
  const storedHistory = source.dailyHistory;

  if (typeof storedHistory === 'object' && storedHistory !== null) {
    for (const [date, dayStats] of Object.entries(storedHistory as Record<string, unknown>)) {
      dailyHistory[date] = normalizeDailyStats(dayStats);
    }
  }

  const firstCall = readNumber(source, 'firstCall');
  const lastCall = readNumber(source, 'lastCall');

  return {
    totalCalls,
    successfulCalls: readNumber(source, 'successfulCalls'),
    failedCalls: readNumber(source, 'failedCalls'),
    cacheHits: readNumber(source, 'cacheHits'),
    totalTime,
    ...(firstCall > 0 ? { firstCall } : {}),
    ...(lastCall > 0 ? { lastCall } : {}),
    dailyHistory,
  };
}

export function normalizeServiceOrigins(raw: unknown): IServiceOrigins {
  const result: IServiceOrigins = { notes: {}, blocks: {} };

  if (typeof raw !== 'object' || raw === null) return result;
  const source = raw as Record<string, unknown>;

  for (const dimension of ['notes', 'blocks'] as const) {
    const stored = source[dimension];

    if (typeof stored !== 'object' || stored === null) continue;

    for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue;
      const entry = value as Record<string, unknown>;

      result[dimension][key] = {
        calls: readNumber(entry, 'calls'),
        cacheHits: readNumber(entry, 'cacheHits'),
        failedCalls: readNumber(entry, 'failedCalls'),
        lastCall: readNumber(entry, 'lastCall'),
      };
    }
  }

  return result;
}
