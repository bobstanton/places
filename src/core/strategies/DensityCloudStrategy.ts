import { Coordinate, Meters, DistanceCalculator, MapPlace, numericRange } from "places-shared/worker-safe";
import { METERS_PER_DEGREE_LAT } from "./spatial";
import { IFrequencyStrategy, FrequencyTrackData, FrequencyAnalysisResult, StrategyOptions, FrequencySegment } from "./IFrequencyStrategy";
import { SpatialUtils } from "./SpatialUtils";
import { ProgressReporter } from "./ProgressReporter";
import { StrategyTimings } from "./StrategyTimings";

const logger = {
  debug: (...args: unknown[]) => {
    console.debug('[DensityCloud]', ...args);
  },
};

interface PointWithMetadata extends Coordinate {
  trackIndex: number;
  pointIndex: number;         
  sourceFile: string;
}

interface DensitySpatialIndex {
  grid: Map<string, PointWithMetadata[]>;
  cellSizeDegrees: number;
}

export class DensityCloudStrategy implements IFrequencyStrategy {
  readonly name = "density-cloud";
  readonly outputType = "points" as const;

  analyze(tracks: FrequencyTrackData[], options: StrategyOptions): Promise<FrequencyAnalysisResult> {
    return Promise.resolve(this.analyzeSync(tracks, options));
  }

  private analyzeSync(tracks: FrequencyTrackData[], options: StrategyOptions): FrequencyAnalysisResult {
    const { onProgress, gridSize = 100 as Meters } = options;
    const progress = new ProgressReporter(onProgress);

    const overlapRadiusMeters = gridSize as number;  
    const sampleDistanceMeters = (gridSize as number) / 2;  

    if (tracks.length === 0) {
      return { segments: [], bounds: { minLat: 0, maxLat: 0, minLng: 0, maxLng: 0 } };
    }

    progress.report(0);
    const sampledPoints: PointWithMetadata[] = [];

    for (let trackIdx = 0; trackIdx < tracks.length; trackIdx++) {
      const track = tracks[trackIdx];

      if (track.coordinates.length === 0) continue;

      const trackSamples = this.sampleTrackPoints(track.coordinates, trackIdx, track.sourceFile, sampleDistanceMeters);

      sampledPoints.push(...trackSamples);

      if (trackIdx % 5 === 0) {
        progress.reportPhase("Sampling tracks", 0, 20, trackIdx / tracks.length);
      }
    }

    progress.report(20);
    const spatialIndex = this.buildSpatialIndex(sampledPoints, overlapRadiusMeters);

    progress.report(25);
    const segments: FrequencySegment[] = [];

    const timings = new StrategyTimings();

    for (let i = 0; i < sampledPoints.length; i++) {
      const point = sampledPoints[i];
      const contributingTracks = new Set<string>();

      contributingTracks.add(point.sourceFile);  

      const candidates = this.getCandidatePoints(point, spatialIndex, overlapRadiusMeters);

      for (const other of candidates) {
        if (other.trackIndex === point.trackIndex) continue;
        if (other === point) continue;

        const distMeters = DistanceCalculator.haversineDistanceMeters(
          point.latitude,
          point.longitude,
          other.latitude,
          other.longitude
        );

        if (distMeters <= overlapRadiusMeters) {
          contributingTracks.add(other.sourceFile);
        }
      }

      const frequency = contributingTracks.size;
      const contributingFiles = Array.from(contributingTracks);

      segments.push({
        coordinates: [point],
        frequency,
        normalizedScore: 0,  
        contributingFiles
      });

      const now = Date.now();

      if (i % 100 === 0 || timings.shouldReportProgress('frequency-calculation', 200, now)) {
        progress.reportPhase("Calculating frequency", 25, 85, i / sampledPoints.length);
      }
    }

    const mergeDistanceMeters = (gridSize as number) / 2;  

    progress.report(85);

    const mergeIndex = this.buildSpatialIndexForSegments(segments, mergeDistanceMeters);
    const mergedSegments = this.mergeNearbyPointsWithIndex(segments, mergeIndex, mergeDistanceMeters);

    progress.report(95);
    const minFrequency = options.minFrequency || 2;

    const freqDistribution = new Map<number, number>();

    for (const seg of mergedSegments) {
      freqDistribution.set(seg.frequency, (freqDistribution.get(seg.frequency) || 0) + 1);
    }

    logger.debug('Tracks:', tracks.length);
    logger.debug('Sampled points:', sampledPoints.length);
    logger.debug('Merged segments:', mergedSegments.length);
    logger.debug('Frequency distribution:', Object.fromEntries(freqDistribution));
    logger.debug('Min frequency filter:', minFrequency);

    const filteredSegments = mergedSegments.filter(seg => seg.frequency >= minFrequency);

    logger.debug('After filtering:', filteredSegments.length, 'segments');

    progress.report(98);
    const frequencyRange = numericRange(filteredSegments.map(s => s.frequency));

    if (frequencyRange) {
      const range = frequencyRange.max - frequencyRange.min;

      filteredSegments.forEach(segment => {
        segment.normalizedScore = range > 0 ? (segment.frequency - frequencyRange.min) / range : 1.0;
      });
    }

    const bounds = SpatialUtils.calculateBounds(filteredSegments.map(s => s.coordinates[0]));

    return { segments: filteredSegments, bounds };
  }

  private buildSpatialIndexForSegments(segments: FrequencySegment[], mergeDistanceMeters: number): Map<string, number[]> {
    const cellSizeMeters = mergeDistanceMeters * 2;
    const grid = new Map<string, number[]>();

    for (let i = 0; i < segments.length; i++) {
      const coord = segments[i].coordinates[0];
      const key = SpatialUtils.getGridKey(coord.latitude, coord.longitude, cellSizeMeters);

      if (!grid.has(key)) {
        grid.set(key, []);
      }

      grid.get(key)!.push(i);
    }

    return grid;
  }

  private getCandidateSegmentIndices(coord: Coordinate, grid: Map<string, number[]>, mergeDistanceMeters: number): number[] {
    const candidates: number[] = [];
    const cellSizeMeters = mergeDistanceMeters * 2;

    const { gridX, gridY } = SpatialUtils.getGridCoordinates(coord.latitude, coord.longitude, cellSizeMeters);

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const key = `${gridX + dx},${gridY + dy}`;
        const cellIndices = grid.get(key);

        if (cellIndices) {
          candidates.push(...cellIndices);
        }
      }
    }

    return candidates;
  }

  private mergeNearbyPointsWithIndex(segments: FrequencySegment[], grid: Map<string, number[]>, mergeDistanceMeters: number): FrequencySegment[] {
    if (segments.length === 0) return [];

    const merged: FrequencySegment[] = [];
    const processed = new Set<number>();

    for (let i = 0; i < segments.length; i++) {
      if (processed.has(i)) continue;

      const cluster: FrequencySegment[] = [segments[i]];

      processed.add(i);
      const seedPoint = segments[i].coordinates[0];

      const candidateIndices = this.getCandidateSegmentIndices(seedPoint, grid, mergeDistanceMeters);

      for (const j of candidateIndices) {
        if (j <= i || processed.has(j)) continue;

        const distMeters = DistanceCalculator.haversineDistanceMeters(
          seedPoint.latitude,
          seedPoint.longitude,
          segments[j].coordinates[0].latitude,
          segments[j].coordinates[0].longitude
        );

        if (distMeters <= mergeDistanceMeters) {
          cluster.push(segments[j]);
          processed.add(j);
        }
      }

      const allFiles = new Set<string>();

      cluster.forEach(s => s.contributingFiles?.forEach(f => allFiles.add(f)));

      const centroid = this.calculateSegmentCentroid(cluster);

      const mergedFrequency = allFiles.size;

      merged.push({
        coordinates: [centroid],
        frequency: mergedFrequency,
        normalizedScore: 0,
        contributingFiles: Array.from(allFiles)
      });
    }

    return merged;
  }

  private calculateSegmentCentroid(segments: FrequencySegment[]): Coordinate {
    return SpatialUtils.calculateCentroid(segments.map(s => s.coordinates[0]));
  }

  private sampleTrackPoints(coordinates: Coordinate[], trackIndex: number, sourceFile: string, sampleDistanceMeters: number): PointWithMetadata[] {
    const samples: PointWithMetadata[] = [];

    if (coordinates.length === 0) return samples;

    samples.push({
      latitude: coordinates[0].latitude,
      longitude: coordinates[0].longitude,
      trackIndex,
      pointIndex: 0,
      sourceFile
    });

    let accumulatedDistance = 0;
    const sampleDistanceKm = sampleDistanceMeters / 1000;

    for (let i = 1; i < coordinates.length; i++) {
      const segmentDistKm = DistanceCalculator.haversineDistance(
        coordinates[i - 1].latitude,
        coordinates[i - 1].longitude,
        coordinates[i].latitude,
        coordinates[i].longitude
      );

      accumulatedDistance += segmentDistKm;

      if (accumulatedDistance >= sampleDistanceKm) {
        samples.push({
          latitude: coordinates[i].latitude,
          longitude: coordinates[i].longitude,
          trackIndex,
          pointIndex: i,
          sourceFile
        });
        accumulatedDistance -= sampleDistanceKm;  
      }
    }

    if (coordinates.length > 1) {
      samples.push({
        latitude: coordinates[coordinates.length - 1].latitude,
        longitude: coordinates[coordinates.length - 1].longitude,
        trackIndex,
        pointIndex: coordinates.length - 1,
        sourceFile
      });
    }

    return samples;
  }

  private buildSpatialIndex(points: PointWithMetadata[], overlapRadiusMeters: number): DensitySpatialIndex {
    const cellSizeMeters = overlapRadiusMeters * 2;
    const cellSizeDegrees = cellSizeMeters / METERS_PER_DEGREE_LAT;  

    const grid = new Map<string, PointWithMetadata[]>();

    for (const point of points) {
      const key = SpatialUtils.getGridKey(point.latitude, point.longitude, cellSizeMeters);

      if (!grid.has(key)) {
        grid.set(key, []);
      }

      grid.get(key)!.push(point);
    }

    return { grid, cellSizeDegrees };
  }

  private getCandidatePoints(point: PointWithMetadata, spatialIndex: DensitySpatialIndex, overlapRadiusMeters: number): PointWithMetadata[] {
    const candidates: PointWithMetadata[] = [];
    const cellSizeMeters = overlapRadiusMeters * 2;

    const { gridX, gridY } = SpatialUtils.getGridCoordinates(point.latitude, point.longitude, cellSizeMeters);

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const key = `${gridX + dx},${gridY + dy}`;
        const cellPoints = spatialIndex.grid.get(key);

        if (cellPoints) {
          candidates.push(...cellPoints);
        }
      }
    }

    return candidates;
  }

  convertToMapPlaces(result: FrequencyAnalysisResult, colorScheme: string, _lineWidth?: number, _lineStyle?: string, _fixedOpacity?: number): MapPlace[] {
    const places: MapPlace[] = [];

    for (const segment of result.segments) {
      if (segment.coordinates.length === 0) continue;

      const coord = segment.coordinates[0];

      const place: MapPlace = {
        latitude: coord.latitude,
        longitude: coord.longitude,
        name: '',
        icon: '',
        metadata: {
          heatmapWeight: segment.frequency,
          normalizedWeight: segment.normalizedScore,
          colorScheme: colorScheme,
          frequency: segment.frequency,
          contributingFiles: segment.contributingFiles || []
        }
      };

      places.push(place);
    }

    return places;
  }
}
