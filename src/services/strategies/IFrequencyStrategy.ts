import { Coordinate, Meters, MapPlace } from "places-shared/worker-safe";

export interface FrequencySegment {
  coordinates: Coordinate[];
  frequency: number;
  normalizedScore: number;
  contributingFiles?: string[];
}

export interface FrequencyAnalysisResult {
  segments: FrequencySegment[];
  bounds: {
    minLat: number;
    maxLat: number;
    minLng: number;
    maxLng: number;
  };
}

export interface StrategyOptions {
  gridSize?: Meters;
  simplificationTolerance?: number;
  similarityThreshold?: number;
  snapThreshold?: number;
  averageSegments?: boolean;
  minFrequency: number;
  maxSegments: number;
  onProgress?: (message: string) => void;
  minOpacity?: number; // Opacity-stacking strategy only (0.0-1.0)
  maxOpacity?: number; // Opacity-stacking strategy only (0.0-1.0)
  isMobile?: boolean; // Passed from the main thread; the worker cannot detect the device
}

export interface FrequencyTrackData {
  coordinates: Coordinate[];
  sourceFile: string;
}

export interface IFrequencyStrategy {
  analyze(tracks: FrequencyTrackData[], options: StrategyOptions): Promise<FrequencyAnalysisResult>;

  // @param colorScheme Preset name (`yellow-to-red`, `blues`) or a comma-separated list of hex colors
  // @param lineThickness Pixels
  // @param lineStyle Dash pattern ("5,10")
  // @param fixedOpacity 0.0-1.0; overrides the spatial overlap calculation
  convertToMapPlaces(result: FrequencyAnalysisResult, colorScheme: string, lineThickness?: number, lineStyle?: string, fixedOpacity?: number): MapPlace[];

  // Logging/debugging only.
  readonly name: string;

  // 'points' feeds heatmap layer rendering; 'segments' feeds frequency line rendering.
  readonly outputType: 'points' | 'segments';
}
