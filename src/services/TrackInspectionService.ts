import type { MapPlace } from "places-shared/place";
import type { TrackInspection } from "places-shared/settings";
import { formatKmInSystem, formatKphInSystem, formatMetersInSystem, formatMinPerKmInSystem, km, kph, meters, minPerKm } from "places-shared/units";
import type { IPlacesPluginSettings, MetricWindow } from "places-shared/settings";
import type { TrackData, TrackPoint } from "./TrackPointProcessor";
import { TrackDataService } from "./TrackDataService";

interface Projection { point: TrackPoint; next?: TrackPoint; t: number; distanceMeters: number; }

export class TrackInspectionService {
  private readonly loadedTracks = new Map<string, Promise<TrackData>>();
  // `speedWindow` is the block's own setting; the popup's Speed and Pace are
  // computed by this load, and a block that narrows the window must not read a
  // track parsed with the global one.
  constructor(private tracks: TrackDataService, private settings: () => IPlacesPluginSettings, private speedWindow?: MetricWindow) {}

  async inspect(place: MapPlace, coordinate: { latitude: number; longitude: number }, sourcePath: string): Promise<TrackInspection | null> {
    if (!place.filePath) return null;
    let data: TrackData;
    try {
      let pending = this.loadedTracks.get(place.filePath);
      if (!pending) {
        pending = this.tracks.loadTrackFromPath(place.filePath, sourcePath, { skipCache: true, speedWindow: this.speedWindow });
        this.loadedTracks.set(place.filePath, pending);
      }
      data = await pending;
    } catch {
      this.loadedTracks.delete(place.filePath);
      return null;
    }
    return inspectTrackData(data, coordinate, this.settings());
  }
}

export function inspectTrackData(data: TrackData, coordinate: { latitude: number; longitude: number }, settings: IPlacesPluginSettings): TrackInspection | null {
  const projection = nearestProjection(data, coordinate);
  return projection ? { fields: formatFields(data, projection, settings) } : null;
}

function nearestProjection(data: TrackData, target: { latitude: number; longitude: number }): Projection | null {
  const paths = data.segments?.length ? data.segments : [data.points];
  let best: Projection | null = null;
  for (const points of paths) {
    if (points.length === 1) {
      const distanceMeters = planarDistance(points[0], target, target.latitude);
      if (!best || distanceMeters < best.distanceMeters) best = { point: points[0], t: 0, distanceMeters };
    }
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i], b = points[i + 1];
      const latitude = target.latitude * Math.PI / 180;
      const scaleX = 111_320 * Math.cos(latitude), scaleY = 110_540;
      const ax = (a.longitude - target.longitude) * scaleX, ay = (a.latitude - target.latitude) * scaleY;
      const bx = (b.longitude - target.longitude) * scaleX, by = (b.latitude - target.latitude) * scaleY;
      const dx = bx - ax, dy = by - ay;
      const t = dx === 0 && dy === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy)));
      const distanceMeters = Math.hypot(ax + t * dx, ay + t * dy);
      if (!best || distanceMeters < best.distanceMeters) best = { point: a, next: b, t, distanceMeters };
    }
  }
  return best;
}

function planarDistance(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }, latitude: number): number {
  return Math.hypot((a.longitude - b.longitude) * 111_320 * Math.cos(latitude * Math.PI / 180), (a.latitude - b.latitude) * 110_540);
}

function interpolate(a: number | undefined, b: number | undefined, t: number): number | undefined {
  if (a === undefined || b === undefined) return t === 0 ? a : t === 1 ? b : undefined;
  return a + (b - a) * t;
}

function formatFields(data: TrackData, hit: Projection, settings: IPlacesPluginSettings): TrackInspection['fields'] {
  const next = hit.next;
  const latitude = interpolate(hit.point.latitude, next?.latitude, hit.t) ?? hit.point.latitude;
  const longitude = interpolate(hit.point.longitude, next?.longitude, hit.t) ?? hit.point.longitude;
  const distance = interpolate(hit.point.distanceKm, next?.distanceKm, hit.t);
  const elevation = interpolate(hit.point.elevationMeters, next?.elevationMeters, hit.t);
  const timeMs = interpolate(hit.point.time?.getTime(), next?.time?.getTime(), hit.t);
  const speed = interpolate(hit.point.speedKph, next?.speedKph, hit.t);
  const fields: Array<{ label: string; value: string }> = [];
  if (timeMs !== undefined) {
    const time = new Date(timeMs);
    fields.push({ label: "Time", value: time.toLocaleString() });
    const start = data.points.find(point => point.time)?.time;
    if (start) fields.push({ label: "Elapsed", value: formatDuration(Math.max(0, timeMs - start.getTime())) });
    const timedWaypoints = data.waypoints.filter(waypoint => waypoint.time).sort((a, b) => a.time!.getTime() - b.time!.getTime());
    const previous = [...timedWaypoints].reverse().find(waypoint => waypoint.time!.getTime() <= timeMs);
    const nextWaypoint = timedWaypoints.find(waypoint => waypoint.time!.getTime() > timeMs);
    if (previous) fields.push({ label: "Previous stop", value: previous.name });
    if (nextWaypoint) fields.push({ label: "Next stop", value: nextWaypoint.name });
  }
  if (distance !== undefined) fields.push({ label: "Distance from start", value: formatKmInSystem(km(distance), settings.units) });
  if (speed !== undefined && speed >= 0) {
    fields.push({ label: "Speed", value: formatKphInSystem(kph(speed), settings.units) });
    if (speed > 0) fields.push({ label: "Pace", value: formatMinPerKmInSystem(minPerKm(60 / speed), settings.units) });
  }
  if (elevation !== undefined) fields.push({ label: "Elevation", value: formatMetersInSystem(meters(elevation), settings.units) });
  fields.push({ label: "Coordinates", value: `${latitude.toFixed(6)}, ${longitude.toFixed(6)}` });
  return fields;
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.round(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
