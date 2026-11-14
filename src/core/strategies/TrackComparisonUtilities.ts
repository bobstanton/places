import { Meters } from "places-shared/worker-safe";
import { Coordinate, DistanceCalculator } from "places-shared/worker-safe";
import { CoordinateSimplifier } from './CoordinateSimplifier';
import { SpatialRadiusGrid } from './SpatialRadiusGrid';

export interface OverlapResult {
  overlapPercent: number;
  overlapFlags: boolean[];
  matchedIndices: (number | null)[];
}

export interface BidirectionalResult<T> {
  forward: T;
  reverse: T;
  best: T;
  isReverseBetter: boolean;
}

export interface TrackComparisonMetrics {
  similarity: number;
  overlapPercent: number;
  forward: { similarity: number; overlapPercent: number };
  reverse: { similarity: number; overlapPercent: number };
  pointsCompared: number;
}

export class TrackComparisonUtilities {
  static simplifyForComparison(track: Coordinate[], tolerance = 0.0001, maxPoints = 500): Coordinate[] {
    let simplified = CoordinateSimplifier.simplify(track, tolerance);

    if (simplified.length > maxPoints) {
      simplified = CoordinateSimplifier.uniformSubsample(simplified, maxPoints);
    }

    return simplified;
  }

  static calculateOverlapWithIndex(track: Coordinate[], otherTrackIndex: SpatialRadiusGrid<number>, toleranceMeters: Meters): OverlapResult {
    const overlapFlags: boolean[] = [];
    const matchedIndices: (number | null)[] = [];

    for (const coord of track) {
      const closest = otherTrackIndex.findNearest(coord.latitude, coord.longitude, toleranceMeters);

      overlapFlags.push(closest !== null);
      matchedIndices.push(closest?.data ?? null);
    }

    let overlappingDistance = 0;
    let totalDistance = 0;

    for (let i = 1; i < track.length; i++) {
      const segmentDistance = DistanceCalculator.haversineDistanceMeters(
        track[i - 1].latitude, track[i - 1].longitude,
        track[i].latitude, track[i].longitude
      );

      totalDistance += segmentDistance;

      if (overlapFlags[i - 1] && overlapFlags[i]) {
        overlappingDistance += segmentDistance;
      }
    }

    const overlapPercent = totalDistance > 0 ? (overlappingDistance / totalDistance) * 100 : 0;

    return { overlapPercent, overlapFlags, matchedIndices };
  }

  static calculateOverlap(track: Coordinate[], otherTrack: Coordinate[], toleranceMeters: Meters): OverlapResult {
    return this.calculateOverlapWithIndex(track, this.buildPointIndex(otherTrack, toleranceMeters), toleranceMeters);
  }

  static buildPointIndex(track: Coordinate[], toleranceMeters: Meters): SpatialRadiusGrid<number> {
    const grid = SpatialRadiusGrid.fromCellSizeMeters<number>((toleranceMeters as number) * 2);

    for (let i = 0; i < track.length; i++) {
      grid.add(track[i].latitude, track[i].longitude, i);
    }

    return grid;
  }

  static compareInBothDirections<T>(track1: Coordinate[], track2: Coordinate[], compareFn: (t1: Coordinate[], t2: Coordinate[]) => T, getBetterFn: (forward: T, reverse: T) => boolean): BidirectionalResult<T> {
    const forward = compareFn(track1, track2);
    const reverse = compareFn(track1, track2.slice().reverse());
    const isReverseBetter = getBetterFn(forward, reverse);

    return {
      forward,
      reverse,
      best: isReverseBetter ? reverse : forward,
      isReverseBetter
    };
  }

  static calculateFullMetrics(track1: Coordinate[], track2: Coordinate[], frechetTolerance: number, overlapToleranceMeters: Meters, track1PreSimplified = false, track2PreSimplified = false): TrackComparisonMetrics {
    const track1Simplified = track1PreSimplified ? track1 : this.simplifyForComparison(track1);
    const track2Simplified = track2PreSimplified ? track2 : this.simplifyForComparison(track2);
    const track2Reversed = track2Simplified.slice().reverse();

    const track2Index = this.buildPointIndex(track2Simplified, overlapToleranceMeters);
    const track2ReversedIndex = this.buildPointIndex(track2Reversed, overlapToleranceMeters);

    const forwardSimilarity = DistanceCalculator.discreteFrechetSimilarity(track1Simplified, track2Simplified, frechetTolerance);
    const reverseSimilarity = DistanceCalculator.discreteFrechetSimilarity(track1Simplified, track2Reversed, frechetTolerance);

    const forwardOverlap = this.calculateOverlapWithIndex(track1Simplified, track2Index, overlapToleranceMeters);
    const reverseOverlap = this.calculateOverlapWithIndex(track1Simplified, track2ReversedIndex, overlapToleranceMeters);

    return {
      similarity: Math.max(forwardSimilarity, reverseSimilarity),
      overlapPercent: Math.max(forwardOverlap.overlapPercent, reverseOverlap.overlapPercent),
      forward: {
        similarity: forwardSimilarity,
        overlapPercent: forwardOverlap.overlapPercent
      },
      reverse: {
        similarity: reverseSimilarity,
        overlapPercent: reverseOverlap.overlapPercent
      },
      pointsCompared: Math.max(track1Simplified.length, track2Simplified.length)
    };
  }

  static analyzeDirection(track1MatchedIndices: (number | null)[]): 'same' | 'opposite' | 'mixed' {
    const matchedSegments: Array<{ track1Start: number; track1End: number; track2Start: number; track2End: number }> = [];

    for (let i = 1; i < track1MatchedIndices.length; i++) {
      const prevMatch = track1MatchedIndices[i - 1];
      const currMatch = track1MatchedIndices[i];

      if (prevMatch !== null && currMatch !== null && prevMatch !== currMatch) {
        matchedSegments.push({
          track1Start: i - 1,
          track1End: i,
          track2Start: prevMatch,
          track2End: currMatch
        });
      }
    }

    if (matchedSegments.length === 0) {
      return 'same';  
    }

    let sameDirectionCount = 0;
    let oppositeDirectionCount = 0;

    for (const segment of matchedSegments) {
      const track1Direction = segment.track1End > segment.track1Start ? 1 : -1;
      const track2Direction = segment.track2End > segment.track2Start ? 1 : -1;

      if (track1Direction === track2Direction) {
        sameDirectionCount++;
      } else {
        oppositeDirectionCount++;
      }
    }

    if (sameDirectionCount > 0 && oppositeDirectionCount === 0) return 'same';
    if (oppositeDirectionCount > 0 && sameDirectionCount === 0) return 'opposite';

    return 'mixed';
  }
}
