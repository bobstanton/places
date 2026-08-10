import { Waypoint } from "places-shared/place";
import { Kilometers, Meters, KilometersPerHour, MinutesPerKilometer } from "places-shared/units";

export type OverlaySourceFormat = 'gpx' | 'geojson' | 'csv';

// Metrics for frontmatter plus the original content for Overlay Source; no point arrays (TrackData carries those).
export interface OverlayImportResult {
  distanceKm: Kilometers;
  totalPoints: number;

  startLatitude: number;
  startLongitude: number;

  elevationGainMeters?: Meters;
  elevationLossMeters?: Meters;
  minElevationMeters?: Meters;
  maxElevationMeters?: Meters;

  // Populated only for GPX with timestamps.
  durationSeconds?: number;
  averageSpeedKph?: KilometersPerHour;
  maxSpeedKph?: KilometersPerHour;
  averagePaceMinPerKm?: MinutesPerKilometer;
  startTime?: Date;
  endTime?: Date;

  name?: string;
  description?: string;
  waypoints?: Waypoint[];

  originalContent: string;
  sourceFormat: OverlaySourceFormat;

  // Source tracks or features merged into the import.
  sourceTrackCount?: number;
}
