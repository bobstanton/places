export class StrategyTimings {
  private readonly overallStart = Date.now();
  private readonly phaseDurations: Record<string, number> = {};
  private readonly progressMarks = new Map<string, number>();

  measure<T>(phase: string, work: () => T): T {
    const started = Date.now();
    try {
      return work();
    } finally {
      this.phaseDurations[phase] = Date.now() - started;
    }
  }

  async measureAsync<T>(phase: string, work: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      return await work();
    } finally {
      this.phaseDurations[phase] = Date.now() - started;
    }
  }

  get(phase: string): number | undefined {
    return this.phaseDurations[phase];
  }

  totalElapsed(): number {
    return Date.now() - this.overallStart;
  }

  shouldReportProgress(key: string, intervalMs: number, now: number = Date.now()): boolean {
    const lastReported = this.progressMarks.get(key) ?? this.overallStart;
    if (now - lastReported < intervalMs) {
      return false;
    }

    this.progressMarks.set(key, now);
    return true;
  }
}
