import { TFile } from "obsidian";
import { Kilometers, km, Meters, meters } from "places-shared/units";
import { Coordinate, DistanceCalculator } from "places-shared/geo";
import { TrackMetricsCalculator } from "./TrackMetricsCalculator";
import { TrackPoint } from "./TrackDataService";

import { TrackComparisonUtilities } from "./TrackComparisonUtilities";
import { DEFAULT_FRECHET_TOLERANCE } from "../constants/track";


// Minimum gap distance in meters for continuation detection
const MIN_CONTINUATION_GAP_METERS = 500;


export type TrackRelationship =
  | 'no-overlap'
  | 'partial-overlap'
  | 'continuation'
  | 'subset'
  | 'nearly-identical';

export type DirectionRelationship = 'same' | 'opposite' | 'mixed';

export interface DivergencePoint {
  coordinate: Coordinate;
  track1Index: number;
  track2Index: number | null;
  type: 'divergence' | 'convergence' | 'continuation-gap';
  gapDistanceMeters?: Meters;
}

export interface ElevationComparison {
  track1: {
    gainMeters: Meters;
    lossMeters: Meters;
    minMeters?: Meters;
    maxMeters?: Meters;
  };
  track2: {
    gainMeters: Meters;
    lossMeters: Meters;
    minMeters?: Meters;
    maxMeters?: Meters;
  };
  available: boolean;
}

export interface TrackComparisonResult {
  track1Name: string;
  track1Path: string;
  track1LengthKm: Kilometers;
  track2Name: string;
  track2Path: string;
  track2LengthKm: Kilometers;
  track1OverlapPercent: number;
  track2OverlapPercent: number;
  sharedDistanceKm: Kilometers;
  // Fréchet similarity (0-1)
  frechetSimilarity: number;
  relationship: TrackRelationship;
  direction: DirectionRelationship;
  divergencePoints: DivergencePoint[];
  elevation: ElevationComparison;
  track1Coordinates: Coordinate[];
  track2Coordinates: Coordinate[];
  closestApproachMeters?: Meters;
  closestApproachLocation?: Coordinate;
}


export class TrackComparisonService {

  compare(track1Coords: Coordinate[], track1File: TFile, track2Coords: Coordinate[], track2File: TFile, toleranceMeters: Meters, track1Points: TrackPoint[], track2Points: TrackPoint[]): TrackComparisonResult {

    const track1LengthKm = DistanceCalculator.calculatePolylineDistanceKm(track1Coords);
    const track2LengthKm = DistanceCalculator.calculatePolylineDistanceKm(track2Coords);

    const track1Index = TrackComparisonUtilities.buildPointIndex(track1Coords, toleranceMeters);
    const track2Index = TrackComparisonUtilities.buildPointIndex(track2Coords, toleranceMeters);

    const track1Overlap = TrackComparisonUtilities.calculateOverlapWithIndex(track1Coords, track2Index, toleranceMeters);
    const track2Overlap = TrackComparisonUtilities.calculateOverlapWithIndex(track2Coords, track1Index, toleranceMeters);

    const sharedDistanceKm = km(
      ((track1LengthKm as number) * track1Overlap.overlapPercent / 100 +
       (track2LengthKm as number) * track2Overlap.overlapPercent / 100) / 2
    );

    const forwardFrechet = DistanceCalculator.discreteFrechetSimilarity(track1Coords, track2Coords, DEFAULT_FRECHET_TOLERANCE);
    const track2Reversed = track2Coords.slice().reverse();
    const reverseFrechet = DistanceCalculator.discreteFrechetSimilarity(track1Coords, track2Reversed, DEFAULT_FRECHET_TOLERANCE);
    const frechetSimilarity = Math.max(forwardFrechet, reverseFrechet);

    const direction = TrackComparisonUtilities.analyzeDirection(track1Overlap.matchedIndices);

    const { relationship, continuationGap } = this.detectRelationshipAndContinuation(
      track1Coords,
      track2Coords,
      track1Overlap.overlapPercent,
      track2Overlap.overlapPercent,
      toleranceMeters
    );

    const divergencePoints = this.findDivergencePoints(
      track1Coords,
      track1Overlap.overlapFlags,
      track1Overlap.matchedIndices
    );

    if (continuationGap) {
      divergencePoints.push(continuationGap);
    }

    const elevation = this.calculateElevationComparison(track1Points, track2Points);

    let closestApproachMeters: Meters | undefined;
    let closestApproachLocation: Coordinate | undefined;

    if (relationship === 'no-overlap') {
      const closest = this.findClosestApproach(track1Coords, track2Coords);
      closestApproachMeters = closest.distanceMeters;
      closestApproachLocation = closest.location;
    }

    return {
      track1Name: track1File.basename,
      track1Path: track1File.path,
      track1LengthKm,
      track2Name: track2File.basename,
      track2Path: track2File.path,
      track2LengthKm,
      track1OverlapPercent: track1Overlap.overlapPercent,
      track2OverlapPercent: track2Overlap.overlapPercent,
      sharedDistanceKm,
      frechetSimilarity,
      relationship,
      direction,
      divergencePoints,
      elevation,
      track1Coordinates: track1Coords,
      track2Coordinates: track2Coords,
      closestApproachMeters,
      closestApproachLocation
    };
  }

  // `continuationGap` is null unless the relationship is a continuation.
  private detectRelationshipAndContinuation(track1: Coordinate[], track2: Coordinate[], track1OverlapPercent: number, track2OverlapPercent: number, toleranceMeters: Meters): { relationship: TrackRelationship; continuationGap: DivergencePoint | null } {

    if (track1OverlapPercent > 90 && track2OverlapPercent > 90) {
      return { relationship: 'nearly-identical', continuationGap: null };
    }

    if (track1OverlapPercent > 90 || track2OverlapPercent > 90) {
      return { relationship: 'subset', continuationGap: null };
    }

    if (track1OverlapPercent < 20 && track2OverlapPercent < 20) {
      const maxGap = Math.max(toleranceMeters * 10, MIN_CONTINUATION_GAP_METERS);

      const end1ToStart2 = DistanceCalculator.haversineDistanceMeters(
        track1[track1.length - 1].latitude, track1[track1.length - 1].longitude,
        track2[0].latitude, track2[0].longitude
      );

      const end2ToStart1 = DistanceCalculator.haversineDistanceMeters(
        track2[track2.length - 1].latitude, track2[track2.length - 1].longitude,
        track1[0].latitude, track1[0].longitude
      );

      if (end1ToStart2 < maxGap && end1ToStart2 <= end2ToStart1) {
        return {
          relationship: 'continuation',
          continuationGap: {
            coordinate: track1[track1.length - 1],
            track1Index: track1.length - 1,
            track2Index: 0,
            type: 'continuation-gap',
            gapDistanceMeters: end1ToStart2
          }
        };
      }

      if (end2ToStart1 < maxGap) {
        return {
          relationship: 'continuation',
          continuationGap: {
            coordinate: track2[track2.length - 1],
            track1Index: 0,
            track2Index: track2.length - 1,
            type: 'continuation-gap',
            gapDistanceMeters: end2ToStart1
          }
        };
      }
    }

    if (track1OverlapPercent < 10 && track2OverlapPercent < 10) {
      return { relationship: 'no-overlap', continuationGap: null };
    }

    return { relationship: 'partial-overlap', continuationGap: null };
  }

  private findDivergencePoints(track: Coordinate[], overlapFlags: boolean[], matchedIndices: (number | null)[]): DivergencePoint[] {
    const points: DivergencePoint[] = [];
    let wasOverlapping = overlapFlags[0];

    for (let i = 1; i < track.length; i++) {
      const isOverlapping = overlapFlags[i];

      if (wasOverlapping && !isOverlapping) {
        points.push({
          coordinate: track[i],
          track1Index: i,
          track2Index: matchedIndices[i - 1],
          type: 'divergence'
        });
      } else if (!wasOverlapping && isOverlapping) {
        points.push({
          coordinate: track[i],
          track1Index: i,
          track2Index: matchedIndices[i],
          type: 'convergence'
        });
      }

      wasOverlapping = isOverlapping;
    }

    return points;
  }

  private calculateElevationComparison(track1Points: TrackPoint[], track2Points: TrackPoint[]): ElevationComparison {
    const hasTrack1Elevation = track1Points.some(p => p.elevationMeters !== undefined);
    const hasTrack2Elevation = track2Points.some(p => p.elevationMeters !== undefined);

    if (!hasTrack1Elevation || !hasTrack2Elevation) {
      return {
        track1: { gainMeters: meters(0), lossMeters: meters(0) },
        track2: { gainMeters: meters(0), lossMeters: meters(0) },
        available: false
      };
    }

    const track1Metrics = TrackMetricsCalculator.calculate(track1Points);
    const track2Metrics = TrackMetricsCalculator.calculate(track2Points);

    return {
      track1: {
        gainMeters: track1Metrics.elevationGain,
        lossMeters: track1Metrics.elevationLoss,
        minMeters: track1Metrics.minElevation,
        maxMeters: track1Metrics.maxElevation
      },
      track2: {
        gainMeters: track2Metrics.elevationGain,
        lossMeters: track2Metrics.elevationLoss,
        minMeters: track2Metrics.minElevation,
        maxMeters: track2Metrics.maxElevation
      },
      available: true
    };
  }

  private findClosestApproach(track1: Coordinate[], track2: Coordinate[]): { distanceMeters: Meters; location: Coordinate } {
    // Only called for tracks with no overlap, where the gap can be arbitrarily large, and a
    // radius-bounded index does not help. Compare simplified tracks directly instead.
    const simplified1 = TrackComparisonUtilities.simplifyForComparison(track1);
    const simplified2 = TrackComparisonUtilities.simplifyForComparison(track2);

    let minDistance = meters(Infinity);
    let closestLocation = simplified1[0];

    for (const coord of simplified1) {
      for (const other of simplified2) {
        const distance = DistanceCalculator.haversineDistanceMeters(coord.latitude, coord.longitude, other.latitude, other.longitude);
        if (distance < minDistance) {
          minDistance = distance;
          closestLocation = coord;
        }
      }
    }

    return { distanceMeters: minDistance, location: closestLocation };
  }
}
