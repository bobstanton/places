import { Waypoint } from "places-shared/place";
import type { RawTrackPoint } from "./TrackPointProcessor";

export interface TrackDocumentMetadata {
  name?: string;
  description?: string;
  author?: string;
}

export interface TrackDocumentTrack {
  name?: string;
  description?: string;
  segments: RawTrackPoint[][];
}

export interface TrackDocumentRoute {
  name?: string;
  description?: string;
  points: RawTrackPoint[];
}

export interface TrackDocumentModel {
  metadata: TrackDocumentMetadata;
  tracks: TrackDocumentTrack[];
  routes: TrackDocumentRoute[];
  waypoints: Waypoint[];
}

export function trackDocumentPrimaryPoints(model: TrackDocumentModel): RawTrackPoint[] {
  const trackPoints = model.tracks.flatMap(track => track.segments.flat());

  return trackPoints.length > 0 ? trackPoints : model.routes.flatMap(route => route.points);
}
