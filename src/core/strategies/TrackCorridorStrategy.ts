import { Coordinate, DistanceCalculator, PlacesBoundingBox, numericRange } from "places-shared/worker-safe";
import { METERS_PER_DEGREE_LAT } from "./spatial";
import { IFrequencyStrategy, FrequencyTrackData, FrequencyAnalysisResult, StrategyOptions, FrequencySegment } from "./IFrequencyStrategy";
import { SegmentStrategyBase } from "./SegmentStrategyBase";
import { CoordinateSimplifier } from "./CoordinateSimplifier";
import { getDeviceOptimalSettings } from "./DeviceSettings";
import { LoopYieldController } from "./LoopYieldController";
import { StrategyTimings } from "./StrategyTimings";
import { SpatialEdgeGrid } from "./SpatialEdgeGrid";
import { SpatialRadiusGrid } from "./SpatialRadiusGrid";

const logger = {
  debug: (...args: unknown[]) => {
    console.debug('[TrackCorridor]', ...args);
  },
};

interface TrackCorridorStrategyConfig {
  corridorToleranceM: number;
  duplicateToleranceM: number;
  consumeToleranceM: number;
  presenceGapClosePoints: number;
  presenceIslandDropPoints: number;
  maxGapM: number;
  selfRevisitMinPathM: number;
  boundaryOverlapM: number;
  parallelSliverMaxEscapeFraction: number;
  minSegmentLengthM: number;
  minSegmentPoints: number;
}

const DEFAULT_TRACK_CORRIDOR_CONFIG: TrackCorridorStrategyConfig = {
  corridorToleranceM: 50,
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

interface CorridorRun {
  trackIndex: number;
  startIndex: number;
  endIndex: number;  
  setId: number;
  lengthM: number;
}

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

  private async computeContributorSets(tracks: FrequencyTrackData[], edgeGrid: SpatialEdgeGrid, registry: ContributorSetRegistry, onProgress?: (message: string) => void): Promise<Int32Array[]> {
    const yieldController = new LoopYieldController({ batchSize: 1, maxIntervalMs: 250 });
    const pointSetIds: Int32Array[] = [];

    for (let trackIndex = 0; trackIndex < tracks.length; trackIndex++) {
      const coords = tracks[trackIndex].coordinates;

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

  private absorbShortRuns(trackRuns: CorridorRun[], coords: Coordinate[], registry: ContributorSetRegistry, minFrequency: number): CorridorRun[] {
    const runs = trackRuns.slice();

    const contiguous = (left: CorridorRun, right: CorridorRun): boolean => {
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

  private isParallelSliver(supersetNear: Uint8Array, start: number, end: number): boolean {
    let lead = start;

    while (lead <= end && !supersetNear[lead]) lead++;
    if (lead > end) return false;  

    let trail = end;

    while (trail >= lead && !supersetNear[trail]) trail--;

    for (let j = lead; j <= trail; j++) {
      if (!supersetNear[j]) return false;  
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
