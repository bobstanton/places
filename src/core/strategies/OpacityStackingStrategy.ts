import { Coordinate, Meters, MapPlace, DistanceCalculator, createSegmentOverlayPlace, parseTrackLineStyle, createBoundsAnchors, ColorSchemes, clamp } from "places-shared/worker-safe";
import { IFrequencyStrategy, FrequencyTrackData, FrequencyAnalysisResult, StrategyOptions, FrequencySegment } from "./IFrequencyStrategy";
import { SpatialUtils } from "./SpatialUtils";
import { ProgressReporter } from "./ProgressReporter";
import { CoordinateSimplifier } from "./CoordinateSimplifier";
import { getDeviceOptimalSettings } from "./DeviceSettings";
import { StrategyTimings } from "./StrategyTimings";

export class OpacityStackingStrategy implements IFrequencyStrategy {
  readonly name = "opacity-stacking";
  readonly outputType = "segments" as const;

  analyze(tracks: FrequencyTrackData[], options: StrategyOptions): Promise<FrequencyAnalysisResult> {
    return Promise.resolve(this.analyzeSync(tracks, options));
  }

  private analyzeSync(tracks: FrequencyTrackData[], options: StrategyOptions): FrequencyAnalysisResult {
    const { gridSize = 100 as Meters, maxSegments, onProgress, minOpacity = 0.02, maxOpacity = 1.0 } = options;
    const progress = new ProgressReporter(onProgress);
    const timings = new StrategyTimings();

    if (!tracks.length) {
      return { segments: [], bounds: { minLat: 0, maxLat: 0, minLng: 0, maxLng: 0 } };
    }

    const valid = tracks.filter(t => t.coordinates.length >= 2);

    if (!valid.length) {
      return { segments: [], bounds: { minLat: 0, maxLat: 0, minLng: 0, maxLng: 0 } };
    }

    const deviceSettings = getDeviceOptimalSettings(options.isMobile ?? false);

    progress.report(0);

    progress.reportPhase("Simplifying tracks", 0, 20, 0);
    const simplifiedTracks = timings.measure('simplification', () => this.simplifyTracks(valid, deviceSettings.targetPointsPerTrack, progress));

    progress.reportPhase("Detecting overlap", 20, 50, 0);
    const maxOverlap = timings.measure('overlapDetection', () => this.detectMaximumOverlapWithInterpolation(simplifiedTracks, gridSize as number));

    const opacity = Math.max(minOpacity, maxOpacity / Math.max(1, maxOverlap));

    progress.report(50);

    const lim = simplifiedTracks.slice(0, maxSegments);
    const segments = timings.measure('segmentCreation', () => {
      const segments: FrequencySegment[] = [];

      for (let i = 0; i < lim.length; i++) {
        const t = lim[i];

        if (i % 10 === 0) {
          progress.reportPhase("Creating segments", 50, 100, i / lim.length);
        }

        segments.push({
          coordinates: t.coordinates,  
          frequency: 1,
          normalizedScore: opacity,
          contributingFiles: [t.sourceFile]
        });
      }

      return segments;
    });

    const bounds = timings.measure('boundsCalculation', () => this.boundsFromTracks(lim));

    return { segments, bounds };
  }

  private simplifyTracks(tracks: FrequencyTrackData[], targetPointsPerTrack: number, progress: ProgressReporter): FrequencyTrackData[] {
    return tracks.map((track, i) => {
      if (i % 10 === 0) {
        progress.reportPhase("Simplifying tracks", 0, 20, i / tracks.length);
      }

      return {
        coordinates: CoordinateSimplifier.simplifyToMaxPoints(track.coordinates, targetPointsPerTrack),
        sourceFile: track.sourceFile
      };
    });
  }

  private detectMaximumOverlapWithInterpolation(tracks: FrequencyTrackData[], gridSizeMeters: number): number {
    const cellTracks = new Map<string, Set<number>>();

    const mark = (c: Coordinate, trackIndex: number) => {
      const k = SpatialUtils.getGridKey(c.latitude, c.longitude, gridSizeMeters);

      if (!cellTracks.has(k)) cellTracks.set(k, new Set());
      cellTracks.get(k)!.add(trackIndex);
    };

    for (let ti = 0; ti < tracks.length; ti++) {
      const t = tracks[ti];

      const step = clamp(gridSizeMeters / 2, 25, 100);

      let acc = 0;
      let prev = t.coordinates[0];

      mark(prev, ti);

      for (let i = 1; i < t.coordinates.length; i++) {
        const cur = t.coordinates[i];
        const d = Number(DistanceCalculator.haversineDistanceMeters(prev.latitude, prev.longitude, cur.latitude, cur.longitude));
        let seg = d;
        let a = prev;

        while (acc + seg >= step) {
          const remain = step - acc;
          const frac = remain / seg;
          const lat = a.latitude + (cur.latitude - a.latitude) * frac;
          const lng = a.longitude + (cur.longitude - a.longitude) * frac;
          const s = { latitude: lat, longitude: lng };

          mark(s, ti);
          acc = 0;
          seg -= remain;
          a = s;
        }

        acc += seg;
        prev = cur;
      }

      mark(t.coordinates[t.coordinates.length - 1], ti);
    }

    let max = 1;

    for (const s of cellTracks.values()) {
      max = Math.max(max, s.size);
    }

    return max;
  }

  private boundsFromTracks(tracks: FrequencyTrackData[]): { minLat: number; maxLat: number; minLng: number; maxLng: number } {
    if (tracks.length === 0) {
      return { minLat: 0, maxLat: 0, minLng: 0, maxLng: 0 };
    }

    let minLat = Infinity, maxLat = -Infinity;
    let minLng = Infinity, maxLng = -Infinity;

    for (const t of tracks) {
      for (const coord of t.coordinates) {
        if (coord.latitude < minLat) minLat = coord.latitude;
        if (coord.latitude > maxLat) maxLat = coord.latitude;
        if (coord.longitude < minLng) minLng = coord.longitude;
        if (coord.longitude > maxLng) maxLng = coord.longitude;
      }
    }

    return { minLat, maxLat, minLng, maxLng };
  }

  convertToMapPlaces(result: FrequencyAnalysisResult, colorScheme: string, lineWidth: number = 3, lineStyle?: string, fixedOpacity?: number): MapPlace[] {
    const places: MapPlace[] = [];
    const lineAppearance = parseTrackLineStyle(lineStyle);

    const baseColor = ColorSchemes.getHeatmapCircleColor(colorScheme);
    const useFixed = fixedOpacity !== undefined;

    for (const seg of result.segments) {
      const opacity = useFixed ? fixedOpacity : seg.normalizedScore;

      const segCoords = seg.coordinates;
      const geoJsonCoords = new Array<[number, number]>(segCoords.length);

      for (let j = 0; j < segCoords.length; j++) {
        geoJsonCoords[j] = [segCoords[j].longitude, segCoords[j].latitude];
      }

      places.push(createSegmentOverlayPlace({
        coordinates: geoJsonCoords,
        color: baseColor,
        weight: lineWidth,
        opacity,
        ...lineAppearance,
        metadata: {
          frequency: seg.frequency,
          contributingFiles: seg.contributingFiles || []
        }
      }));
    }

    places.push(...createBoundsAnchors(result.bounds));

    return places;
  }
}
