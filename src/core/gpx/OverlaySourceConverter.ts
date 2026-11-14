import type { OverlayLoadMetrics } from "../OverlayLoadMetrics";
import { MapPlaceOverlay, OverlayTrackData } from 'places-shared/place';
import { PolylineCodec, extractTrackDataFromGeoJson, readGeoJsonCoordTimes } from 'places-shared/track';
import { type Meters } from 'places-shared/units';
import { collectGeoJsonGeometryParts, isGeoJsonFeature, isGeoJsonFeatureCollection, isGeoJsonGeometry } from 'places-shared/geo';
import type * as GeoJson from 'geojson';
import { GpxParser } from './GpxParser';
import { FitParser } from './FitParser';
import { parseCsvCoordinates } from './CsvCoordinateParser';
import { TRACK_MEASUREMENT_FIELDS, type RawTrackPoint } from './TrackPointProcessor';
import type { TrackDocumentModel } from './TrackDocumentModel';
import { serializeTrackDocumentToGpx } from './TrackDocumentGpx';
import { gpxWaypointToFeature } from './GpxWaypointFeature';
import { dispatchOverlayFormat, overlayFormatFromPath, type OverlayContentFormat, type OverlayPathFormat, type TrackFileFormat } from '../overlay/OverlayFormatDispatcher';
import type { MetricWindow } from 'places-shared/settings';
import type { SegmentedTrackData } from './GpxParser';
import { isFitBytes } from '../overlay/FitSignature';

export interface OverlayConversionOptions {
  metrics?: OverlayLoadMetrics;
  deferTrackData?: boolean;
}

export type OverlaySourceFormat = OverlayContentFormat;
export type { OverlayPathFormat };

export function detectOverlayFormat(content: string): OverlaySourceFormat;
export function detectOverlayFormat(path: string, options: { sourceType: 'path' }): OverlayPathFormat;
export function detectOverlayFormat(source: string, options?: { sourceType?: 'content' | 'path' }): OverlaySourceFormat | OverlayPathFormat;

export function detectOverlayFormat(source: string, options?: { sourceType?: 'content' | 'path' }): OverlaySourceFormat | OverlayPathFormat {
  if (options?.sourceType === 'path') {
    return detectOverlayPathFormat(source);
  }

  const format = dispatchOverlayFormat({ content: source, allowTrack: true });

  if (format === 'unknown' || format === 'md' || format === 'image') {
    throw new Error('Unable to determine overlay source format.');
  }

  return format;
}

function detectOverlayPathFormat(path: string): OverlayPathFormat {
  return overlayFormatFromPath(path);
}

export function parseTrackFile(content: string, format: TrackFileFormat, speedWindow?: MetricWindow): SegmentedTrackData {
  return format === 'fit' ? FitParser.parse(content, speedWindow) : GpxParser.parse(content, speedWindow);
}

export function convertOverlaySourceToGeoJson(content: string | Uint8Array, format?: OverlaySourceFormat, options: OverlayConversionOptions = {}): MapPlaceOverlay {
  const convert = (): MapPlaceOverlay => {
    if (typeof content !== 'string') {
      if (isFitBytes(content) && (format === undefined || format === 'fit')) {
        return convertTrackDocumentToGeoJson(FitParser.parseModel(content), options);
      }

      content = new TextDecoder('utf-8', { fatal: true }).decode(content);
    }

    const detectedFormat = format ?? detectOverlayFormat(content);

    switch (detectedFormat) {
      case 'geojson':
        return convertGeoJsonSource(content, options);
      case 'gpx':
        return convertTrackDocumentToGeoJson(GpxParser.parseModel(content), options);
      case 'fit':
        return convertTrackDocumentToGeoJson(FitParser.parseModel(content), options);
      case 'csv':
        return convertCsvToGeoJson(content, options);
      case 'polyline':
        return convertPolylineToGeoJson(content);
      default:
        throw new Error('Unknown overlay source format.');
    }
  };

  return options.metrics ? options.metrics.measure('parse', convert) : convert();
}

export function convertOverlaySourceToGpx(content: string, format?: OverlaySourceFormat, fallbackName = 'Track'): string {
  const detectedFormat = format ?? detectOverlayFormat(content);

  if (detectedFormat === 'gpx') {
    return content;
  }

  if (detectedFormat === 'fit') {
    return serializeTrackDocumentToGpx(FitParser.parseModel(content));
  }

  const overlay = convertOverlaySourceToGeoJson(content, detectedFormat);

  return convertGeoJsonToGpx(overlay.geojson, fallbackName);
}

function convertGeoJsonSource(content: string, options: OverlayConversionOptions): MapPlaceOverlay {
  const parsed: unknown = JSON.parse(content);

  let geojson: GeoJson.FeatureCollection;

  if (isGeoJsonFeatureCollection(parsed)) {
    geojson = parsed;
  } else if (isGeoJsonFeature(parsed)) {
    geojson = { type: 'FeatureCollection', features: [parsed] };
  } else if (isGeoJsonGeometry(parsed)) {
    geojson = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: parsed }]
    };
  } else {
    throw new Error('Overlay source is not valid GeoJson.');
  }

  const features: GeoJson.Feature[] = [];
  const position = (value: unknown): boolean => Array.isArray(value) && value.length >= 2
    && Number.isFinite(value[0]) && Number.isFinite(value[1]);
  const positions = (value: unknown): boolean => Array.isArray(value) && value.every(position);
  const lines = (value: unknown): boolean => Array.isArray(value) && value.every(positions);
  const append = (feature: GeoJson.Feature, geometry: GeoJson.Geometry | null, suffix = ''): void => {
    if (!geometry) return;

    if (geometry.type === 'GeometryCollection') {
      if (!Array.isArray(geometry.geometries)) throw new Error('Overlay source contains invalid geometry.');
      geometry.geometries.forEach((child, index) => append(feature, child, `${suffix}:${index}`));

      return;
    }

    const valid = geometry.type === 'Point' ? position(geometry.coordinates)
      : geometry.type === 'LineString' || geometry.type === 'MultiPoint' ? positions(geometry.coordinates)
      : geometry.type === 'MultiLineString' || geometry.type === 'Polygon' ? lines(geometry.coordinates)
      : geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates) && geometry.coordinates.every(lines);

    if (!valid) throw new Error('Overlay source contains invalid coordinates.');

    if (geometry.type === 'MultiPoint') {
      geometry.coordinates.forEach((coordinates, index) => append(feature, { type: 'Point', coordinates }, `${suffix}:${index}`));

      return;
    }

    features.push(suffix ? { ...feature, geometry, ...(feature.id !== undefined ? { id: `${feature.id}${suffix}` } : {}) } : feature);
  };

  for (const feature of geojson.features) append(feature, feature.geometry);
  geojson = { ...geojson, features };

  if (options.deferTrackData) {
    if (options.metrics) options.metrics.counts.deferredOverlays++;

    return { geojson, track: null };
  }

  const track = options.metrics ? options.metrics.measure('extract', () => extractTrackDataFromGeoJson(geojson)) : extractTrackDataFromGeoJson(geojson);

  return { geojson, track };
}

export function convertTrackDocumentToGeoJson(model: TrackDocumentModel, options: OverlayConversionOptions = {}): MapPlaceOverlay {
  const features: GeoJson.Feature[] = [];
  const allElevations: Meters[] = [];
  let allTimes: number[] | undefined;
  let pointCount = 0;

  for (const waypoint of model.waypoints) {
    features.push(gpxWaypointToFeature(waypoint, { includeElevationCoordinate: true }));
  }

  const appendLines = (name: string | undefined, rawSegments: RawTrackPoint[][]): void => {
    const nonempty = rawSegments.filter(segment => segment.length > 0);
    const segmentTimes: string[][] = [];
    const segments = nonempty.map(segment => {
      const hasTimes = segment.some(point => Number.isFinite(point.time?.getTime()));

      segmentTimes.push(hasTimes ? segment.map(point => Number.isFinite(point.time?.getTime()) ? point.time!.toISOString() : '') : []);
      if (hasTimes && !options.deferTrackData) allTimes ??= new Array<number>(pointCount).fill(Number.NaN);
      if (allTimes) for (const point of segment) allTimes.push(point.time?.getTime() ?? Number.NaN);
      pointCount += segment.length;

      return segment.map(point => {
        if (!options.deferTrackData && point.elevationMeters !== undefined) allElevations.push(point.elevationMeters);

        return point.elevationMeters === undefined
          ? [point.longitude, point.latitude]
          : [point.longitude, point.latitude, point.elevationMeters];
      });
    });

    if (segments.length > 0) {
      const geometry: GeoJson.LineString | GeoJson.MultiLineString = segments.length === 1
        ? { type: 'LineString', coordinates: segments[0] }
        : { type: 'MultiLineString', coordinates: segments };
      const coordTimes = segments.length === 1 ? segmentTimes[0] : segmentTimes;
      const hasTimes = segmentTimes.some(times => times.some(Boolean));
      const coordMeasurements: Record<string, (number | null)[] | (number | null)[][]> = {};

      for (const field of TRACK_MEASUREMENT_FIELDS) {
        if (!nonempty.some(segment => segment.some(point => Number.isFinite(point[field])))) continue;
        const values = nonempty.map(segment => segment.map(point => Number.isFinite(point[field]) ? point[field]! : null));

        coordMeasurements[field] = segments.length === 1 ? values[0] : values;
      }

      features.push({
        type: 'Feature',
        properties: { name, ...(hasTimes ? { coordTimes } : {}), ...(Object.keys(coordMeasurements).length ? { coordMeasurements } : {}) },
        geometry,
      });
    }
  };

  for (const track of model.tracks) appendLines(track.name, track.segments);
  for (const route of model.routes) appendLines(route.name, [route.points]);

  const geojson: GeoJson.FeatureCollection = { type: 'FeatureCollection', features };

  if (options.deferTrackData) {
    if (options.metrics) options.metrics.counts.deferredOverlays++;

    return { geojson, track: null };
  }

  const track: OverlayTrackData = {};

  if (allElevations.length > 0) {
    track.elevation = allElevations;
  }

  if (allTimes) {
    track.time = allTimes;
  }

  if (model.waypoints.length > 0) {
    track.waypoints = model.waypoints;
  }

  return { geojson, track: Object.keys(track).length > 0 ? track : undefined };
}

function convertCsvToGeoJson(csvContent: string, options: OverlayConversionOptions): MapPlaceOverlay {
  const { rawPoints } = parseCsvCoordinates(csvContent);

  if (rawPoints.length === 0) {
    throw new Error('No valid coordinates found in CSV');
  }

  const coordinates = rawPoints.map(point => point.elevationMeters === undefined
    ? [point.longitude, point.latitude]
    : [point.longitude, point.latitude, point.elevationMeters]);
  const hasTimes = rawPoints.some(point => point.time !== undefined);
  const coordTimes = hasTimes ? rawPoints.map(point => point.time?.toISOString() ?? '') : undefined;
  const geojson: GeoJson.FeatureCollection = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: coordTimes ? { coordTimes } : {},
      geometry: { type: 'LineString', coordinates }
    }]
  };

  if (options.deferTrackData) {
    if (options.metrics) options.metrics.counts.deferredOverlays++;

    return { geojson, track: null };
  }

  return { geojson, track: options.metrics ? options.metrics.measure('extract', () => extractTrackDataFromGeoJson(geojson)) : extractTrackDataFromGeoJson(geojson) };
}

function convertPolylineToGeoJson(encodedPolyline: string): MapPlaceOverlay {
  const coordinates = PolylineCodec.decode(encodedPolyline);

  const geoJsonCoords: [number, number][] = coordinates.map(coord => [coord.longitude, coord.latitude]);

  const geojson: GeoJson.FeatureCollection = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: geoJsonCoords }
    }]
  };

  return { geojson };
}

function convertGeoJsonToGpx(geojson: GeoJson.FeatureCollection, fallbackName: string): string {
  const waypoints: string[] = [];
  const trackSegments: string[] = [];
  let trackName = fallbackName;

  for (const feature of geojson.features) {
    const featureName = getGeoJsonFeatureName(feature) ?? fallbackName;

    if (featureName && trackName === fallbackName) {
      trackName = featureName;
    }

    appendGeometryToGpx(feature.geometry, featureName, waypoints, trackSegments, feature.properties?.coordTimes);
  }

  if (trackSegments.length === 0 && waypoints.length === 0) {
    throw new Error('No GPX-compatible points or line geometry found in overlay source.');
  }

  const trackBlock = trackSegments.length > 0
    ? [
      '  <trk>',
      `    <name>${escapeXml(trackName)}</name>`,
      ...trackSegments,
      '  </trk>'
    ].join('\n')
    : '';

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Places plugin" xmlns="http://www.topografix.com/GPX/1/1">',
    ...waypoints,
    ...(trackBlock ? [trackBlock] : []),
    '</gpx>'
  ].join('\n');
}

function appendGeometryToGpx(geometry: GeoJson.Geometry | null, name: string, waypoints: string[], trackSegments: string[], rawTimes?: unknown): void {
  if (!geometry) {
    return;
  }

  const parts = collectGeoJsonGeometryParts(geometry);

  for (const point of parts.points) {
    waypoints.push(createGpxWaypoint(point, name));
  }

  for (const [index, line] of parts.lines.entries()) {
    const times: unknown = geometry.type === 'LineString' ? rawTimes : Array.isArray(rawTimes) ? rawTimes[index] : undefined;

    trackSegments.push(createGpxTrackSegment(line, readGeoJsonCoordTimes(times, line.length)));
  }
}

function createGpxWaypoint(coordinate: GeoJson.Position, name?: string): string {
  const [lon, lat, ele] = coordinate;
  const elevation = typeof ele === 'number' ? `\n    <ele>${String(ele)}</ele>` : '';
  const waypointName = name ? `\n    <name>${escapeXml(name)}</name>` : '';

  return `  <wpt lat="${String(lat)}" lon="${String(lon)}">${elevation}${waypointName}\n  </wpt>`;
}

function createGpxTrackSegment(coordinates: GeoJson.Position[], times?: number[]): string {
  const points = coordinates.map((coordinate, index) => {
    const [lon, lat, ele] = coordinate;
    const elevation = typeof ele === 'number' ? `\n        <ele>${String(ele)}</ele>` : '';
    const timestamp = times?.[index];
    const time = timestamp !== undefined && Number.isFinite(timestamp) ? `\n        <time>${new Date(timestamp).toISOString()}</time>` : '';

    return `      <trkpt lat="${String(lat)}" lon="${String(lon)}">${elevation}${time}\n      </trkpt>`;
  });

  return [
    '    <trkseg>',
    ...points,
    '    </trkseg>'
  ].join('\n');
}

function getGeoJsonFeatureName(feature: GeoJson.Feature): string | undefined {
  const properties: unknown = feature.properties;
  const name = properties !== null && typeof properties === 'object' && !Array.isArray(properties)
    ? (properties as Record<string, unknown>).name
    : undefined;

  return typeof name === 'string' && name.trim() ? name : undefined;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
