import { DensityCloudStrategy, OpacityStackingStrategy, TrackCorridorStrategy, type FrequencyTrackData, type StrategyOptions } from 'places/core/strategies';
import { getErrorMessage } from "places-shared/worker-safe";

interface WorkerRequest {
  type: string;
  id: string;
  strategy: string;
  tracks: FrequencyTrackData[];
  options: Omit<StrategyOptions, 'onProgress'> & { gridSize?: number };
}

const strategies = {
  'density-cloud': new DensityCloudStrategy(),
  'opacity-stacking': new OpacityStackingStrategy(),
  'track-corridor': new TrackCorridorStrategy()
};

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { type, id, strategy, tracks, options } = event.data;

  if (type !== 'analyze') {
    self.postMessage({
      type: 'error',
      id,
      error: 'Unknown message type'
    });

    return;
  }

  const onProgress = (message: string) => {
    self.postMessage({
      type: 'progress',
      id,
      message
    });
  };

  try {
    const strategyImpl = strategies[strategy as keyof typeof strategies];

    if (!strategyImpl) {
      self.postMessage({
        type: 'error',
        id,
        error: `Unknown strategy: ${strategy}`
      });

      return;
    }

    const result = await strategyImpl.analyze(tracks, {
      ...options,
      onProgress
    });

    self.postMessage({
      type: 'result',
      id,
      result
    });
  } catch (error) {
    self.postMessage({
      type: 'error',
      id,
      error: getErrorMessage(error)
    });
  }
};
