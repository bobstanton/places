import { Waypoint, MapPlaceOverlay, OverlayTrackData } from 'places-shared/place';
import { PolylineCodec } from 'places-shared/track';
import { type Meters, meters } from 'places-shared/units';
import { collectGeoJsonGeometryParts, isGeoJsonFeature, isGeoJsonFeatureCollection, isGeoJsonGeometry } from 'places-shared/geo';
import type * as GeoJson from 'geojson';
import { GpxParser } from './GpxParser';
import { gpxWaypointToFeature } from './GpxWaypointFeature';
import { dispatchOverlayFormat, overlayFormatFromPath, type OverlayContentFormat, type OverlayPathFormat } from 'places-shared/overlay';

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

export function convertOverlaySourceToGeoJson(content: string, format?: OverlaySourceFormat): MapPlaceOverlay {
  const detectedFormat = format ?? detectOverlayFormat(content);

  switch (detectedFormat) {
    case 'geojson':
      return convertGeoJsonSource(content);
    case 'gpx':
      return convertGpxToGeoJson(content);
    case 'csv':
      return convertCsvToGeoJson(content);
    case 'polyline':
      return convertPolylineToGeoJson(content);
    default:
      throw new Error('Unknown overlay source format.');
  }
}

export function convertOverlaySourceToGpx(content: string, format?: OverlaySourceFormat, fallbackName = 'Track'): string {
  const detectedFormat = format ?? detectOverlayFormat(content);
  if (detectedFormat === 'gpx') {
    return content;
  }

  const overlay = convertOverlaySourceToGeoJson(content, detectedFormat);
  return convertGeoJsonToGpx(overlay.geojson, fallbackName);
}

function convertGeoJsonSource(content: string): MapPlaceOverlay {
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

  const track = extractTrackDataFromGeoJson(geojson);

  return { geojson, track };
}

function convertGpxToGeoJson(gpxContent: string): MapPlaceOverlay {
  const model = GpxParser.parseModel(gpxContent);
  const features: GeoJson.Feature[] = [];
  const allElevations: Meters[] = [];
  const allTimes: number[] = [];
  for (const waypoint of model.waypoints) {
    features.push(gpxWaypointToFeature(waypoint, { includeElevationCoordinate: true }));
  }
  for (const track of model.tracks) {
    const segmentTimes: string[][] = [];
    const segments = track.segments.filter(segment => segment.length > 0).map(segment => {
      segmentTimes.push(segment.map(point => point.time?.toISOString() ?? ''));
      for (const point of segment) allTimes.push(point.time?.getTime() ?? Number.NaN);
      return segment.map(point => {
        if (point.elevationMeters !== undefined) allElevations.push(point.elevationMeters);
        return point.elevationMeters === undefined
          ? [point.longitude, point.latitude]
          : [point.longitude, point.latitude, point.elevationMeters];
      });
    });
    if (segments.length > 0) {
      const geometry: GeoJson.LineString | GeoJson.MultiLineString = segments.length === 1
        ? { type: 'LineString', coordinates: segments[0] }
        : { type: 'MultiLineString', coordinates: segments };
      // `coordTimes` is the conventional GeoJSON carrier for per-point times:
      // a flat array for a LineString, one array per line for a MultiLineString.
      const coordTimes = segments.length === 1 ? segmentTimes[0] : segmentTimes;
      const hasTimes = segmentTimes.some(times => times.some(Boolean));
      features.push({
        type: 'Feature',
        properties: { name: track.name, ...(hasTimes ? { coordTimes } : {}) },
        geometry,
      });
    }
  }
  for (const route of model.routes) {
    const coords = route.points.map(point => {
      if (point.elevationMeters !== undefined) allElevations.push(point.elevationMeters);
      return point.elevationMeters === undefined
        ? [point.longitude, point.latitude]
        : [point.longitude, point.latitude, point.elevationMeters];
    });
    if (coords.length > 0) {
      features.push({ type: 'Feature', properties: { name: route.name }, geometry: { type: 'LineString', coordinates: coords } });
    }
  }

  const geojson: GeoJson.FeatureCollection = { type: 'FeatureCollection', features };

  const track: OverlayTrackData = {};
  if (allElevations.length > 0) {
    track.elevation = allElevations;
  }
  if (allTimes.some(Number.isFinite)) {
    track.time = allTimes;
  }
  if (model.waypoints.length > 0) {
    track.waypoints = model.waypoints;
  }

  return { geojson, track: Object.keys(track).length > 0 ? track : undefined };
}

function convertCsvToGeoJson(csvContent: string): MapPlaceOverlay {
  const lines = csvContent.trim().split('\n');
  if (lines.length < 2) {
    throw new Error('CSV must have at least a header and one data row');
  }

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const latIndex = headers.findIndex(h => h === 'lat' || h === 'latitude');
  const lonIndex = headers.findIndex(h => h === 'lon' || h === 'lng' || h === 'longitude');
  const eleIndex = headers.findIndex(h => h === 'ele' || h === 'elevation' || h === 'alt' || h === 'altitude');

  if (latIndex === -1 || lonIndex === -1) {
    throw new Error('CSV must have latitude and longitude columns');
  }

  const coordinates: number[][] = [];
  const elevations: Meters[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.trim());
    const lat = parseFloat(values[latIndex]);
    const lon = parseFloat(values[lonIndex]);

    if (isNaN(lat) || isNaN(lon)) continue;

    if (eleIndex !== -1 && values[eleIndex]) {
      const ele = parseFloat(values[eleIndex]);
      if (!isNaN(ele)) {
        coordinates.push([lon, lat, ele]);
        elevations.push(meters(ele));
      } else {
        coordinates.push([lon, lat]);
      }
    } else {
      coordinates.push([lon, lat]);
    }
  }

  if (coordinates.length === 0) {
    throw new Error('No valid coordinates found in CSV');
  }

  const geojson: GeoJson.FeatureCollection = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates }
    }]
  };

  const track: OverlayTrackData = {};
  if (elevations.length > 0) {
    track.elevation = elevations;
  }

  return { geojson, track: Object.keys(track).length > 0 ? track : undefined };
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

    appendGeometryToGpx(feature.geometry, featureName, waypoints, trackSegments);
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

function appendGeometryToGpx(geometry: GeoJson.Geometry | null, name: string, waypoints: string[], trackSegments: string[]): void {
  if (!geometry) {
    return;
  }

  const parts = collectGeoJsonGeometryParts(geometry);
  for (const point of parts.points) {
    waypoints.push(createGpxWaypoint(point, name));
  }
  for (const line of parts.lines) {
    trackSegments.push(createGpxTrackSegment(line));
  }
}

function createGpxWaypoint(coordinate: GeoJson.Position, name?: string): string {
  const [lon, lat, ele] = coordinate;
  const elevation = typeof ele === 'number' ? `\n    <ele>${String(ele)}</ele>` : '';
  const waypointName = name ? `\n    <name>${escapeXml(name)}</name>` : '';
  return `  <wpt lat="${String(lat)}" lon="${String(lon)}">${elevation}${waypointName}\n  </wpt>`;
}

function createGpxTrackSegment(coordinates: GeoJson.Position[]): string {
  const points = coordinates.map((coordinate) => {
    const [lon, lat, ele] = coordinate;
    const elevation = typeof ele === 'number' ? `\n        <ele>${String(ele)}</ele>` : '';
    return `      <trkpt lat="${String(lat)}" lon="${String(lon)}">${elevation}\n      </trkpt>`;
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

// `coordTimes` is flat for a LineString and nested per line for a MultiLineString.
function readCoordTimes(properties: GeoJson.GeoJsonProperties, nested: boolean): number[] {
  const raw: unknown = properties?.coordTimes;
  if (!Array.isArray(raw)) return [];
  const values = nested ? (raw as unknown[]).flat() : raw as unknown[];
  return values.map(value => {
    if (typeof value === 'number') return value;
    const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  });
}

function extractTrackDataFromGeoJson(geojson: GeoJson.FeatureCollection): OverlayTrackData | undefined {
  const elevations: Meters[] = [];
  const times: number[] = [];
  const waypoints: Waypoint[] = [];

  for (const feature of geojson.features) {
    if (!feature.geometry) continue;

    if (feature.geometry.type === 'Point') {
      const coords = feature.geometry.coordinates;
      waypoints.push({
        name: (feature.properties?.name as string) || '',
        lat: coords[1],
        lon: coords[0],
        elevation: coords[2] !== undefined ? meters(coords[2]) : undefined,
        description: feature.properties?.description as string | undefined
      });
    }

    if (feature.geometry.type === 'LineString') {
      for (const coord of feature.geometry.coordinates) {
        if (coord.length > 2 && typeof coord[2] === 'number') {
          elevations.push(meters(coord[2]));
        }
      }
      times.push(...readCoordTimes(feature.properties, false));
    } else if (feature.geometry.type === 'MultiLineString') {
      for (const line of feature.geometry.coordinates) {
        for (const coord of line) {
          if (coord.length > 2 && typeof coord[2] === 'number') {
            elevations.push(meters(coord[2]));
          }
        }
      }
      times.push(...readCoordTimes(feature.properties, true));
    }
  }

  const track: OverlayTrackData = {};
  if (elevations.length > 0) {
    track.elevation = elevations;
  }
  if (times.some(Number.isFinite)) {
    track.time = times;
  }
  if (waypoints.length > 0) {
    track.waypoints = waypoints;
  }

  return Object.keys(track).length > 0 ? track : undefined;
}
