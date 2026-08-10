import { logger as rootLogger } from "places-shared/utils";
import { App, TFile } from "obsidian";
import { Meters } from "places-shared/units";
import { TrackDataExtractor } from "./TrackDataExtractor";
import { TrackDataService } from "./TrackDataService";
import { IFrequencyStrategy, FrequencyTrackData, FrequencyAnalysisResult } from "./strategies/IFrequencyStrategy";
import { OpacityStackingStrategy } from "./strategies/OpacityStackingStrategy";
import { TrackCorridorStrategy } from "./strategies/TrackCorridorStrategy";
import { DensityCloudStrategy } from "./strategies/DensityCloudStrategy";
import { getFrequencyWorkerManager, terminateFrequencyWorker } from "./FrequencyWorkerManager";

const logger = rootLogger.scope('Heatmap');

export class FrequencyAnalysisService {
  private trackExtractor: TrackDataExtractor;
  private strategies: Map<string, IFrequencyStrategy>;

  constructor(app: App, trackDataService: TrackDataService) {
    this.trackExtractor = new TrackDataExtractor(app, trackDataService);

    this.strategies = new Map();
    this.strategies.set("density-cloud", new DensityCloudStrategy());
    this.strategies.set("track-corridor", new TrackCorridorStrategy());
    this.strategies.set("opacity-stacking", new OpacityStackingStrategy());
  }

  cleanup(): void {
    terminateFrequencyWorker();
  }

  getStrategyOutputType(strategyName: string): 'points' | 'segments' {
    const strategy = this.strategies.get(strategyName);
    return strategy ? strategy.outputType : 'segments';
  }

  getStrategy(strategyName: string): IFrequencyStrategy | null {
    return this.strategies.get(strategyName) || null;
  }

  async analyzeVaultFrequency(files: TFile[], gridSize: Meters, minFrequency: number, maxSegments: number, onProgress: (message: string) => void, strategy: string = "track-corridor", minOpacity: number, maxOpacity: number): Promise<FrequencyAnalysisResult> {

    if (!this.strategies.has(strategy)) {
      logger.warn(`Strategy '${strategy}' not found, using 'track-corridor' instead`);
      strategy = "track-corridor";
    }

    return this.analyzeWithStrategy(files, strategy, gridSize, minFrequency, maxSegments, onProgress, minOpacity, maxOpacity);
  }

  private async analyzeWithStrategy(files: TFile[], strategyName: string, gridSize: Meters, minFrequency: number, maxSegments: number, onProgress: (message: string) => void, minOpacity: number, maxOpacity: number): Promise<FrequencyAnalysisResult> {
    onProgress("Extracting tracks...");
    const tracks: FrequencyTrackData[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      if (i % 5 === 0 || i === files.length - 1) {
        onProgress(`Extracting tracks... ${i + 1}/${files.length}`);
      }

      const coordinates = await this.trackExtractor.extractTrackFromFile(file);

      if (coordinates.length > 0) {
        tracks.push({
          coordinates,
          sourceFile: file.path
        });
      }
    }

    logger.debug(`Using web worker for ${strategyName} analysis`);
    const workerManager = getFrequencyWorkerManager();
    return workerManager.analyze(strategyName, tracks, {
      gridSize,
      minFrequency,
      maxSegments,
      onProgress,
      minOpacity,
      maxOpacity
    });
  }

}
