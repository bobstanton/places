import { Coordinate, PlacesBoundingBox, DistanceCalculator } from "places-shared/geo";
import { Kilometers, Meters, km } from "places-shared/units";
import { getFileNameWithoutExtension } from "places-shared/utils";
import { TrackComparisonUtilities } from './TrackComparisonUtilities';
import {
  DEFAULT_FRECHET_TOLERANCE,
  DEFAULT_OVERLAP_TOLERANCE_METERS,
  DEFAULT_MIN_SIMILARITY
} from '../constants/track';


// Bounding box padding in degrees for overlap detection
const BOUNDING_BOX_PADDING = 0.01;

// Minimum point count ratio to consider tracks comparable
const MIN_POINT_COUNT_RATIO = 0.1;

// Minimum distance ratio to consider tracks comparable
const MIN_DISTANCE_RATIO = 0.2;


export interface TrackSimilarity {
  filePath: string;
  fileName: string;
  similarity: number; // 0-1, where 1 is identical (Fréchet-based)
  overlapPercent: number; // 0-100, percentage of target track within tolerance of candidate
  lengthMatchPercentage: number; // How similar the track distances are
  distance: Kilometers;
  metadata?: {
    forwardSimilarity: number;
    reverseSimilarity: number;
    forwardOverlap: number;
    reverseOverlap: number;
    pointsCompared: number;
    processingTimeMs: number;
  };
}

export interface TrackMatcherOptions {
  // Minimum Fréchet similarity (0-1). If undefined, Fréchet filtering is skipped.
  minSimilarity?: number;
  // Minimum overlap as fraction (0-1). If undefined, overlap filtering is skipped.
  minOverlap?: number;
  // Distance tolerance in degrees for Fréchet similarity (default: 0.01 ≈ 1.1km)
  tolerance?: number;
  // Tolerance in meters for overlap calculation (default: 50m)
  overlapToleranceMeters?: Meters;
}


function calculateRatio(a: number, b: number): number {
  if (a === 0 && b === 0) return 1;
  return Math.min(a, b) / Math.max(a, b);
}

export class TrackMatcher {
  private static readonly derivedByTrack = new WeakMap<Coordinate[], {
    bounds: PlacesBoundingBox;
    distance: Kilometers;
    simplified: Coordinate[];
  }>();

  private static getDerived(track: Coordinate[]): { bounds: PlacesBoundingBox; distance: Kilometers; simplified: Coordinate[] } {
    let derived = this.derivedByTrack.get(track);
    if (!derived) {
      derived = {
        bounds: PlacesBoundingBox.fromCoordinates(track, BOUNDING_BOX_PADDING),
        distance: km(DistanceCalculator.calculatePolylineDistanceKm(track)),
        simplified: TrackComparisonUtilities.simplifyForComparison(track),
      };
      this.derivedByTrack.set(track, derived);
    }
    return derived;
  }

  // `candidateTracks` is keyed by file path.
  static findSimilarTracks(targetTrack: Coordinate[], candidateTracks: Map<string, Coordinate[]>, options: TrackMatcherOptions = {}): TrackSimilarity[] {
    const {
      minSimilarity,
      minOverlap,
      tolerance = DEFAULT_FRECHET_TOLERANCE,
      overlapToleranceMeters = DEFAULT_OVERLAP_TOLERANCE_METERS
    } = options;

    if (targetTrack.length < 2) return [];

    const effectiveMinSimilarity = (minSimilarity === undefined && minOverlap === undefined)
      ? DEFAULT_MIN_SIMILARITY
      : minSimilarity;

    const targetDistance = km(DistanceCalculator.calculatePolylineDistanceKm(targetTrack));
    const targetBounds = PlacesBoundingBox.fromCoordinates(targetTrack, BOUNDING_BOX_PADDING);
    const results: TrackSimilarity[] = [];

    const targetSimplified = TrackComparisonUtilities.simplifyForComparison(targetTrack);

    for (const [filePath, candidateTrack] of candidateTracks) {
      const trackStartTime = performance.now();

      const candidateDerived = this.getDerived(candidateTrack);
      const filterResult = this.applyEarlyFilters(
        targetTrack,
        candidateTrack,
        targetBounds,
        targetDistance,
        candidateDerived,
      );

      if (!filterResult.passed) continue;

      const metrics = TrackComparisonUtilities.calculateFullMetrics(
        targetSimplified,
        candidateDerived.simplified,
        tolerance,
        overlapToleranceMeters,
        true,
        true,
      );

      const passesSimilarity = effectiveMinSimilarity === undefined ||
        metrics.similarity >= effectiveMinSimilarity;
      const passesOverlap = minOverlap === undefined ||
        metrics.overlapPercent >= minOverlap * 100;

      if (passesSimilarity && passesOverlap) {
        const processingTime = performance.now() - trackStartTime;

        results.push({
          filePath,
          fileName: getFileNameWithoutExtension(filePath, 'Unknown', /\.md$/i),
          similarity: metrics.similarity,
          overlapPercent: metrics.overlapPercent,
          lengthMatchPercentage: (filterResult.distanceRatio ?? 0) * 100,
          distance: filterResult.candidateDistance ?? km(0),
          metadata: {
            forwardSimilarity: metrics.forward.similarity,
            reverseSimilarity: metrics.reverse.similarity,
            forwardOverlap: metrics.forward.overlapPercent,
            reverseOverlap: metrics.reverse.overlapPercent,
            pointsCompared: metrics.pointsCompared,
            processingTimeMs: processingTime
          }
        });
      }
    }

    if (effectiveMinSimilarity !== undefined) {
      return results.sort((a, b) => b.similarity - a.similarity);
    } else {
      return results.sort((a, b) => b.overlapPercent - a.overlapPercent);
    }
  }

  private static applyEarlyFilters(targetTrack: Coordinate[], candidateTrack: Coordinate[], targetBounds: PlacesBoundingBox, targetDistance: Kilometers, candidateDerived: { bounds: PlacesBoundingBox; distance: Kilometers }): {
    passed: boolean;
    candidateDistance?: Kilometers;
    distanceRatio?: number;
  } {
    if (candidateTrack.length < 2) {
      return { passed: false };
    }

    const pointCountRatio = calculateRatio(targetTrack.length, candidateTrack.length);
    if (pointCountRatio < MIN_POINT_COUNT_RATIO) {
      return { passed: false };
    }

    if (!PlacesBoundingBox.overlaps(targetBounds, candidateDerived.bounds)) {
      return { passed: false };
    }

    const candidateDistance = candidateDerived.distance;
    const distanceRatio = calculateRatio(targetDistance, candidateDistance);

    if (distanceRatio < MIN_DISTANCE_RATIO) {
      return { passed: false };
    }

    return {
      passed: true,
      candidateDistance,
      distanceRatio
    };
  }
}
