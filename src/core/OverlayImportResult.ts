import type { Waypoint } from 'places-shared/place';
import type { Kilometers, Meters, KilometersPerHour, MinutesPerKilometer } from 'places-shared/units';
import type { TrackDocumentModel } from './gpx/TrackDocumentModel';

export type ImportableOverlayFormat = 'gpx' | 'fit' | 'geojson' | 'csv';

export interface OverlayImportResult {
  distanceKm: Kilometers;
  totalPoints: number;

  startLatitude: number;
  startLongitude: number;

  elevationGainMeters?: Meters;
  elevationLossMeters?: Meters;
  minElevationMeters?: Meters;
  maxElevationMeters?: Meters;

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
  sourceFormat: ImportableOverlayFormat;

  sourceTrackCount?: number;

  parsedDocument?: TrackDocumentModel;
}
