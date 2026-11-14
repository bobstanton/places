import { type TrackMetrics } from "places-shared/geo";
import { type Meters } from "places-shared/units";
import { TrackPointProcessor } from "./TrackPointProcessor";

interface PointWithElevationAndTime {
  latitude: number;
  longitude: number;
  elevationMeters?: Meters;
  time?: Date;
}

export class TrackMetricsCalculator {
  static calculate(points: PointWithElevationAndTime[]): TrackMetrics {
    return TrackPointProcessor.processTrackData(points).metrics;
  }
}
