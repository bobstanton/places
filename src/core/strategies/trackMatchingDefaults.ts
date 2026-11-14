import { type Meters, meters } from "places-shared/worker-safe";

export const DEFAULT_FRECHET_TOLERANCE = 0.01;

export const DEFAULT_OVERLAP_TOLERANCE_METERS: Meters = meters(50);

export const DEFAULT_MIN_SIMILARITY = 0.7;
