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
  minOpacity?: number;  
  maxOpacity?: number;  
  isMobile?: boolean;  
}

export interface FrequencyTrackData {
  coordinates: Coordinate[];
  sourceFile: string;
}

export interface IFrequencyStrategy {
  analyze(tracks: FrequencyTrackData[], options: StrategyOptions): Promise<FrequencyAnalysisResult>;

  convertToMapPlaces(result: FrequencyAnalysisResult, colorScheme: string, lineWidth?: number, lineStyle?: string, fixedOpacity?: number): MapPlace[];

  readonly name: string;

  readonly outputType: 'points' | 'segments';
}
