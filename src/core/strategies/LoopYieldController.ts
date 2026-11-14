import { sleep } from "places-shared/worker-safe";

export interface LoopYieldControllerOptions {
  batchSize: number;
  maxIntervalMs?: number;
}

export class LoopYieldController {
  private lastYield = Date.now();
  private yieldCount = 0;
  private yieldMs = 0;

  constructor(private readonly options: LoopYieldControllerOptions) {}

  async yieldIfNeeded(iteration: number, now: number = Date.now()): Promise<void> {
    const reachedBatch = iteration % this.options.batchSize === 0;
    const reachedInterval = this.options.maxIntervalMs !== undefined && now - this.lastYield >= this.options.maxIntervalMs;

    if (!reachedBatch && !reachedInterval) {
      return;
    }

    const started = Date.now();

    await sleep(0);
    this.lastYield = Date.now();
    this.yieldMs += this.lastYield - started;
    this.yieldCount++;
  }

  getStats(): { yieldCount: number; yieldMs: number } {
    return { yieldCount: this.yieldCount, yieldMs: this.yieldMs };
  }
}
