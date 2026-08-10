import { logger as rootLogger } from "places-shared/utils";
import type * as GeoJSON from 'geojson';
import { Waypoint } from "places-shared/place";
import { Meters, km, meters } from "places-shared/units";
import { compactGeoJson, roundCoordinate, roundElevation } from "./GeoJsonCompactor";
import { TrackPointProcessor, RawTrackPoint } from "./TrackPointProcessor";
import { convertOverlaySourceToGeoJson } from "./OverlaySourceConverter";
import { parseCsvCoordinates } from "./CsvCoordinateParser";
import { type IPlacesPluginSettings } from "places-shared/settings";
import { buildTrackNoteFrontmatter, assignFrontmatter } from "places-shared/services";
import { Utilities, StringCompressor, numericRange, scalarToString } from "places-shared/utils";
import { OverlayImportResult, OverlaySourceFormat } from "./OverlayImportResult";
import { GpxParser } from "./GpxParser";
import { isGeoJsonFeatureCollection } from "places-shared/geo";

const logger = rootLogger.scope('Places Import');

// Carries only what the import flow needs: metrics for frontmatter, and the original
// content to store in Overlay Source. TrackDataService produces the full TrackData
// analysis and charts read.
export class OverlayImportService {
  constructor(private getSettings?: () => IPlacesPluginSettings) {}

  private requireSettings(): IPlacesPluginSettings {
    const settings = this.getSettings?.();
    if (!settings) {
      throw new Error('OverlayImportService settings are required for note frontmatter formatting.');
    }
    return settings;
  }

  private static extractTimeMetrics(points: Array<{ time?: Date }>): {
    startTime?: Date;
    endTime?: Date;
    durationSeconds?: number;
  } {
    const startTime = points.find(p => p.time)?.time;

    let endTime: Date | undefined;
    for (let i = points.length - 1; i >= 0; i--) {
      if (points[i].time) {
        endTime = points[i].time;
        break;
      }
    }
    const durationSeconds = startTime && endTime
      ? (endTime.getTime() - startTime.getTime()) / 1000
      : undefined;
    return { startTime, endTime, durationSeconds };
  }

  // Parse GPX content into a single OverlayImportResult (all tracks merged).
  parseGpxForImport(gpxContent: string): OverlayImportResult[] {
    try {
      const tracks = GpxParser.parseAllTracks(gpxContent);
      if (tracks.length === 0) {
        return [];
      }

      // TrackPoint[] is structurally compatible with RawTrackPoint[]. Keep the
      // runs apart: measuring the tracks concatenated counts the gap between
      // each one as distance travelled, which is how a 95-mile trail split
      // across 20 tracks was imported as 657 miles.
      const trackSegments = tracks.flatMap(t => t.segments ?? [t.points]);
      const mergedPoints = trackSegments.flat();

      const mainTrack = tracks.reduce((best, t) => t.points.length > best.points.length ? t : best);

      const allWaypoints = tracks.flatMap(t => t.waypoints);

      const { metrics } = TrackPointProcessor.processSegmentedTrackData(trackSegments);

      const { startTime, endTime, durationSeconds } = OverlayImportService.extractTimeMetrics(mergedPoints);

      return [{
        distanceKm: metrics.distance,
        totalPoints: mergedPoints.length,
        startLatitude: mergedPoints[0]?.latitude ?? 0,
        startLongitude: mergedPoints[0]?.longitude ?? 0,
        elevationGainMeters: metrics.elevationGain,
        elevationLossMeters: metrics.elevationLoss,
        minElevationMeters: metrics.minElevation,
        maxElevationMeters: metrics.maxElevation,
        durationSeconds,
        averageSpeedKph: metrics.averageSpeed,
        maxSpeedKph: metrics.maxSpeed,
        averagePaceMinPerKm: metrics.averagePace,
        startTime,
        endTime,
        name: mainTrack.metadata.name,
        description: mainTrack.metadata.description,
        waypoints: allWaypoints,
        originalContent: gpxContent,
        sourceFormat: 'gpx',
        sourceTrackCount: tracks.length
      }];
    } catch (error) {
      logger.error("Error parsing GPX for import:", error);
      return [];
    }
  }

  // Parse GPX content into separate OverlayImportResults (one per track).
  // Returns empty array if no tracks found.
  parseGpxTracksAsSeparate(gpxContent: string): OverlayImportResult[] {
    try {
      const tracks = GpxParser.parseAllTracks(gpxContent);
      if (tracks.length === 0) {
        return [];
      }

      return tracks.map(track => {
        const geojson = this.convertTrackDataToGeoJson(track);

        const { startTime, endTime, durationSeconds } = OverlayImportService.extractTimeMetrics(track.points);

        const result: OverlayImportResult = {
          distanceKm: track.metrics.distance,
          totalPoints: track.points.length,
          startLatitude: track.points[0]?.latitude ?? 0,
          startLongitude: track.points[0]?.longitude ?? 0,
          elevationGainMeters: track.metrics.elevationGain,
          elevationLossMeters: track.metrics.elevationLoss,
          minElevationMeters: track.metrics.minElevation,
          maxElevationMeters: track.metrics.maxElevation,
          durationSeconds,
          averageSpeedKph: track.metrics.averageSpeed,
          maxSpeedKph: track.metrics.maxSpeed,
          averagePaceMinPerKm: track.metrics.averagePace,
          startTime,
          endTime,
          name: track.metadata.name,
          description: track.metadata.description,
          waypoints: track.waypoints,
          originalContent: geojson,
          sourceFormat: 'geojson'
        };
        return result;
      });
    } catch (error) {
      logger.error("Error parsing GPX tracks as separate imports:", error);
      return [];
    }
  }

  // Each feature becomes a separate OverlayImportResult.
  // Returns empty array if no features found.
  parseGeoJsonForImport(geoJsonContent: string): OverlayImportResult[] {
    try {
      const geojson: unknown = JSON.parse(geoJsonContent);

      if (!isGeoJsonFeatureCollection(geojson)) {
        throw new Error("GeoJSON must be a FeatureCollection");
      }

      if (!geojson.features || geojson.features.length === 0) {
        return [];
      }

      const results: OverlayImportResult[] = [];

      for (const feature of geojson.features) {
        const result = this.parseGeoJsonFeature(feature as GeoJsonFeature);
        if (result) {
          results.push(result);
        }
      }

      return results;
    } catch (error) {
      logger.error("Error parsing GeoJSON for import:", error);
      return [];
    }
  }

  // Returns empty array if no valid coordinates found.
  // Logs warning if rows are skipped due to invalid coordinates.
  parseCsvForImport(csvContent: string, name?: string): OverlayImportResult[] {
    try {
      const { rawPoints, skippedRows, totalDataRows } = parseCsvCoordinates(csvContent);

      if (skippedRows > 0) {
        logger.warn(`Skipped ${skippedRows} row(s) with invalid coordinates`);
      }

      if (rawPoints.length === 0) {
        throw new Error(`No valid coordinates found in CSV. ${skippedRows} of ${totalDataRows} rows had invalid coordinates.`);
      }

      const { metrics } = TrackPointProcessor.processTrackData(rawPoints);

      const { startTime, endTime, durationSeconds } = OverlayImportService.extractTimeMetrics(rawPoints);

      return [{
        distanceKm: metrics.distance,
        totalPoints: rawPoints.length,
        startLatitude: rawPoints[0].latitude,
        startLongitude: rawPoints[0].longitude,
        elevationGainMeters: metrics.elevationGain,
        elevationLossMeters: metrics.elevationLoss,
        minElevationMeters: metrics.minElevation,
        maxElevationMeters: metrics.maxElevation,
        durationSeconds,
        averageSpeedKph: metrics.averageSpeed,
        maxSpeedKph: metrics.maxSpeed,
        averagePaceMinPerKm: metrics.averagePace,
        startTime,
        endTime,
        name,
        originalContent: csvContent,
        sourceFormat: 'csv'
      }];
    } catch (error) {
      logger.error("Error parsing CSV for import:", error);
      return [];
    }
  }

  private parseGeoJsonFeature(feature: GeoJsonFeature): OverlayImportResult | null {
    try {
      const coordinates = this.extractCoordinatesFromFeature(feature);
      if (coordinates.length === 0) {
        return null;
      }

      const rawPoints: RawTrackPoint[] = coordinates.map(coord => ({
        latitude: coord.latitude,
        longitude: coord.longitude,
        elevationMeters: coord.elevation !== undefined ? meters(coord.elevation) : undefined
      }));

      const { metrics } = TrackPointProcessor.processTrackData(rawPoints);

      const name = this.extractNameFromFeature(feature);
      const description = this.extractDescriptionFromFeature(feature);

      const singleFeatureGeoJson = JSON.stringify({
        type: 'FeatureCollection',
        features: [feature]
      });

      return {
        distanceKm: metrics.distance,
        totalPoints: coordinates.length,
        startLatitude: coordinates[0].latitude,
        startLongitude: coordinates[0].longitude,
        elevationGainMeters: metrics.elevationGain,
        elevationLossMeters: metrics.elevationLoss,
        minElevationMeters: metrics.minElevation,
        maxElevationMeters: metrics.maxElevation,
        name,
        description,
        originalContent: singleFeatureGeoJson,
        sourceFormat: 'geojson'
      };
    } catch (error) {
      logger.error("Error parsing GeoJSON feature:", error);
      return null;
    }
  }

  private extractCoordinatesFromFeature(feature: GeoJsonFeature): CoordinateWithElevation[] {
    const geometry = feature.geometry;
    const coordinates: CoordinateWithElevation[] = [];

    if (geometry.type === "LineString") {
      const coords = geometry.coordinates as number[][];
      for (const coord of coords) {
        const point = this.geoJsonCoordToLatLon(coord);
        if (point) coordinates.push(point);
      }
    } else if (geometry.type === "MultiLineString") {
      const coordArrays = geometry.coordinates as number[][][];
      for (const lineString of coordArrays) {
        for (const coord of lineString) {
          const point = this.geoJsonCoordToLatLon(coord);
          if (point) coordinates.push(point);
        }
      }
    }

    return coordinates;
  }

  private geoJsonCoordToLatLon(coord: number[]): CoordinateWithElevation | null {
    if (coord.length < 2) return null;

    const longitude = coord[0];
    const latitude = coord[1];
    const elevation = coord.length > 2 ? coord[2] : undefined;

    if (isNaN(latitude) || isNaN(longitude)) return null;

    return { latitude, longitude, elevation };
  }

  private extractNameFromFeature(feature: GeoJsonFeature): string | undefined {
    const props = feature.properties;
    if (!props) return undefined;

    if (props.name) return scalarToString(props.name) || undefined;
    if (Array.isArray(props.trails) && props.trails.length > 0) return scalarToString(props.trails[0]) || undefined;
    if (feature.id !== undefined) return `Feature ${feature.id}`;

    return undefined;
  }

  private extractDescriptionFromFeature(feature: GeoJsonFeature): string | undefined {
    const props = feature.properties;
    if (!props) return undefined;

    const parts: string[] = [];

    if (props.description) parts.push(scalarToString(props.description));
    else if (props.desc) parts.push(scalarToString(props.desc));

    if (props.state) parts.push(`State: ${scalarToString(props.state)}`);

    if (Array.isArray(props.trails) && props.trails.length > 1) {
      parts.push(`Trails: ${props.trails.map(item => scalarToString(item)).filter(Boolean).join(", ")}`);
    }

    return parts.length > 0 ? parts.join(" | ") : undefined;
  }

  // Coordinates and elevations are rounded to the storage precision.
  private convertTrackDataToGeoJson(track: { points: { latitude: number; longitude: number; elevationMeters?: Meters; time?: Date }[]; metadata: { name?: string; description?: string }; waypoints: Waypoint[] }): string {
    const { points, metadata, waypoints } = track;

    const features: GeoJSON.Feature[] = [];

    if (points.length > 0) {
      const coordinates: number[][] = points.map(p => {
        const rounded = roundCoordinate(p.latitude, p.longitude);
        const coord: number[] = [rounded.lon, rounded.lat];
        if (p.elevationMeters !== undefined) {
          coord.push(roundElevation(p.elevationMeters));
        }
        return coord;
      });

      features.push({
        type: 'Feature',
        properties: { name: metadata.name },
        geometry: {
          type: 'LineString',
          coordinates
        }
      });
    }

    for (const wpt of waypoints) {
      const rounded = roundCoordinate(wpt.lat, wpt.lon);
      const coord: number[] = [rounded.lon, rounded.lat];
      if (wpt.elevation !== undefined) {
        coord.push(roundElevation(wpt.elevation));
      }

      features.push({
        type: 'Feature',
        properties: {
          name: wpt.name,
          description: wpt.description,
          symbol: wpt.symbol,
          type: wpt.type,
          elevation: wpt.elevation,
          time: wpt.time?.toISOString(),
          comment: wpt.comment,
          link: wpt.link,
          _placesGpxWaypoint: true,
        },
        geometry: {
          type: 'Point',
          coordinates: coord
        }
      });
    }

    const featureCollection: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features
    };

    return JSON.stringify(featureCollection);
  }

  // Includes metrics, metadata, and compressed Overlay Source/Cache fields
  buildImportFrontmatter(result: OverlayImportResult): Record<string, unknown> {
    const settings = this.requireSettings();
    const units = settings.units;
    const frontmatter: Record<string, unknown> = buildTrackNoteFrontmatter({
      distanceKm: result.distanceKm,
      startCoordinate: { latitude: result.startLatitude, longitude: result.startLongitude },
      totalPoints: result.totalPoints,
      name: result.name,
      description: result.description,
      featureCount: result.sourceTrackCount,
      durationSeconds: result.durationSeconds,
      startTime: result.startTime,
      endTime: result.endTime,
      averageSpeedKph: result.averageSpeedKph,
      maxSpeedKph: result.maxSpeedKph,
      averagePaceMinPerKm: result.averagePaceMinPerKm,
      elevationGainMeters: result.elevationGainMeters,
      elevationLossMeters: result.elevationLossMeters,
      minElevationMeters: result.minElevationMeters,
      maxElevationMeters: result.maxElevationMeters,
    }, units);

    try {
      const precomputeCache = settings.precomputeOverlayCache;
      const overlayFields = OverlayImportService.buildOverlayFields(result.originalContent, result.sourceFormat, precomputeCache);
      assignFrontmatter(frontmatter, overlayFields);
    } catch (error) {
      logger.error('Failed to build overlay fields', error);
    }

    return frontmatter;
  }

  // Public static for reuse by TrackDataService and DragDropHandler.
  static buildOverlayFields(originalContent: string, sourceFormat: OverlaySourceFormat | 'polyline', precomputeCache: boolean): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    try {
      const compressedSource = StringCompressor.compressAndEncode(originalContent);
      result["Overlay Source"] = compressedSource;
    } catch (error) {
      logger.error("Error compressing overlay source:", error);
    }

    if (precomputeCache && sourceFormat !== 'geojson') {
      try {
        const overlay = convertOverlaySourceToGeoJson(originalContent, sourceFormat);
        // Compact GeoJSON for storage by reducing precision and retaining display properties.
        const compacted = compactGeoJson(overlay.geojson);
        const geoJsonString = JSON.stringify(compacted);
        const compressedCache = StringCompressor.compressAndEncode(geoJsonString);
        result["Overlay Cache"] = compressedCache;
      } catch (error) {
        logger.error("Error building overlay cache:", error);
      }
    }

    return result;
  }

  formatOverlayNoteName(result: OverlayImportResult, filename: string): string {
    const settings = this.requireSettings();
    const template = settings.gpxNoteNameFormat;

    const dateStr = Utilities.formatDateAsYYYYMMDD(result.startTime || new Date());

    const rawTrackName = result.name || filename.replace(/\.gpx$/i, '');
    const trackName = Utilities.sanitizeFilename(rawTrackName);

    const rawFilename = filename.replace(/\.gpx$/i, '');
    const filenameWithoutExt = Utilities.sanitizeFilename(rawFilename);

    const formattedName = template
      .replace(/{yyyymmdd}/g, dateStr)
      .replace(/{TrackName}/g, trackName)
      .replace(/{filename}/g, filenameWithoutExt)
      .trim();

    return formattedName;
  }

  // Returns an array holding the one combined result.
  combineGeoJsonFeatures(geoJsonContent: string): OverlayImportResult[] {
    const results = this.parseGeoJsonForImport(geoJsonContent);
    if (results.length === 0) {
      return [];
    }

    if (results.length === 1) {
      results[0].originalContent = geoJsonContent;
      return results;
    }

    const mainResult = results[0];

    mainResult.sourceTrackCount = results.length;

    mainResult.originalContent = geoJsonContent;

    mainResult.totalPoints = results.reduce((sum, r) => sum + r.totalPoints, 0);
    mainResult.distanceKm = km(results.reduce((sum, r) => sum + (r.distanceKm as number), 0));

    const totalGain = results.reduce((sum, r) => sum + (r.elevationGainMeters ? (r.elevationGainMeters as number) : 0), 0);
    mainResult.elevationGainMeters = meters(totalGain);

    const totalLoss = results.reduce((sum, r) => sum + (r.elevationLossMeters ? (r.elevationLossMeters as number) : 0), 0);
    mainResult.elevationLossMeters = totalLoss > 0 ? meters(totalLoss) : undefined;

    const minElevationRange = numericRange(results.map(r => r.minElevationMeters).filter((v): v is Meters => v !== undefined));
    mainResult.minElevationMeters = minElevationRange ? meters(minElevationRange.min) : undefined;

    const maxElevationRange = numericRange(results.map(r => r.maxElevationMeters).filter((v): v is Meters => v !== undefined));
    mainResult.maxElevationMeters = maxElevationRange ? meters(maxElevationRange.max) : undefined;

    mainResult.durationSeconds = undefined;
    mainResult.averageSpeedKph = undefined;
    mainResult.maxSpeedKph = undefined;
    mainResult.averagePaceMinPerKm = undefined;

    return [mainResult];
  }
}

interface GeoJsonFeature {
  type: string;
  id?: number | string;
  geometry: {
    type: string;
    coordinates: number[][] | number[][][];
  };
  properties?: Record<string, unknown>;
}

interface CoordinateWithElevation {
  latitude: number;
  longitude: number;
  elevation?: number;
}
