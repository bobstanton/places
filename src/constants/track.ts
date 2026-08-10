import { type Meters, meters } from "places-shared/units";

export const DEFAULT_FRECHET_TOLERANCE = 0.01;


// Points within this distance count as overlapping.
export const DEFAULT_OVERLAP_TOLERANCE_METERS: Meters = meters(50);


// Frechet similarity, 0-1.
export const DEFAULT_MIN_SIMILARITY = 0.7;
