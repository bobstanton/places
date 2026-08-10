import { DistanceCalculator } from 'places-shared/geo';
import { DEFAULT_SPEED_WINDOW, formatMetricWindow, type MetricWindow } from 'places-shared/settings';
import {
  Meters,
  km, meters, hours, kph, minPerKm
} from 'places-shared/units';
import type { TrackPoint, TrackMetrics } from 'places-shared/geo';

const MIN_MOVING_SPEED_KPH = 0.5;

export interface RawTrackPoint {
  latitude: number;
  longitude: number;
  elevationMeters?: Meters;
  time?: Date;
}

export type { TrackPoint, TrackMetrics, TrackData } from 'places-shared/geo';

// Speed smoothing span, configured from plugin settings rather than threaded
// through GpxParser.parse -> createTrackPoints -> calculateSpeeds and every
// caller. Matches the setOverlayCompressionLevel / configureRequestLogging
// pattern used elsewhere for settings the parse layer needs.
let speedWindow: MetricWindow = DEFAULT_SPEED_WINDOW;

export function setSpeedWindow(window: MetricWindow): void {
  speedWindow = window;
}

export function getSpeedWindow(): MetricWindow {
  return speedWindow;
}

// Token identifying the active window, for cache keys. Parsed tracks carry
// their speeds, and two windows must never share a memo entry.
export function speedWindowCacheToken(): string {
  return formatMetricWindow(speedWindow);
}

export class TrackPointProcessor {

  // Per-segment haversine distances (index i = distance from point i-1 to i, index 0 = 0).
  static computeSegmentDistances(rawPoints: RawTrackPoint[]): number[] {
    const segmentDistances = new Array<number>(rawPoints.length);
    segmentDistances[0] = 0;
    for (let i = 1; i < rawPoints.length; i++) {
      segmentDistances[i] = DistanceCalculator.haversineDistance(
        rawPoints[i - 1].latitude, rawPoints[i - 1].longitude,
        rawPoints[i].latitude, rawPoints[i].longitude
      );
    }
    return segmentDistances;
  }

  // Per-point speed and pace, averaged over a window centred on each point.
  //
  // A distance window keeps the same spatial context at every speed, and one
  // setting suits walking and driving alike. A time window keeps the same
  // temporal context instead, which reads better across stops - a distance
  // window spans the whole pause and reports the average as if it were motion.
  //
  // @param window Defaults to the configured setting; passed explicitly by tests.
  static calculateSpeeds(rawPoints: RawTrackPoint[], precomputedSegmentDistances?: number[], window: MetricWindow = speedWindow): Array<{ speed?: number; pace?: number }> {
    const results: Array<{ speed?: number; pace?: number }> = [];

    // Speeds need timestamps; skip the window passes entirely when there are
    // none (e.g. coordinates parsed from cached GeoJSON).
    if (!rawPoints.some(point => point.time)) {
      return rawPoints.map(() => ({}));
    }

    const segmentDistances = precomputedSegmentDistances ?? this.computeSegmentDistances(rawPoints);

    // Both window kinds expand the same centred span; only the test that decides
    // "far enough" differs, and the sliding-window bookkeeping is shared.
    const outsideWindow = window.kind === 'time'
      ? (a: RawTrackPoint, b: RawTrackPoint): boolean => {
        const timeA = a.time?.getTime();
        const timeB = b.time?.getTime();
        // A point with no timestamp cannot be placed in a time window; stop
        // expanding rather than swallowing the whole track.
        return timeA === undefined || timeB === undefined || Math.abs(timeB - timeA) > window.ms;
      }
      : (a: RawTrackPoint, b: RawTrackPoint): boolean =>
        DistanceCalculator.haversineDistance(a.latitude, a.longitude, b.latitude, b.longitude) > window.km;

    let start = 0;
    let end = 0;
    let accumulatedDistance = 0;

    for (let i = 0; i < rawPoints.length; i++) {
      const currentPoint = rawPoints[i];

      while (start + 1 < i && outsideWindow(rawPoints[start], currentPoint)) {
        accumulatedDistance -= segmentDistances[start + 1];
        start++;
      }

      while (end < rawPoints.length && !outsideWindow(currentPoint, rawPoints[end])) {
        if (end > 0) {
          accumulatedDistance += segmentDistances[end];
        }
        end++;
      }

      const startTime = rawPoints[start].time;
      const endTime = rawPoints[end - 1]?.time;
      if (startTime && endTime && accumulatedDistance > 0) {
        const timeDiffMs = endTime.getTime() - startTime.getTime();
        if (timeDiffMs > 0) {
          const timeDiffHours = timeDiffMs / (1000 * 60 * 60);
          const speed = accumulatedDistance / timeDiffHours;

          if (speed > 0 && speed <= 200) {
            const pace = 60 / speed;
            results.push({ speed, pace });
          } else {
            results.push({});
          }
        } else {
          results.push({});
        }
      } else {
        results.push({});
      }
    }

    return results;
  }

  static createTrackPoints(rawPoints: RawTrackPoint[], window: MetricWindow = speedWindow): TrackPoint[] {
    let cumulativeDistance = km(0);

    const segmentDistances = this.computeSegmentDistances(rawPoints);
    const speeds = this.calculateSpeeds(rawPoints, segmentDistances, window);

    return rawPoints.map((point, index) => {
      if (index > 0) {
        cumulativeDistance = km(cumulativeDistance + segmentDistances[index]);
      }

      const speedData = speeds[index];

      return {
        latitude: point.latitude,
        longitude: point.longitude,
        distanceKm: cumulativeDistance,
        elevationMeters: point.elevationMeters,
        time: point.time,
        speedKph: speedData.speed ? kph(speedData.speed) : undefined,
        paceMinPerKm: speedData.pace ? minPerKm(speedData.pace) : undefined
      };
    });
  }

  // Metrics for geometry made of several disconnected runs: GPX track segments,
  // separate tracks in one file, or GeoJSON line features. Each run is measured
  // on its own and the results are added: the straight-line jump from the end of
  // one run to the start of the next is never counted as travel.
  //
  // Measuring the flattened point list instead reported a 95-mile rail trail
  // stored as 20 disconnected pieces as 657 miles - 562 of them phantom, one
  // jump alone being 77 miles.
  static processSegmentedTrackData(
    segments: RawTrackPoint[][],
    window: MetricWindow = speedWindow,
  ): { points: TrackPoint[]; metrics: TrackMetrics } {
    const runs = segments.filter(segment => segment.length > 0);
    if (runs.length <= 1) return this.processTrackData(runs[0] ?? [], window);

    const processed = runs.map(run => this.processTrackData(run, window));

    // Cumulative point distance has to keep climbing across runs, or an
    // elevation profile would restart at zero for every piece.
    const points: TrackPoint[] = [];
    let travelled = 0;
    for (const run of processed) {
      for (const point of run.points) points.push({ ...point, distanceKm: km(travelled + (point.distanceKm as number)) });
      travelled += run.metrics.distance as number;
    }

    const total = (pick: (metrics: TrackMetrics) => number | undefined): number =>
      processed.reduce((sum, run) => sum + (pick(run.metrics) ?? 0), 0);
    const extreme = (pick: (metrics: TrackMetrics) => number | undefined, isBetter: (value: number, best: number) => boolean): number | undefined => {
      let best: number | undefined;
      for (const run of processed) {
        const value = pick(run.metrics);
        if (value !== undefined && (best === undefined || isBetter(value, best))) best = value;
      }
      return best;
    };

    const distance = total(metrics => metrics.distance);
    const durationHours = total(metrics => metrics.duration);
    const movingHours = total(metrics => metrics.movingTime);
    const stoppedHours = total(metrics => metrics.stoppedTime);
    const minElevation = extreme(metrics => metrics.minElevation, (value, best) => value < best);
    const maxElevation = extreme(metrics => metrics.maxElevation, (value, best) => value > best);
    const maxSpeed = extreme(metrics => metrics.maxSpeed, (value, best) => value > best);
    const bestPace = extreme(metrics => metrics.bestPace, (value, best) => value < best);

    const metrics: TrackMetrics = {
      distance: km(distance),
      elevationGain: meters(total(run => run.elevationGain)),
      elevationLoss: meters(total(run => run.elevationLoss)),
      minElevation: minElevation !== undefined ? meters(minElevation) : undefined,
      maxElevation: maxElevation !== undefined ? meters(maxElevation) : undefined,
      maxSpeed: maxSpeed !== undefined ? kph(maxSpeed) : undefined,
      bestPace: bestPace !== undefined ? minPerKm(bestPace) : undefined,
    };

    if (durationHours > 0) {
      metrics.duration = hours(durationHours);
      const effectiveHours = movingHours > 0 ? movingHours : durationHours;
      if (effectiveHours > 0 && distance > 0) {
        metrics.averageSpeed = kph(distance / effectiveHours);
        metrics.averagePace = minPerKm((effectiveHours * 60) / distance);
      }
      if (movingHours > 0) metrics.movingTime = hours(movingHours);
      if (stoppedHours > 0) metrics.stoppedTime = hours(stoppedHours);
    }

    return { points, metrics };
  }

  static processTrackData(rawPoints: RawTrackPoint[], window: MetricWindow = speedWindow): { points: TrackPoint[]; metrics: TrackMetrics } {
    if (rawPoints.length < 2) {
      return {
        points: rawPoints.map((p, _i) => ({
          latitude: p.latitude,
          longitude: p.longitude,
          distanceKm: km(0),
          elevationMeters: p.elevationMeters,
          time: p.time
        })),
        metrics: {
          distance: km(0),
          elevationGain: meters(0),
          elevationLoss: meters(0)
        }
      };
    }

    const segmentDistances = this.computeSegmentDistances(rawPoints);
    const speeds = this.calculateSpeeds(rawPoints, segmentDistances, window);

    const points: TrackPoint[] = [];
    let cumulativeDistance = 0;
    let totalDistance = 0;

    let elevationGain = 0;
    let elevationLoss = 0;
    let minElevation: number | undefined;
    let maxElevation: number | undefined;
    let lastElevation: number | undefined;

    let totalTimeMs = 0;
    let movingTimeMs = 0;
    let stoppedTimeMs = 0;

    let maxSpeedValue: number | undefined;
    let bestPaceValue: number | undefined;

    for (let i = 0; i < rawPoints.length; i++) {
      const point = rawPoints[i];
      const speedData = speeds[i];

      if (i > 0) {
        const prev = rawPoints[i - 1];
        const segmentDistance = segmentDistances[i];
        cumulativeDistance += segmentDistance;
        totalDistance += segmentDistance;

        if (prev.time && point.time) {
          const timeDiffMs = point.time.getTime() - prev.time.getTime();
          if (timeDiffMs > 0) {
            totalTimeMs += timeDiffMs;
            const segmentSpeedKph = segmentDistance / (timeDiffMs / 3600000);
            if (segmentSpeedKph >= MIN_MOVING_SPEED_KPH) {
              movingTimeMs += timeDiffMs;
            } else {
              stoppedTimeMs += timeDiffMs;
            }
          }
        }
      }

      if (point.elevationMeters !== undefined) {
        const elev = point.elevationMeters as number;
        if (minElevation === undefined || elev < minElevation) minElevation = elev;
        if (maxElevation === undefined || elev > maxElevation) maxElevation = elev;

        if (lastElevation !== undefined) {
          const delta = elev - lastElevation;
          if (delta > 0) elevationGain += delta;
          if (delta < 0) elevationLoss -= delta;
        }
        lastElevation = elev;
      }

      if (speedData.speed !== undefined) {
        if (maxSpeedValue === undefined || speedData.speed > maxSpeedValue) {
          maxSpeedValue = speedData.speed;
        }
      }
      if (speedData.pace !== undefined) {
        if (bestPaceValue === undefined || speedData.pace < bestPaceValue) {
          bestPaceValue = speedData.pace;
        }
      }

      points.push({
        latitude: point.latitude,
        longitude: point.longitude,
        distanceKm: km(cumulativeDistance),
        elevationMeters: point.elevationMeters,
        time: point.time,
        speedKph: speedData.speed ? kph(speedData.speed) : undefined,
        paceMinPerKm: speedData.pace ? minPerKm(speedData.pace) : undefined
      });
    }

    const metrics: TrackMetrics = {
      distance: km(totalDistance),
      elevationGain: meters(elevationGain),
      elevationLoss: meters(elevationLoss),
      minElevation: minElevation !== undefined ? meters(minElevation) : undefined,
      maxElevation: maxElevation !== undefined ? meters(maxElevation) : undefined,
      maxSpeed: maxSpeedValue !== undefined ? kph(maxSpeedValue) : undefined,
      bestPace: bestPaceValue !== undefined ? minPerKm(bestPaceValue) : undefined
    };

    if (totalTimeMs > 0) {
      metrics.duration = hours(totalTimeMs / 3600000);

      const effectiveTimeHours = movingTimeMs > 0 ? movingTimeMs / 3600000 : totalTimeMs / 3600000;
      if (effectiveTimeHours > 0 && totalDistance > 0) {
        metrics.averageSpeed = kph(totalDistance / effectiveTimeHours);
        metrics.averagePace = minPerKm((effectiveTimeHours * 60) / totalDistance);
      }

      if (movingTimeMs > 0) {
        metrics.movingTime = hours(movingTimeMs / 3600000);
      }
      if (stoppedTimeMs > 0) {
        metrics.stoppedTime = hours(stoppedTimeMs / 3600000);
      }
    }

    return { points, metrics };
  }
}