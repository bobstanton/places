// Safe to bundle into web workers.

// Meters per degree of latitude at the equator (~111.32 km)
export const METERS_PER_DEGREE_LAT = 111320;

// Floor for cos(latitude) when scaling longitude to meters; near the poles the factor otherwise collapses to zero.
export const MIN_COS_LATITUDE = 0.01;
