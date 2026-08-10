import type * as GeoJson from "geojson";
import type { Waypoint } from "places-shared/place";

export interface GpxWaypointFeatureOptions {
  includeElevationCoordinate?: boolean;
  markerSymbol?: string;
}

export function gpxWaypointToFeature(
  waypoint: Waypoint,
  options: GpxWaypointFeatureOptions = {},
): GeoJson.Feature<GeoJson.Point> {
  const coordinates = options.includeElevationCoordinate && waypoint.elevation !== undefined
    ? [waypoint.lon, waypoint.lat, waypoint.elevation]
    : [waypoint.lon, waypoint.lat];

  return {
    type: "Feature",
    properties: {
      name: waypoint.name,
      description: waypoint.description,
      symbol: waypoint.iconUrl ?? waypoint.symbol,
      type: waypoint.type,
      elevation: waypoint.elevation,
      time: waypoint.time?.toISOString(),
      comment: waypoint.comment,
      link: waypoint.link,
      ...(options.markerSymbol ? { "marker-symbol": options.markerSymbol } : {}),
      _placesGpxWaypoint: true,
    },
    geometry: { type: "Point", coordinates },
  };
}
