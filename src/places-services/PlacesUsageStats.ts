export interface IDailyStats {
  totalCalls: number;

  successfulCalls: number;

  failedCalls: number;

  // Milliseconds of API call time on this day.
  totalTime: number;
}

// dailyHistory, firstCall and lastCall persist to disk; the remaining fields
// are computed from dailyHistory on access.
export interface IPlacesUsageStats {
  // Keyed YYYY-MM-DD.
  dailyHistory?: Record<string, IDailyStats>;

  firstCall?: number;

  lastCall?: number;

  totalCalls?: number;

  successfulCalls?: number;

  failedCalls?: number;

  // Milliseconds.
  totalTime?: number;

  // Milliseconds.
  averageTime?: number;

  // Calls in the current day.
  dailyCalls?: number;

  // Calls in the current month.
  monthlyCalls?: number;
}