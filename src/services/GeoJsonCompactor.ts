import type * as GeoJSON from 'geojson';
import type { Meters } from 'places-shared/units';
import { roundTo } from 'places-shared/utils';

// Lossy storage compaction: 6 decimals = ~11cm coordinate accuracy.
const COORDINATE_PRECISION = 6;
// 1 decimal = 0.1m elevation accuracy.
const ELEVATION_PRECISION = 1;

function compactCoordinate(coord: number[]): number[] {
  const result: number[] = [
    roundTo(coord[0], COORDINATE_PRECISION), // longitude
    roundTo(coord[1], COORDINATE_PRECISION)  // latitude
  ];

  if (coord.length > 2 && typeof coord[2] === 'number') {
    result.push(roundTo(coord[2], ELEVATION_PRECISION));
  }

  return result;
}

function compactCoordinates(geometry: GeoJSON.Geometry): GeoJSON.Geometry {
  switch (geometry.type) {
    case 'Point':
      return {
        type: 'Point',
        coordinates: compactCoordinate(geometry.coordinates)
      };

    case 'LineString':
      return {
        type: 'LineString',
        coordinates: geometry.coordinates.map(compactCoordinate)
      };

    case 'MultiLineString':
      return {
        type: 'MultiLineString',
        coordinates: geometry.coordinates.map(line => line.map(compactCoordinate))
      };

    case 'Polygon':
      return {
        type: 'Polygon',
        coordinates: geometry.coordinates.map(ring => ring.map(compactCoordinate))
      };

    case 'MultiPolygon':
      return {
        type: 'MultiPolygon',
        coordinates: geometry.coordinates.map(polygon =>
          polygon.map(ring => ring.map(compactCoordinate))
        )
      };

    case 'MultiPoint':
      return {
        type: 'MultiPoint',
        coordinates: geometry.coordinates.map(compactCoordinate)
      };

    case 'GeometryCollection':
      return {
        type: 'GeometryCollection',
        geometries: geometry.geometries.map(compactCoordinates)
      };

    default:
      return geometry;
  }
}

const DISPLAY_PROPERTIES = new Set([
  'name',
  'description',
  'symbol',
  'icon',
  // Not a display property, but the only carrier for per-point timestamps:
  // GeoJSON has no slot for time on a coordinate, and speed and pace colouring
  // read it from here.
  'coordTimes'
]);

function retainDisplayProperties(properties: GeoJSON.GeoJsonProperties): GeoJSON.GeoJsonProperties {
  if (!properties) return {};

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(properties)) {
    if (value === null || value === undefined) continue;

    if (DISPLAY_PROPERTIES.has(key)) {
      result[key] = value;
    }
  }

  return result;
}

function compactFeature(feature: GeoJSON.Feature): GeoJSON.Feature {
  return {
    type: 'Feature',
    properties: retainDisplayProperties(feature.properties),
    geometry: compactCoordinates(feature.geometry)
  };
}

export function compactGeoJson(geojson: GeoJSON.FeatureCollection): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: geojson.features.map(compactFeature)
  };
}

export function compactGeoJsonString(geoJsonString: string): string {
  const parsed = JSON.parse(geoJsonString) as GeoJSON.GeoJSON;

  if (parsed.type === 'FeatureCollection') {
    const compacted = compactGeoJson(parsed);
    return JSON.stringify(compacted);
  } else if (parsed.type === 'Feature') {
    const compacted = compactFeature(parsed);
    return JSON.stringify(compacted);
  } else {
    const compacted = compactCoordinates(parsed);
    return JSON.stringify(compacted);
  }
}

export function roundCoordinate(lat: number, lon: number): { lat: number; lon: number } {
  return {
    lat: roundTo(lat, COORDINATE_PRECISION),
    lon: roundTo(lon, COORDINATE_PRECISION)
  };
}

export function roundElevation(elevation: Meters): Meters {
  return roundTo(elevation, ELEVATION_PRECISION) as Meters;
}
