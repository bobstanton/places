import { parseTrackFile } from './gpx/OverlaySourceConverter';
import { PolylineCodec, readGeoJsonCoordTimes } from 'places-shared/track';
import { isGeoJsonFeature, isGeoJsonFeatureCollection, isGeoJsonGeometry } from 'places-shared/geo';
import type { TrackData, TrackPoint } from 'places-shared/geo';
import type { MetricWindow } from 'places-shared/settings';
import { meters } from 'places-shared/units';
import { parseCsvCoordinates } from './gpx/CsvCoordinateParser';
import { TrackPointProcessor, TRACK_MEASUREMENT_FIELDS, type RawTrackPoint } from './gpx/TrackPointProcessor';
import type * as GeoJSON from 'geojson';
import { extractTrackDataFromGeoJson } from 'places-shared/track';
import { FitParser } from './gpx/FitParser';

interface GeoJsonFeature {
  type: string;
  properties?: Record<string, unknown>;
  geometry?: {
    type: string;
    coordinates: number[][] | number[][][];
  };
}

interface SegmentedTrackData extends TrackData { segments?: TrackPoint[][]; }

export function parseGeoJsonContent(geoJsonContent: string | GeoJSON.FeatureCollection, speedWindow?: MetricWindow): SegmentedTrackData {
  const geojson: unknown = typeof geoJsonContent === 'string' ? JSON.parse(geoJsonContent) : geoJsonContent;

  let features: GeoJsonFeature[] = [];

  if (isGeoJsonFeatureCollection(geojson)) {
    features = geojson.features as GeoJsonFeature[];
  } else if (isGeoJsonFeature(geojson)) {
    features = [geojson as GeoJsonFeature];
  } else if (isGeoJsonGeometry(geojson)) {
    features = [{ type: 'Feature', properties: {}, geometry: geojson as GeoJsonFeature['geometry'] }];
  } else {
    throw new Error("GeoJSON must be a Geometry, Feature, or FeatureCollection");
  }

  if (features.length === 0) {
    throw new Error("No features found in GeoJSON");
  }

  const collected: { coordinates: number[][]; times: unknown; measurements: Record<string, unknown> }[] = [];
  let featureName: string | undefined;
  let featureDescription: string | undefined;

  for (const feature of features) {
    const geom = feature.geometry;

    if (!geom) continue;

    const rawTimes = feature.properties?.coordTimes;
    const rawMeasurements = feature.properties?.coordMeasurements;
    const measurements = rawMeasurements && typeof rawMeasurements === 'object' && !Array.isArray(rawMeasurements)
      ? rawMeasurements as Record<string, unknown> : {};

    if (geom.type === 'LineString') {
      collected.push({ coordinates: geom.coordinates as number[][], times: rawTimes, measurements });
    } else if (geom.type === 'MultiLineString') {
      const segmentTimes: unknown[] = Array.isArray(rawTimes) ? rawTimes : [];

      for (const [index, coordinates] of (geom.coordinates as number[][][]).entries()) {
        collected.push({ coordinates, times: segmentTimes[index], measurements: Object.fromEntries(
          TRACK_MEASUREMENT_FIELDS.map(field => [field, Array.isArray(measurements[field]) ? measurements[field][index] : undefined]),
        ) });
      }
    } else continue;

    featureName ??= feature.properties?.name as string | undefined;
    featureDescription ??= feature.properties?.description as string | undefined;
  }

  const coordinateSegments = collected.filter(segment => segment.coordinates.length > 0);

  if (coordinateSegments.length === 0) {
    throw new Error("No LineString geometry found in GeoJSON");
  }

  const rawSegments: RawTrackPoint[][] = coordinateSegments.map(segment => {
    const times = readGeoJsonCoordTimes(segment.times, segment.coordinates.length);

    return segment.coordinates.map((coord, index) => {
      const measurements: Partial<RawTrackPoint> = {};

      for (const field of TRACK_MEASUREMENT_FIELDS) {
        const values = segment.measurements[field];
        const value: unknown = Array.isArray(values) ? values[index] : undefined;

        if (typeof value === 'number' && Number.isFinite(value)) {
          Object.assign(measurements, { [field]: value });
        }
      }

      return {
        ...measurements,
        latitude: coord[1],
        longitude: coord[0],
        elevationMeters: coord[2] !== undefined ? meters(coord[2]) : undefined,
        time: times && Number.isFinite(times[index]) ? new Date(times[index]) : undefined,
      };
    });
  });
  const { points, metrics: populatedMetrics } = TrackPointProcessor.processSegmentedTrackData(rawSegments, speedWindow);

  return {
    points,
    segments: rawSegments.length > 1 ? rawSegments.map(segment => TrackPointProcessor.createTrackPoints(segment, speedWindow)) : undefined,
    metrics: populatedMetrics,
    waypoints: extractTrackDataFromGeoJson({ type: 'FeatureCollection', features: features.filter(feature => feature.geometry?.type === 'Point') as GeoJSON.Feature[] })?.waypoints ?? [],
    metadata: {
      name: featureName,
      description: featureDescription,
      source: 'manual'
    }
  };
}

export function parseEncodedPolyline(encodedPolyline: string, speedWindow?: MetricWindow): TrackData {
  const coordinates = PolylineCodec.decode(encodedPolyline);

  if (!coordinates || coordinates.length === 0) {
    throw new Error("Failed to decode polyline data");
  }

  const { points, metrics: populatedMetrics } = TrackPointProcessor.processTrackData(coordinates, speedWindow);

  return {
    points,
    metrics: populatedMetrics,
    waypoints: [],
    metadata: {
      source: 'polyline'
    }
  };
}

export function parseCsvContent(csvContent: string, name?: string, speedWindow?: MetricWindow): TrackData {
  const { rawPoints } = parseCsvCoordinates(csvContent);

  if (rawPoints.length === 0) {
    throw new Error('No valid coordinates found in CSV');
  }

  const { points, metrics: populatedMetrics } = TrackPointProcessor.processTrackData(rawPoints, speedWindow);

  return {
    points,
    metrics: populatedMetrics,
    waypoints: [],
    metadata: {
      name,
      source: 'manual'
    }
  };
}

export type TrackContent = {
  content: string | Uint8Array;
  format: 'geojson' | 'csv' | 'polyline' | 'gpx' | 'fit';
  name?: string;
} | {
  geojson: GeoJSON.FeatureCollection;
  format: 'geojson';
  name?: string;
};

export function parseTrackContent(input: TrackContent, speedWindow?: MetricWindow): TrackData {
  if ('geojson' in input) return parseGeoJsonContent(input.geojson, speedWindow);
  if (input.format === 'fit') return FitParser.parse(input.content, speedWindow);
  const content = typeof input.content === 'string' ? input.content : new TextDecoder('utf-8', { fatal: true }).decode(input.content);

  switch (input.format) {
    case 'geojson': return parseGeoJsonContent(content, speedWindow);
    case 'csv': return parseCsvContent(content, input.name, speedWindow);
    case 'polyline': return parseEncodedPolyline(content, speedWindow);
    case 'gpx': return parseTrackFile(content, input.format, speedWindow);
  }
}
