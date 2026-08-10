import { Coordinate, DistanceCalculator, PlacesBoundingBox, numericRange } from "places-shared/worker-safe";
import { METERS_PER_DEGREE_LAT } from "../../constants/spatial";
import { IFrequencyStrategy, FrequencyTrackData, FrequencyAnalysisResult, StrategyOptions, FrequencySegment } from "./IFrequencyStrategy";
import { SegmentStrategyBase } from "./SegmentStrategyBase";
import { CoordinateSimplifier } from "../CoordinateSimplifier";
import { getDeviceOptimalSettings } from "../DeviceSettings";
import { LoopYieldController } from "./LoopYieldController";
import { StrategyTimings } from "./StrategyTimings";
import { SpatialEdgeGrid } from "../SpatialEdgeGrid";
import { SpatialRadiusGrid } from "../SpatialRadiusGrid";

const logger = {
  debug: (...args: unknown[]) => {
    console.debug('[TrackCorridor]', ...args);
  },
};

interface TrackCorridorStrategyConfig {
  // Max distance from a track point to another track's polyline to count that track as present.
  corridorToleranceM: number;
  // Distance at which a coordinate counts as already covered by previously emitted geometry with an identical contributor set.
  duplicateToleranceM: number;
  // When a corridor is emitted, contributor-track points within this distance of its geometry
  // are consumed - their traversal is now represented on the map. Kept tight (well under
  // corridorToleranceM), keeping a parallel corridor (e.g., a rail trail beside a road, used by
  // the same tracks out-and-back) from being swallowed by the first one drawn.
  consumeToleranceM: number;
  // Presence gaps along a track of up to this many points are bridged (GPS jitter at the tolerance boundary).
  presenceGapClosePoints: number;
  // Isolated presence runs of up to this many points are dropped (corner-cutting blips).
  presenceIslandDropPoints: number;
  // Split a corridor segment when consecutive points are farther apart than this.
  // Generous on purpose: contributors that jump the same recording dropout together are
  // evidence the corridor continues; only teleport-scale jumps should split.
  maxGapM: number;
  // Minimum on-path distance a revisit must span before it counts as an out-and-back leg to collapse.
  selfRevisitMinPathM: number;
  // How far a trimmed run extends back into already-claimed geometry, connecting adjacent lines visually.
  boundaryOverlapM: number;
  // Max fraction of a stretch's points allowed in terminal escape blocks for it to still count as a parallel GPS-scatter sliver.
  parallelSliverMaxEscapeFraction: number;
  minSegmentLengthM: number;
  minSegmentPoints: number;
}

const DEFAULT_TRACK_CORRIDOR_CONFIG: TrackCorridorStrategyConfig = {
  corridorToleranceM: 50,
  // Slightly above corridorToleranceM, leaving sibling-track geometry offset by lateral GPS
  // noise registered as a duplicate instead of surviving as a parallel sliver.
  duplicateToleranceM: 60,
  consumeToleranceM: 30,
  presenceGapClosePoints: 3,
  presenceIslandDropPoints: 1,
  maxGapM: 500,
  selfRevisitMinPathM: 150,
  boundaryOverlapM: 60,
  parallelSliverMaxEscapeFraction: 0.4,
  minSegmentLengthM: 50,
  minSegmentPoints: 3,
};

// A maximal run of consecutive points on one track that share a contributor set.
interface CorridorRun {
  trackIndex: number;
  startIndex: number;
  endIndex: number; // inclusive
  setId: number;
  lengthM: number;
}

// Interns contributor sets: each unique set is stored once, identified by a numeric id.
// Subset relations between interned sets are computed once and cached.
export class ContributorSetRegistry {
  private readonly idsByKey = new Map<string, number>();
  private readonly sets: Array<Set<number>> = [];
  private readonly subsetCache = new Map<string, boolean>();

  intern(trackIndices: number[]): number {
    const key = trackIndices.slice().sort((a, b) => a - b).join(',');
    let id = this.idsByKey.get(key);
    if (id === undefined) {
      id = this.sets.length;
      this.idsByKey.set(key, id);
      this.sets.push(new Set(trackIndices));
    }
    return id;
  }

  get(id: number): Set<number> {
    return this.sets[id];
  }

  size(id: number): number {
    return this.sets[id].size;
  }

  // True when set `innerId` is a subset of (or equal to) set `outerId`.
  isSubset(innerId: number, outerId: number): boolean {
    if (innerId === outerId) return true;
    const cacheKey = `${innerId}|${outerId}`;
    const cached = this.subsetCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const inner = this.sets[innerId];
    const outer = this.sets[outerId];
    let result = inner.size <= outer.size;
    if (result) {
      for (const value of inner) {
        if (!outer.has(value)) {
          result = false;
          break;
        }
      }
    }
    this.subsetCache.set(cacheKey, result);
    return result;
  }
}

// Corridor-based frequency strategy.
//
// Measures shared corridors directly from per-point track data:
//
// 1. Index every track's polyline edges in one spatial grid.
// 2. For each point of each track, find which tracks pass within tolerance using true
//    point-to-line distance (insensitive to differing GPS sample rates), then smooth presence
//    along the track to suppress boundary flapping.
// 3. Split each track where its contributor set changes - frequency boundaries become
//    segment boundaries instead of overlapping segments.
// 4. Emit segments in descending frequency order through a claimed-geometry mask: a point
//    already covered by an emitted segment whose contributors are a superset is trimmed.
//    This guarantees each corridor is drawn exactly once (sibling tracks' duplicates and
//    out-and-back return legs collapse), while genuinely distinct crossing corridors are
//    left intact because their contributor sets are not in a subset relation.
export class TrackCorridorStrategy extends SegmentStrategyBase implements IFrequencyStrategy {
  readonly name = "track-corridor";
  readonly outputType = "segments" as const;

  constructor(private readonly config: TrackCorridorStrategyConfig = DEFAULT_TRACK_CORRIDOR_CONFIG) {
    super();
  }

  protected getStrategyName(): string {
    return this.name;
  }

  protected getDefaultOpacity(): number | undefined {
    return 0.9;
  }

  async analyze(tracks: FrequencyTrackData[], options: StrategyOptions): Promise<FrequencyAnalysisResult> {
    if (tracks.length < 2) {
      return { segments: [], bounds: { minLat: 0, maxLat: 0, minLng: 0, maxLng: 0 } };
    }

    const totalPoints = tracks.reduce((sum, t) => sum + t.coordinates.length, 0);
    const { onProgress, minFrequency, maxSegments } = options;
    const timings = new StrategyTimings();
    const registry = new ContributorSetRegistry();

    onProgress?.("Building spatial index...");
    const edgeGrid = timings.measure('indexBuilding', () => this.buildEdgeGrid(tracks));

    try {
      const pointSetIds = await timings.measureAsync('phase1_contributors', () => this.computeContributorSets(tracks, edgeGrid, registry, onProgress));

      const runs = timings.measure('phase2_segmentation', () => this.splitIntoRuns(tracks, pointSetIds, registry, Math.max(2, minFrequency)));

      const segments = await timings.measureAsync('phase3_claimedTrim', () => this.emitNonOverlappingSegments(runs, tracks, registry, onProgress));

      const { limitedSegments, bounds } = timings.measure('finalization', () => this.finalize(segments, maxSegments, options.isMobile ?? false));

      const total = timings.totalElapsed();
      logger.debug([
        `[Heatmap] Corridor analysis: ${tracks.length} tracks, ${totalPoints.toLocaleString()} points -> ${limitedSegments.length} segments in ${total}ms`,
        `Index ${timings.get('indexBuilding') ?? '-'}ms`,
        `Contributors ${timings.get('phase1_contributors') ?? '-'}ms`,
        `Segmentation ${timings.get('phase2_segmentation') ?? '-'}ms (${runs.length} runs)`,
        `Trim ${timings.get('phase3_claimedTrim') ?? '-'}ms (${segments.length} segments)`,
        `Finalize ${timings.get('finalization') ?? '-'}ms`
      ].join(' | '));

      onProgress?.(`Complete! ${limitedSegments.length} segments`);
      return { segments: limitedSegments, bounds };
    } finally {
      edgeGrid.clear();
    }
  }

  private buildEdgeGrid(tracks: FrequencyTrackData[]): SpatialEdgeGrid {
    const cellSizeDegrees = Math.max(0.0001, this.config.corridorToleranceM / METERS_PER_DEGREE_LAT);
    const grid = new SpatialEdgeGrid(cellSizeDegrees);
    for (let i = 0; i < tracks.length; i++) {
      grid.addPolyline(tracks[i].coordinates, i);
    }
    return grid;
  }

  // For each point of each track, determine which tracks pass within tolerance,
  // smooth presence along the track, and return the interned contributor-set id per point.
  private async computeContributorSets(tracks: FrequencyTrackData[], edgeGrid: SpatialEdgeGrid, registry: ContributorSetRegistry, onProgress?: (message: string) => void): Promise<Int32Array[]> {
    const yieldController = new LoopYieldController({ batchSize: 1, maxIntervalMs: 250 });
    const pointSetIds: Int32Array[] = [];

    for (let trackIndex = 0; trackIndex < tracks.length; trackIndex++) {
      const coords = tracks[trackIndex].coordinates;

      // Sparse presence: for each other track, the point indices where it is nearby.
      const presenceByTrack = new Map<number, number[]>();
      for (let pointIndex = 0; pointIndex < coords.length; pointIndex++) {
        const nearbyTracks = edgeGrid.findTracksNear(coords[pointIndex], this.config.corridorToleranceM);
        for (const otherIndex of nearbyTracks) {
          if (otherIndex === trackIndex) continue;
          let indices = presenceByTrack.get(otherIndex);
          if (!indices) {
            indices = [];
            presenceByTrack.set(otherIndex, indices);
          }
          indices.push(pointIndex);
        }
      }

      // Smooth each other-track's presence, then rebuild per-point contributor lists.
      const contributorsPerPoint: number[][] = Array.from({ length: coords.length }, () => [trackIndex]);
      for (const [otherIndex, indices] of presenceByTrack) {
        for (const pointIndex of this.smoothPresence(indices, coords.length)) {
          contributorsPerPoint[pointIndex].push(otherIndex);
        }
      }

      const setIds = new Int32Array(coords.length);
      for (let pointIndex = 0; pointIndex < coords.length; pointIndex++) {
        setIds[pointIndex] = registry.intern(contributorsPerPoint[pointIndex]);
      }
      pointSetIds.push(setIds);

      onProgress?.(`Analyzing... ${((trackIndex + 1) / tracks.length * 70).toFixed(0)}%`);
      await yieldController.yieldIfNeeded(trackIndex);
    }

    return pointSetIds;
  }

  // Morphological smoothing on a sorted sparse index list:
  // bridges gaps of up to presenceGapClosePoints, then drops runs of up to presenceIslandDropPoints.
  private smoothPresence(sortedIndices: number[], pointCount: number): number[] {
    if (sortedIndices.length === 0) return sortedIndices;

    const closed: number[] = [sortedIndices[0]];
    for (let i = 1; i < sortedIndices.length; i++) {
      const prev = sortedIndices[i - 1];
      const current = sortedIndices[i];
      if (current - prev <= this.config.presenceGapClosePoints + 1) {
        for (let fill = prev + 1; fill <= current; fill++) {
          closed.push(fill);
        }
      } else {
        closed.push(current);
      }
    }

    const result: number[] = [];
    let runStart = 0;
    for (let i = 1; i <= closed.length; i++) {
      const runEnded = i === closed.length || closed[i] !== closed[i - 1] + 1;
      if (!runEnded) continue;
      const runLength = i - runStart;
      const touchesTrackEnd = closed[runStart] === 0 || closed[i - 1] === pointCount - 1;
      if (runLength > this.config.presenceIslandDropPoints || touchesTrackEnd) {
        for (let j = runStart; j < i; j++) {
          result.push(closed[j]);
        }
      }
      runStart = i;
    }
    return result;
  }

  private splitIntoRuns(tracks: FrequencyTrackData[], pointSetIds: Int32Array[], registry: ContributorSetRegistry, minFrequency: number): CorridorRun[] {
    const runs: CorridorRun[] = [];

    for (let trackIndex = 0; trackIndex < tracks.length; trackIndex++) {
      const coords = tracks[trackIndex].coordinates;
      const setIds = pointSetIds[trackIndex];
      const trackRuns: CorridorRun[] = [];
      let runStart = 0;

      for (let i = 1; i <= coords.length; i++) {
        const isGapBreak = i < coords.length
          && DistanceCalculator.haversineDistanceMeters(coords[i - 1].latitude, coords[i - 1].longitude, coords[i].latitude, coords[i].longitude) > this.config.maxGapM;
        const boundary = i === coords.length || isGapBreak || setIds[i] !== setIds[runStart];

        if (!boundary) continue;

        // On a contributor-set change, both runs include the boundary point, and adjacent
        // corridor segments share a junction vertex - otherwise the GPS edge crossing the
        // boundary belongs to neither segment and the rendered corridor has a hole there.
        const endIndex = (i < coords.length && !isGapBreak) ? i : i - 1;
        const setId = setIds[runStart];
        if (registry.size(setId) >= minFrequency) {
          trackRuns.push({
            trackIndex,
            startIndex: runStart,
            endIndex,
            setId,
            lengthM: this.pathLengthM(coords, runStart, endIndex),
          });
        }
        runStart = i;
      }

      runs.push(...this.absorbShortRuns(trackRuns, coords, registry, minFrequency));
    }

    return runs;
  }

  // Funnel zones (e.g., a shared start where tracks peel off one by one) produce a
  // staircase of contributor-set changes whose individual runs are shorter than
  // minSegmentLengthM and would otherwise be dropped, leaving coverage gaps.
  //
  // A too-short run is merged into the adjacent run it shares the most contributors with,
  // using the INTERSECTION of the two sets: every member of the intersection genuinely
  // covers the whole merged extent, and the reported frequency stays truthful (conservative
  // by at most the staircase height across a sub-50m transition).
  private absorbShortRuns(trackRuns: CorridorRun[], coords: Coordinate[], registry: ContributorSetRegistry, minFrequency: number): CorridorRun[] {
    const runs = trackRuns.slice();

    const contiguous = (left: CorridorRun, right: CorridorRun): boolean => {
      // Set-change neighbors share their junction vertex (endIndex === startIndex);
      // gap-break neighbors are index-adjacent and must pass the distance check.
      if (left.endIndex === right.startIndex) return true;
      if (left.endIndex + 1 !== right.startIndex) return false;
      const a = coords[left.endIndex];
      const b = coords[right.startIndex];
      return DistanceCalculator.haversineDistanceMeters(a.latitude, a.longitude, b.latitude, b.longitude) <= this.config.maxGapM;
    };

    const intersectionSize = (setIdA: number, setIdB: number): number => {
      const setA = registry.get(setIdA);
      const setB = registry.get(setIdB);
      const smaller = setA.size <= setB.size ? setA : setB;
      const larger = setA.size <= setB.size ? setB : setA;
      let count = 0;
      for (const value of smaller) {
        if (larger.has(value)) count++;
      }
      return count;
    };

    let changed = true;
    while (changed) {
      changed = false;

      for (let i = 0; i < runs.length; i++) {
        const run = runs[i];

        // Merge adjacent runs whose sets became identical after earlier absorption.
        if (i + 1 < runs.length && runs[i + 1].setId === run.setId && contiguous(run, runs[i + 1])) {
          run.endIndex = runs[i + 1].endIndex;
          run.lengthM = this.pathLengthM(coords, run.startIndex, run.endIndex);
          runs.splice(i + 1, 1);
          changed = true;
          i--;
          continue;
        }

        if (run.lengthM >= this.config.minSegmentLengthM) continue;

        const previous = i > 0 && contiguous(runs[i - 1], run) ? runs[i - 1] : null;
        const next = i + 1 < runs.length && contiguous(run, runs[i + 1]) ? runs[i + 1] : null;
        if (!previous && !next) continue;

        const previousShared = previous ? intersectionSize(run.setId, previous.setId) : -1;
        const nextShared = next ? intersectionSize(run.setId, next.setId) : -1;
        const target = previousShared >= nextShared ? previous! : next!;
        const shared = Math.max(previousShared, nextShared);
        if (shared < minFrequency) continue;

        const intersection: number[] = [];
        for (const value of registry.get(run.setId)) {
          if (registry.get(target.setId).has(value)) intersection.push(value);
        }

        target.setId = registry.intern(intersection);
        target.startIndex = Math.min(target.startIndex, run.startIndex);
        target.endIndex = Math.max(target.endIndex, run.endIndex);
        target.lengthM = this.pathLengthM(coords, target.startIndex, target.endIndex);
        runs.splice(i, 1);
        changed = true;
        i--;
      }
    }

    return runs;
  }

  // Emits runs in descending frequency order through two redundancy filters, then collapses
  // self-revisits (out-and-back legs within one run):
  //
  // - Leg consumption: emitting a corridor consumes the contributor-track points (within
  //   consumeToleranceM of its geometry) whose traversal it now represents. A later run is
  //   trimmed where its own points were consumed. Sibling tracks' duplicates of the same
  //   corridor collapse, while a parallel corridor used by the same tracks on a different
  //   leg (road out, rail trail back) keeps its own line - its points were never consumed.
  //
  // - Identical-set claims: a point within duplicateToleranceM of emitted geometry with the
  //   exact same contributor set is redundant (GPS-offset sliver of the same corridor).
  //
  // Surviving stretches are extended slightly into trimmed geometry, connecting adjacent
  // corridors without gaps.
  private async emitNonOverlappingSegments(runs: CorridorRun[], tracks: FrequencyTrackData[], registry: ContributorSetRegistry, onProgress?: (message: string) => void): Promise<FrequencySegment[]> {
    runs.sort((a, b) => registry.size(b.setId) - registry.size(a.setId) || b.lengthM - a.lengthM);

    const cellSizeDegrees = Math.max(0.0001, this.config.duplicateToleranceM / METERS_PER_DEGREE_LAT);
    const claimedGrid = new SpatialRadiusGrid<{ setId: number }>(cellSizeDegrees);
    const yieldController = new LoopYieldController({ batchSize: 25, maxIntervalMs: 250 });
    const segments: FrequencySegment[] = [];

    const allPointsGrid = new SpatialRadiusGrid<{ trackIndex: number; pointIndex: number }>(cellSizeDegrees);
    const consumed: Uint8Array[] = [];
    for (let i = 0; i < tracks.length; i++) {
      const coords = tracks[i].coordinates;
      consumed.push(new Uint8Array(coords.length));
      for (let j = 0; j < coords.length; j++) {
        allPointsGrid.add(coords[j].latitude, coords[j].longitude, { trackIndex: i, pointIndex: j });
      }
    }

    for (let runIdx = 0; runIdx < runs.length; runIdx++) {
      const run = runs[runIdx];
      const coords = tracks[run.trackIndex].coordinates;
      const pointCount = run.endIndex - run.startIndex + 1;

      // Cumulative path distance within the run, for self-revisit detection.
      const pathM = new Float64Array(pointCount);
      for (let i = 1; i < pointCount; i++) {
        const a = coords[run.startIndex + i - 1];
        const b = coords[run.startIndex + i];
        pathM[i] = pathM[i - 1] + (DistanceCalculator.haversineDistanceMeters(a.latitude, a.longitude, b.latitude, b.longitude) as number);
      }

      const selfGrid = new SpatialRadiusGrid<{ pathM: number }>(cellSizeDegrees);
      const claimDropped = new Uint8Array(pointCount);
      const selfDropped = new Uint8Array(pointCount);
      const nearClaim = new Uint8Array(pointCount);
      const supersetNear = new Uint8Array(pointCount);
      // Probe radius used to classify short surviving stretches: a stretch entirely within
      // this distance of superset claims runs parallel to existing geometry (GPS-offset
      // sliver - drop), while one that also reaches beyond it is a connector at a corridor
      // junction (keep, even when shorter than minSegmentLengthM).
      const connectorProbeRadiusM = this.config.duplicateToleranceM * 1.5;

      for (let i = 0; i < pointCount; i++) {
        const point = coords[run.startIndex + i];

        const revisits = selfGrid.findNearby(point.latitude, point.longitude, this.config.duplicateToleranceM);
        let isRevisit = false;
        for (const entry of revisits) {
          if (pathM[i] - entry.data.pathM > this.config.selfRevisitMinPathM) {
            isRevisit = true;
            break;
          }
        }
        if (isRevisit) {
          selfDropped[i] = 1;
          continue;
        }
        selfGrid.add(point.latitude, point.longitude, { pathM: pathM[i] });

        if (consumed[run.trackIndex][run.startIndex + i]) {
          claimDropped[i] = 1;
        }

        const claims = claimedGrid.findNearby(point.latitude, point.longitude, connectorProbeRadiusM);
        for (const claim of claims) {
          if (!registry.isSubset(run.setId, claim.data.setId)) continue;
          nearClaim[i] = 1;
          if (claim.distance <= this.config.duplicateToleranceM) {
            supersetNear[i] = 1;
            if (claim.data.setId === run.setId) {
              claimDropped[i] = 1;
            }
          }
        }
      }

      const stretches = this.collectSurvivingStretches(claimDropped, selfDropped, nearClaim, supersetNear, pathM);

      for (const stretch of stretches) {
        const segment = this.buildSegment(run, coords, stretch.start, stretch.end, registry, tracks);
        if (!segment) continue;
        segments.push(segment);
        const contributorSet = registry.get(run.setId);
        for (let j = stretch.start; j <= stretch.end; j++) {
          const point = coords[run.startIndex + j];
          claimedGrid.add(point.latitude, point.longitude, { setId: run.setId });
          for (const entry of allPointsGrid.findNearby(point.latitude, point.longitude, this.config.consumeToleranceM)) {
            if (contributorSet.has(entry.data.trackIndex)) {
              consumed[entry.data.trackIndex][entry.data.pointIndex] = 1;
            }
          }
        }
      }

      if (runIdx % 25 === 0) {
        onProgress?.(`Analyzing... ${(70 + (runIdx / runs.length) * 25).toFixed(0)}%`);
      }
      await yieldController.yieldIfNeeded(runIdx);
    }

    return segments;
  }

  // Finds stretches of un-dropped points worth emitting, then extends each one across
  // adjacent claim-dropped points by up to boundaryOverlapM of path distance, letting a
  // lower-frequency continuation visually meet the corridor it abuts instead of stopping
  // a tolerance-width short. Stretches whose extensions meet are merged.
  //
  // Two stretch-level filters apply:
  //
  // - Parallel slivers: sustained lateral GPS scatter (urban canyons, gorges) produces
  //   stretches that hug emitted superset geometry (within duplicateToleranceM), at most
  //   tapering away in a convergence wedge at the ends. Such stretches - every escaping
  //   point in a contiguous block at a stretch end, totalling no more than
  //   parallelSliverMaxEscapeFraction of the points - are dropped whole. A genuinely
  //   distinct parallel path (road beside a rail trail) escapes beyond the tolerance
  //   MID-stretch and is kept whole, preserving line continuity even through sections
  //   that come close to the other corridor.
  //
  // - Length: a stretch shorter than minSegmentLengthM is noise, with one exception: at
  //   corridor junctions, claims from an adjacent higher-frequency segment can shave a
  //   legitimate continuation below the length threshold on EVERY sibling track, leaving
  //   a hole. Such connector stubs touch claimed geometry on one end and reach beyond the
  //   connector probe radius on the other; isolated short specks are still dropped.
  private collectSurvivingStretches(claimDropped: Uint8Array, selfDropped: Uint8Array, nearClaim: Uint8Array, supersetNear: Uint8Array, pathM: Float64Array): Array<{ start: number; end: number }> {
    const pointCount = claimDropped.length;
    const stretches: Array<{ start: number; end: number }> = [];

    let coreStart = -1;
    for (let i = 0; i <= pointCount; i++) {
      const kept = i < pointCount && !claimDropped[i] && !selfDropped[i];
      if (kept && coreStart === -1) {
        coreStart = i;
      } else if (!kept && coreStart !== -1) {
        const corePoints = i - coreStart;
        const coreLengthM = pathM[i - 1] - pathM[coreStart];
        if (corePoints >= this.config.minSegmentPoints) {
          if (coreLengthM >= this.config.minSegmentLengthM) {
            if (!this.isParallelSliver(supersetNear, coreStart, i - 1)) {
              stretches.push({ start: coreStart, end: i - 1 });
            }
          } else {
            let nearCount = 0;
            for (let j = coreStart; j < i; j++) {
              if (nearClaim[j]) nearCount++;
            }
            const isConnectorStub = nearCount > 0 && nearCount < corePoints;
            if (isConnectorStub) {
              stretches.push({ start: coreStart, end: i - 1 });
            }
          }
        }
        coreStart = -1;
      }
    }

    for (const stretch of stretches) {
      // The first adjacent dropped point is always taken even beyond the path cap: at a
      // junction whose shared vertex sits across a long GPS edge, that single point is
      // what makes this segment meet the adjacent corridor instead of leaving a hole.
      let start = stretch.start;
      while (start - 1 >= 0 && claimDropped[start - 1] && !selfDropped[start - 1] && (start === stretch.start || pathM[stretch.start] - pathM[start - 1] <= this.config.boundaryOverlapM)) {
        start--;
      }
      let end = stretch.end;
      while (end + 1 < pointCount && claimDropped[end + 1] && !selfDropped[end + 1] && (end === stretch.end || pathM[end + 1] - pathM[stretch.end] <= this.config.boundaryOverlapM)) {
        end++;
      }
      stretch.start = start;
      stretch.end = end;
    }

    const merged: Array<{ start: number; end: number }> = [];
    for (const stretch of stretches) {
      const previous = merged[merged.length - 1];
      if (previous && stretch.start <= previous.end + 1) {
        previous.end = Math.max(previous.end, stretch.end);
      } else {
        merged.push(stretch);
      }
    }
    return merged;
  }

  // True when every point not hugging superset claims sits in a contiguous escape block at
  // the start or end of the stretch (a convergence wedge), and those blocks total at most
  // parallelSliverMaxEscapeFraction of the points. Any mid-stretch escape means the stretch
  // is a genuinely distinct corridor, not lateral scatter of an already-drawn one.
  private isParallelSliver(supersetNear: Uint8Array, start: number, end: number): boolean {
    let lead = start;
    while (lead <= end && !supersetNear[lead]) lead++;
    if (lead > end) return false; // never hugs the claimed corridor at all

    let trail = end;
    while (trail >= lead && !supersetNear[trail]) trail--;

    for (let j = lead; j <= trail; j++) {
      if (!supersetNear[j]) return false; // escapes mid-stretch
    }

    const escapePoints = (lead - start) + (end - trail);
    return escapePoints <= (end - start + 1) * this.config.parallelSliverMaxEscapeFraction;
  }

  private buildSegment(run: CorridorRun, coords: Coordinate[], stretchStart: number, stretchEnd: number, registry: ContributorSetRegistry, tracks: FrequencyTrackData[]): FrequencySegment | null {
    const contributors = registry.get(run.setId);
    const contributingFiles = Array.from(contributors, idx => tracks[idx].sourceFile).sort();

    return {
      coordinates: coords.slice(run.startIndex + stretchStart, run.startIndex + stretchEnd + 1),
      frequency: contributors.size,
      normalizedScore: 0,
      contributingFiles,
    };
  }

  private finalize(segments: FrequencySegment[], maxSegments: number, isMobile: boolean): { limitedSegments: FrequencySegment[]; bounds: FrequencyAnalysisResult['bounds'] } {
    const deviceSettings = getDeviceOptimalSettings(isMobile);

    segments.sort((a, b) => b.frequency - a.frequency);
    const limitedSegments = segments.slice(0, maxSegments).map(segment => ({
      ...segment,
      coordinates: CoordinateSimplifier.simplifyToMaxPoints(segment.coordinates, Math.min(deviceSettings.targetPointsPerTrack, segment.coordinates.length)),
    }));

    const frequencyRange = numericRange(limitedSegments.map(s => s.frequency));
    if (frequencyRange) {
      const range = frequencyRange.max - frequencyRange.min;
      for (const segment of limitedSegments) {
        segment.normalizedScore = range > 0 ? (segment.frequency - frequencyRange.min) / range : 1.0;
      }
    }

    const segmentBounds = PlacesBoundingBox.fromCoordinates(limitedSegments.flatMap(segment => segment.coordinates));
    const bounds = segmentBounds.isValid() ? segmentBounds : new PlacesBoundingBox(0, 0, 0, 0);
    return { limitedSegments, bounds };
  }

  private pathLengthM(coords: Coordinate[], startIndex: number, endIndex: number): number {
    let length = 0;
    for (let i = startIndex + 1; i <= endIndex; i++) {
      length += DistanceCalculator.haversineDistanceMeters(coords[i - 1].latitude, coords[i - 1].longitude, coords[i].latitude, coords[i].longitude) as number;
    }
    return length;
  }
}
