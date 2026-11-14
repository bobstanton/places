import type { TrackData, TrackPoint } from 'places-shared/geo';
import { km, kph, meters, minPerKm } from 'places-shared/units';
import { sleep } from 'places-shared/utils';

const keys = ['latitude', 'longitude', 'distanceKm', 'elevationMeters', 'speedKph', 'paceMinPerKm', 'heartRateBpm', 'cadenceRpm', 'powerWatts', 'temperatureCelsius'] as const satisfies readonly (keyof TrackPoint)[];
const stride = keys.length + 1;

export interface PackedTrackData {
  values: Float64Array<ArrayBuffer>;
  present: Uint16Array<ArrayBuffer>;
  lengths: number[];
  metrics: TrackData['metrics'];
  waypoints: TrackData['waypoints'];
  metadata: TrackData['metadata'];
  hasSegments: boolean;
}

export function packTrackData(track: TrackData): PackedTrackData {
  const paths = [track.points, ...track.segments ?? []];
  const count = paths.reduce((n, points) => n + points.length, 0);
  const values = new Float64Array(count * stride);
  const present = new Uint16Array(count);
  let index = 0;

  for (const points of paths) for (const point of points) {
    for (let field = 0; field < keys.length; field++) {
      const value = point[keys[field]];

      if (value === undefined) continue;
      values[index * stride + field] = value;
      present[index] |= 1 << field;
    }

    if (point.time !== undefined) {
      values[index * stride + keys.length] = point.time.getTime();
      present[index] |= 1 << keys.length;
    }

    index++;
  }

  return { values, present, lengths: paths.map(points => points.length), hasSegments: track.segments !== undefined,
    metrics: track.metrics, waypoints: track.waypoints, metadata: track.metadata };
}

export async function unpackTrackData(packed: PackedTrackData, signal: AbortSignal): Promise<TrackData> {
  const paths: TrackPoint[][] = [];
  let index = 0;
  let deadline = performance.now() + 4;

  for (const length of packed.lengths) {
    const points: TrackPoint[] = [];

    paths.push(points);

    for (let i = 0; i < length; i++, index++) {
      if ((index & 255) === 0) {
        signal.throwIfAborted();

        if (performance.now() >= deadline) {
          await sleep(0);
          signal.throwIfAborted();
          deadline = performance.now() + 4;
        }
      }

      const offset = index * stride;
      const mask = packed.present[index];
      const values = packed.values;

      points.push({
        latitude: values[offset], longitude: values[offset + 1], distanceKm: km(values[offset + 2]),
        elevationMeters: mask & 8 ? meters(values[offset + 3]) : undefined,
        speedKph: mask & 16 ? kph(values[offset + 4]) : undefined,
        paceMinPerKm: mask & 32 ? minPerKm(values[offset + 5]) : undefined,
        heartRateBpm: mask & 64 ? values[offset + 6] : undefined,
        cadenceRpm: mask & 128 ? values[offset + 7] : undefined,
        powerWatts: mask & 256 ? values[offset + 8] : undefined,
        temperatureCelsius: mask & 512 ? values[offset + 9] : undefined,
        time: mask & 1024 ? new Date(values[offset + 10]) : undefined,
      });
    }
  }

  signal.throwIfAborted();

  return { points: paths[0], segments: packed.hasSegments ? paths.slice(1) : undefined,
    metrics: packed.metrics, waypoints: packed.waypoints, metadata: packed.metadata };
}
