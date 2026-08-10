import { type TrackMetrics } from "places-shared/geo";
import { type Meters } from "places-shared/units";
import { TrackPointProcessor } from "./TrackPointProcessor";

interface PointWithElevationAndTime {
  latitude: number;
  longitude: number;
  elevationMeters?: Meters;
  time?: Date;
}

// Track metrics for callers that hold points but not a parsed `TrackData`.
//
// `TrackPointProcessor` is the only metrics engine; Max Speed and Best Pace
// mean the smoothed-window readings defined under "Speed Calculation Method"
// in CLAUDE.md, never raw adjacent-point speeds.
export class TrackMetricsCalculator {
  static calculate(points: PointWithElevationAndTime[]): TrackMetrics {
    return TrackPointProcessor.processTrackData(points).metrics;
  }
}
