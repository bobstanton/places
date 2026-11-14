import { calculateWindowedSpeeds } from 'places-shared/track';
import { DistanceCalculator, ElevationAccumulator } from 'places-shared/geo';
import { DEFAULT_SPEED_WINDOW, formatMetricWindow, type MetricWindow } from 'places-shared/settings';
import { Kilometers, KilometersPerHour, Meters, km, meters, hours, kph, minPerKm } from 'places-shared/units';
import type { TrackPoint, TrackMetrics } from 'places-shared/geo';

export const MIN_MOVING_SPEED_KPH = 0.5;

export interface RawTrackPoint {
  latitude: number;
  longitude: number;
  elevationMeters?: Meters;
  time?: Date;
  deviceDistanceKm?: Kilometers;
  deviceSpeedKph?: KilometersPerHour;
  heartRateBpm?: number;
  cadenceRpm?: number;
  powerWatts?: number;
  temperatureCelsius?: number;
}

export const TRACK_MEASUREMENT_FIELDS = [
  'deviceDistanceKm', 'deviceSpeedKph', 'heartRateBpm', 'cadenceRpm', 'powerWatts', 'temperatureCelsius',
] as const satisfies readonly (keyof RawTrackPoint)[];

function sensorReadings(point: RawTrackPoint): Pick<TrackPoint, 'heartRateBpm' | 'cadenceRpm' | 'powerWatts' | 'temperatureCelsius'> {
  return {
    heartRateBpm: point.heartRateBpm,
    cadenceRpm: point.cadenceRpm,
    powerWatts: point.powerWatts,
    temperatureCelsius: point.temperatureCelsius,
  };
}

export type { TrackPoint, TrackMetrics, TrackData } from 'places-shared/geo';

let speedWindow: MetricWindow = DEFAULT_SPEED_WINDOW;

export function setSpeedWindow(window: MetricWindow): void {
  speedWindow = window;
}

export function getSpeedWindow(): MetricWindow {
  return speedWindow;
}

export function speedWindowCacheToken(): string {
  return formatMetricWindow(speedWindow);
}

export class TrackPointProcessor {
  static computeSegmentDistances(rawPoints: RawTrackPoint[]): number[] {
    const reported = this.reportedSegmentDistances(rawPoints);

    if (reported) return reported;

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

  private static reportedSegmentDistances(rawPoints: RawTrackPoint[]): number[] | null {
    const distances = new Array<number>(rawPoints.length);

    distances[0] = 0;

    for (let i = 0; i < rawPoints.length; i++) {
      const reported = rawPoints[i].deviceDistanceKm;

      if (reported === undefined) return null;
      if (i === 0) continue;
      const previous = rawPoints[i - 1].deviceDistanceKm;

      if (previous === undefined || reported < previous) return null;
      distances[i] = reported - previous;
    }

    return distances;
  }

  static calculateSpeeds(rawPoints: RawTrackPoint[], precomputedSegmentDistances?: number[], window: MetricWindow = speedWindow): Array<{ speed?: number; pace?: number }> {
    if (rawPoints.length > 0 && rawPoints.every(point => point.deviceSpeedKph !== undefined)) {
      return rawPoints.map(point => {
        const speed = point.deviceSpeedKph as number;

        return speed > 0 ? { speed, pace: 60 / speed } : {};
      });
    }

    if (!rawPoints.some(point => point.time)) {
      return rawPoints.map(() => ({}));
    }

    const segmentDistances = precomputedSegmentDistances ?? this.computeSegmentDistances(rawPoints);

    const times = rawPoints.map(point => point.time?.getTime() ?? NaN);

    return calculateWindowedSpeeds(rawPoints, times, window, segmentDistances)
      .map(speed => speed === undefined ? {} : { speed, pace: 60 / speed });
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
        paceMinPerKm: speedData.pace ? minPerKm(speedData.pace) : undefined,
        ...sensorReadings(point),
      };
    });
  }

  static processSegmentedTrackData(segments: RawTrackPoint[][], window: MetricWindow = speedWindow): { points: TrackPoint[]; metrics: TrackMetrics } {
    const runs = segments.filter(segment => segment.length > 0);

    if (runs.length <= 1) return this.processTrackData(runs[0] ?? [], window);

    const processed = runs.map(run => this.processTrackData(run, window));

    const points: TrackPoint[] = [];
    let traveled = 0;

    for (const run of processed) {
      for (const point of run.points) points.push({ ...point, distanceKm: km(traveled + (point.distanceKm as number)) });
      traveled += run.metrics.distance as number;
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
        points: rawPoints.map(p => ({
          latitude: p.latitude,
          longitude: p.longitude,
          distanceKm: km(0),
          elevationMeters: p.elevationMeters,
          time: p.time,
          ...sensorReadings(p),
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

    const elevation = new ElevationAccumulator();
    let minElevation: number | undefined;
    let maxElevation: number | undefined;

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
        elevation.add(elev);
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
        paceMinPerKm: speedData.pace ? minPerKm(speedData.pace) : undefined,
        ...sensorReadings(point),
      });
    }

    const metrics: TrackMetrics = {
      distance: km(totalDistance),
      elevationGain: meters(elevation.gainM),
      elevationLoss: meters(elevation.lossM),
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