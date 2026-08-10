import { sleep } from "places-shared/worker-safe";

export interface LoopYieldControllerOptions {
  batchSize: number;
  maxIntervalMs?: number;
}

export class LoopYieldController {
  private lastYield = Date.now();

  constructor(private readonly options: LoopYieldControllerOptions) {}

  async yieldIfNeeded(iteration: number, now: number = Date.now()): Promise<void> {
    const reachedBatch = iteration % this.options.batchSize === 0;
    const reachedInterval = this.options.maxIntervalMs !== undefined && now - this.lastYield >= this.options.maxIntervalMs;

    if (!reachedBatch && !reachedInterval) {
      return;
    }

    await yieldToEventLoop();
    this.lastYield = now;
  }
}

async function yieldToEventLoop(): Promise<void> {
  // TrackCorridorStrategy runs on the main thread and inside the frequency-analysis
  // Web Worker, where `window` is undefined, and a window-based timer cannot be used.
  await sleep(0);
}
