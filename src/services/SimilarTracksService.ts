import { App, normalizePath, TFile } from "obsidian";
import { Coordinate, DistanceCalculator } from "places-shared/geo";
import { getFileNameWithoutExtension } from "places-shared/utils";
import { TrackDataService } from "./TrackDataService";
import { TrackMatcher, TrackSimilarity } from "./TrackMatcher";
import { TrackDataExtractor } from "./TrackDataExtractor";
import { Kilometers, Meters, km } from "places-shared/units";
import {
  DEFAULT_FRECHET_TOLERANCE,
  DEFAULT_OVERLAP_TOLERANCE_METERS,
  DEFAULT_MIN_SIMILARITY
} from "../constants/track";

export interface SimilarTracksOptions {
  // Minimum Fréchet similarity (0-1). If undefined and minOverlap undefined, defaults to 0.7
  minSimilarity?: number;
  // Minimum overlap (0-1). Accepts input as 0-1 or 0-100. Can be used alone or with minSimilarity
  minOverlap?: number;
  maxResults?: number;
  includeReverse?: boolean;
  timeoutMs?: number;
  // Distance tolerance in degrees for Fréchet similarity (default: 0.01 ≈ 1.1km). Higher = more lenient matching.
  tolerance?: number;
  // Tolerance in meters for overlap calculation (default: 50m)
  overlapToleranceMeters?: Meters;
}

export interface NearPointOptions {
  radiusKm?: Kilometers;
  maxResults?: number;
  sortByDistance?: boolean;
}

export interface NearbyTrackResult {
  filePath: string;
  fileName: string;
  distance: Kilometers;
  closestPoint: Coordinate;
}

export interface TrackContext {
  sourcePath: string;
}

class SimilarTracksError extends Error {
  constructor(public code: 'INVALID_CONTEXT' | 'NO_TRACK_DATA' | 'PROCESSING_ERROR' | 'TIMEOUT', message: string, public details?: unknown) {
    super(message);
    this.name = 'SimilarTracksError';
  }
}

export class SimilarTracksService {
  private trackExtractor: TrackDataExtractor;

  constructor(private app: App, trackDataService: TrackDataService) {
    this.trackExtractor = new TrackDataExtractor(app, trackDataService);
  }

  hasTrackData(filePath: string): boolean {
    return this.trackExtractor.hasTrackData(filePath);
  }

  async findSimilarTracks(ctx: TrackContext, options: SimilarTracksOptions = {}): Promise<TrackSimilarity[]> {
    const {
      minSimilarity,
      minOverlap,
      maxResults = 20,
      timeoutMs = 30000,
      tolerance = DEFAULT_FRECHET_TOLERANCE,
      overlapToleranceMeters = DEFAULT_OVERLAP_TOLERANCE_METERS
    } = options;

    const effectiveMinSimilarity = minSimilarity === undefined && minOverlap === undefined ? DEFAULT_MIN_SIMILARITY : minSimilarity;

    const currentFile = this.validateContext(ctx);

    let timeoutId: number | null = null;
    const timeoutPromise = new Promise<TrackSimilarity[]>(
      (_, reject) => {
        timeoutId = window.setTimeout(() => reject(new SimilarTracksError(
          'TIMEOUT',
          `Track similarity search timed out after ${timeoutMs}ms`
        )), timeoutMs);
      }
    );

    const searchPromise = this.performSimilaritySearch(
      currentFile,
      effectiveMinSimilarity,
      minOverlap,
      maxResults,
      tolerance,
      overlapToleranceMeters
    );

    try {
      return await Promise.race([searchPromise, timeoutPromise]);
    } catch (error) {
      if (error instanceof SimilarTracksError) {
        throw error;
      }
      throw new SimilarTracksError(
        'PROCESSING_ERROR',
        'Failed to process similarity search',
        error
      );
    } finally {
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
    }
  }

  private validateContext(ctx: TrackContext): TFile {
    if (!ctx.sourcePath) {
      throw new SimilarTracksError(
        'INVALID_CONTEXT',
        'Context must contain a valid sourcePath'
      );
    }

    const currentFile = this.app.vault.getFileByPath(normalizePath(ctx.sourcePath));
    if (!currentFile) {
      throw new SimilarTracksError(
        'INVALID_CONTEXT',
        `File not found: ${ctx.sourcePath}`
      );
    }

    return currentFile;
  }

  private async performSimilaritySearch(currentFile: TFile, minSimilarity: number | undefined, minOverlap: number | undefined, maxResults: number, tolerance: number, overlapToleranceMeters: Meters): Promise<TrackSimilarity[]> {
    try {
      const currentTrack = await this.trackExtractor.extractTrackFromFile(currentFile);
      if (!currentTrack || currentTrack.length === 0) {
        throw new SimilarTracksError(
          'NO_TRACK_DATA',
          'No track data found in the current file'
        );
      }

      if (currentTrack.length < 2) {
        throw new SimilarTracksError(
          'NO_TRACK_DATA',
          'Track must have at least 2 points for similarity comparison'
        );
      }

      const candidateTracks = await this.trackExtractor.getAllTracksFromVault(currentFile.path);

      if (candidateTracks.size === 0) {
        return []; // No candidates, but not an error
      }

      const results = TrackMatcher.findSimilarTracks(
        currentTrack,
        candidateTracks,
        {
          minSimilarity,
          minOverlap,
          tolerance,
          overlapToleranceMeters
        }
      );

      const limitedResults = results.slice(0, maxResults);

      return limitedResults;
    } catch (error) {
      if (error instanceof SimilarTracksError) {
        throw error;
      }
      throw new SimilarTracksError(
        'PROCESSING_ERROR',
        'Error during similarity search',
        error
      );
    }
  }

  async findTracksNearPoint(point: { latitude: number; longitude: number }, options: NearPointOptions = {}, excludePath?: string): Promise<NearbyTrackResult[]> {
    const {
      radiusKm = km(1.0),
      maxResults = 50,
      sortByDistance = true
    } = options;

    this.validatePoint(point);

    try {
      const results: NearbyTrackResult[] = [];
      const candidateTracks = await this.trackExtractor.getAllTracksFromVault(excludePath ?? '');

      for (const [filePath, track] of candidateTracks) {
        const result = this.processTrackForNearPoint(point, filePath, track, radiusKm);
        if (result) {
          results.push(result);
        }

        // 2x the needed results leaves the sort something to choose from.
        if (results.length >= maxResults * 2) {
          break;
        }
      }

      if (sortByDistance) {
        results.sort((a, b) => a.distance - b.distance);
      }

      return results.slice(0, maxResults);
    } catch (error) {
      if (error instanceof SimilarTracksError) {
        throw error;
      }
      throw new SimilarTracksError(
        'PROCESSING_ERROR',
        'Error searching for nearby tracks',
        error
      );
    }
  }

  private validatePoint(point: { latitude: number; longitude: number }): void {
    if (!point || typeof point !== 'object') {
      throw new SimilarTracksError(
        'INVALID_CONTEXT',
        'Point must be a valid object with latitude and longitude'
      );
    }

    const { latitude, longitude } = point;

    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
      throw new SimilarTracksError(
        'INVALID_CONTEXT',
        'Latitude and longitude must be numbers'
      );
    }

    if (isNaN(latitude) || isNaN(longitude)) {
      throw new SimilarTracksError(
        'INVALID_CONTEXT',
        'Latitude and longitude cannot be NaN'
      );
    }

    if (latitude < -90 || latitude > 90) {
      throw new SimilarTracksError(
        'INVALID_CONTEXT',
        'Latitude must be between -90 and 90 degrees'
      );
    }

    if (longitude < -180 || longitude > 180) {
      throw new SimilarTracksError(
        'INVALID_CONTEXT',
        'Longitude must be between -180 and 180 degrees'
      );
    }
  }

  private processTrackForNearPoint(point: { latitude: number; longitude: number }, filePath: string, track: Coordinate[], radiusKm: Kilometers): NearbyTrackResult | null {
    const closestDistance = this.findClosestPointOnTrack(point, track);

    if (closestDistance.distance <= radiusKm) {
      return {
        filePath,
        fileName: getFileNameWithoutExtension(filePath, filePath, /\.md$/i),
        distance: closestDistance.distance,
        closestPoint: closestDistance.point
      };
    }

    return null;
  }

  private findClosestPointOnTrack(targetPoint: { latitude: number; longitude: number }, track: Coordinate[]): { distance: Kilometers; point: Coordinate } {
    if (track.length === 0) {
      throw new Error('Track must contain at least one point');
    }

    if (track.length === 1) {
      const distance = DistanceCalculator.haversineDistance(
        targetPoint.latitude, targetPoint.longitude,
        track[0].latitude, track[0].longitude
      );
      return { distance, point: track[0] };
    }

    return track.reduce((closest, trackPoint) => {
      const distance = DistanceCalculator.haversineDistance(
        targetPoint.latitude, targetPoint.longitude,
        trackPoint.latitude, trackPoint.longitude
      );

      return distance < closest.distance
        ? { distance, point: trackPoint }
        : closest;
    }, {
      distance: km(Infinity),
      point: track[0]
    });
  }

}
