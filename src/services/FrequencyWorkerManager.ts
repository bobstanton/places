import { logger as rootLogger } from "places-shared/utils";

import { Platform } from "obsidian";
import { Meters } from "places-shared/units";

// @ts-expect-error esbuild-plugin-inline-worker transforms this import into a Worker constructor.
import FrequencyWorker from "../workers/frequency-analysis.worker";

import { FrequencyTrackData, FrequencyAnalysisResult, StrategyOptions } from 'places/core/strategies';

const logger = rootLogger.scope('FrequencyWorkerManager');
const FrequencyWorkerConstructor = FrequencyWorker as unknown as new () => Worker;

interface WorkerRequest {
  type: 'analyze';
  id: string;
  strategy: string;
  tracks: FrequencyTrackData[];
  options: Omit<StrategyOptions, 'onProgress' | 'gridSize'> & { gridSize?: number };
}

interface WorkerResponse {
  type: 'result' | 'progress' | 'error';
  id: string;
  result?: FrequencyAnalysisResult;
  message?: string;
  error?: string;
}

interface PendingRequest {
  resolve: (result: FrequencyAnalysisResult) => void;
  reject: (error: Error) => void;
  onProgress?: (message: string) => void;
}

class FrequencyWorkerManager {
  private worker: Worker | null = null;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private requestCounter = 0;
  private isSupported: boolean;

  constructor() {
    this.isSupported = typeof Worker !== 'undefined';
  }

  private ensureWorker(): Worker {
    if (!this.isSupported) {
      throw new Error('Web Workers are not supported in this environment');
    }

    if (!this.worker) {
      const worker = new FrequencyWorkerConstructor();

      this.worker = worker;

      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        this.handleWorkerMessage(event.data);
      };

      worker.onerror = (error) => {
        logger.error('Worker error', error);

        for (const [id, pending] of this.pendingRequests) {
          pending.reject(new Error(`Worker error: ${error.message}`));
          this.pendingRequests.delete(id);
        }
      };
    }

    return this.worker;
  }

  private handleWorkerMessage(response: WorkerResponse): void {
    const pending = this.pendingRequests.get(response.id);

    if (!pending) {
      logger.warn('Received response for unknown request', response.id);

      return;
    }

    switch (response.type) {
      case 'result':
        if (response.result) {
          pending.resolve(response.result);
        } else {
          pending.reject(new Error('Worker returned no result'));
        }

        this.pendingRequests.delete(response.id);
        break;

      case 'progress':
        if (pending.onProgress && response.message) {
          pending.onProgress(response.message);
        }

        break;

      case 'error':
        pending.reject(new Error(response.error || 'Unknown worker error'));
        this.pendingRequests.delete(response.id);
        break;
    }
  }

  // @param strategy - Strategy name ('density-cloud', 'opacity-stacking', 'track-corridor')
  async analyze(
    strategy: string,
    tracks: FrequencyTrackData[],
    options: {
      gridSize?: Meters;
      minFrequency: number;
      maxSegments: number;
      onProgress?: (message: string) => void;
      minOpacity?: number;
      maxOpacity?: number;
    }
  ): Promise<FrequencyAnalysisResult> {
    const worker = this.ensureWorker();
    const id = `request-${++this.requestCounter}`;

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve,
        reject,
        onProgress: options.onProgress
      });

      const request: WorkerRequest = {
        type: 'analyze',
        id,
        strategy,
        tracks,
        options: {
          gridSize: options.gridSize ? Number(options.gridSize) : undefined,
          minFrequency: options.minFrequency,
          maxSegments: options.maxSegments,
          minOpacity: options.minOpacity,
          maxOpacity: options.maxOpacity,
          isMobile: Platform.isMobile
        }
      };

      worker.postMessage(request);
    });
  }

  terminate(): void {
    if (this.worker) {
      for (const [id, pending] of this.pendingRequests) {
        pending.reject(new Error('Worker terminated'));
        this.pendingRequests.delete(id);
      }

      this.worker.terminate();
      this.worker = null;
    }
  }

  hasPendingRequests(): boolean {
    return this.pendingRequests.size > 0;
  }
}

let workerManagerInstance: FrequencyWorkerManager | null = null;

export function getFrequencyWorkerManager(): FrequencyWorkerManager {
  if (!workerManagerInstance) {
    workerManagerInstance = new FrequencyWorkerManager();
  }

  return workerManagerInstance;
}

export function terminateFrequencyWorker(): void {
  if (workerManagerInstance) {
    workerManagerInstance.terminate();
    workerManagerInstance = null;
  }
}
