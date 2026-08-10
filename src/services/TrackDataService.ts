import { TFile, App, normalizePath } from "obsidian";
import { Coordinate, parseCoordinate } from "places-shared/geo";
import { PolylineCodec } from "places-shared/track";
import { detectOverlayFormat } from "./OverlaySourceConverter";
import { resolveCurrentSourcePath } from "./SourcePathRenames";
import { parseCsvCoordinates } from "./CsvCoordinateParser";
import { formatMetricWindow, type IPlacesPluginSettings, type MetricWindow } from "places-shared/settings";
import { IElevationService, createOverlayNote, buildTrackNoteFrontmatter, type TrackNoteFrontmatterInput, assignFrontmatter } from "places-shared/services";
import { getErrorMessage, StringCompressor, scalarToString } from "places-shared/utils";
import { GpxParser } from "./GpxParser";
import { TrackMetricsCalculator } from "./TrackMetricsCalculator";
import { OverlayImportService } from "./OverlayImportService";
import { Meters, km, meters } from "places-shared/units";
import { TrackPointProcessor, getSpeedWindow, RawTrackPoint, TrackPoint, TrackData } from "./TrackPointProcessor";

// Track load options. `speedWindow` overrides the global setting for this block.
export interface TrackLoadOptions {
  skipCache?: boolean;
  speedWindow?: MetricWindow;
}
import type * as GeoJSON from "geojson";
import { isGeoJsonFeature, isGeoJsonFeatureCollection, isGeoJsonGeometry } from "places-shared/geo";
import { gpxWaypointToFeature } from "./GpxWaypointFeature";

interface GeoJsonFeature {
  type: string;
  properties?: Record<string, unknown>;
  geometry?: {
    type: string;
    coordinates: number[][] | number[][][];
  };
}

function normalizeTrackPathSetting(pathSetting: string): string {
  let trackPath = pathSetting.trim();
  const quoted = trackPath.match(/^(["'])([\s\S]*)\1$/);
  if (quoted) trackPath = quoted[2].trim();
  const wikiLink = trackPath.match(/^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/);
  return (wikiLink?.[1] ?? trackPath).trim();
}

export type { TrackPoint, TrackData } from "./TrackPointProcessor";

interface SegmentedTrackData extends TrackData {
  segments?: TrackPoint[][];
}

export class TrackDataService {
  constructor(private app: App, private getSettings?: () => IPlacesPluginSettings) {}

  private requireSettings(): IPlacesPluginSettings {
    const settings = this.getSettings?.();
    if (!settings) {
      throw new Error('TrackDataService settings are required for frontmatter formatting.');
    }
    return settings;
  }

  parseGeoJsonContent(geoJsonContent: string, speedWindow?: MetricWindow): SegmentedTrackData {
    const geojson: unknown = JSON.parse(geoJsonContent);

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

    // Every line feature, not just the first. Stopping at the first one read a
    // 20-feature trail as its opening 2-point stub, which is what "recalculate"
    // wrote back over a note's real statistics.
    const collected: number[][][] = [];
    let featureName: string | undefined;
    let featureDescription: string | undefined;

    for (const feature of features) {
      const geom = feature.geometry;
      if (!geom) continue;

      if (geom.type === 'LineString') collected.push(geom.coordinates as number[][]);
      else if (geom.type === 'MultiLineString') collected.push(...(geom.coordinates as number[][][]));
      else continue;

      // Named after the first line feature carrying a name, as a single-feature
      // file always was.
      featureName ??= feature.properties?.name as string | undefined;
      featureDescription ??= feature.properties?.description as string | undefined;
    }

    const coordinateSegments = collected.filter(segment => segment.length > 0);
    if (coordinateSegments.length === 0) {
      throw new Error("No LineString geometry found in GeoJSON");
    }

    const rawSegments: RawTrackPoint[][] = coordinateSegments.map(segment => segment.map(coord => ({
      latitude: coord[1],
      longitude: coord[0],
      elevationMeters: coord[2] !== undefined ? meters(coord[2]) : undefined
    })));
    const { points, metrics: populatedMetrics } = TrackPointProcessor.processSegmentedTrackData(rawSegments, speedWindow);

    return {
      points,
      segments: rawSegments.length > 1 ? rawSegments.map(segment => TrackPointProcessor.createTrackPoints(segment)) : undefined,
      metrics: populatedMetrics,
      waypoints: [],
      metadata: {
        name: featureName,
        description: featureDescription,
        source: 'manual'
      }
    };
  }

  parseEncodedPolyline(encodedPolyline: string, speedWindow?: MetricWindow): TrackData {
    const coordinates = PolylineCodec.decode(encodedPolyline);
    if (!coordinates || coordinates.length === 0) {
      throw new Error("Failed to decode polyline data");
    }

    // Coordinate[] is structurally compatible with RawTrackPoint[]
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

  // Expects columns: latitude/lat, longitude/lng/lon, optional: elevation/ele, time
  parseCsvContent(csvContent: string, name?: string, speedWindow?: MetricWindow): TrackData {
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

  // `pathSetting` accepts a wiki-link `[[Note]]`, a quoted `"file.gpx"`, or a bare path,
  // resolved relative to `sourcePath`. Handles .md, .gpx, .csv, .geojson and .json files.
  async loadTrackFromPath(pathSetting: string, sourcePath: string, options?: TrackLoadOptions): Promise<TrackData> {
    const trackPath = normalizeTrackPathSetting(pathSetting);
    const file = this.resolveTrackFile(pathSetting, sourcePath);

    if (!file) {
      throw new Error(`File not found: ${trackPath}`);
    }

    const extension = file.extension.toLowerCase();

    if (extension === 'md') {
      return this.extractTrackFromNote(file, options);
    }

    if (extension === 'gpx') {
      const content = await this.app.vault.cachedRead(file);
      return GpxParser.parse(content, options?.speedWindow);
    }

    if (extension === 'geojson' || extension === 'json') {
      const content = await this.app.vault.cachedRead(file);
      return this.parseGeoJsonContent(content, options?.speedWindow);
    }

    if (extension === 'csv') {
      const content = await this.app.vault.cachedRead(file);
      const name = file.basename;
      return this.parseCsvContent(content, name, options?.speedWindow);
    }

    throw new Error(`Unsupported file type: .${extension}. Supported: .gpx, .csv, .geojson, .json, .md`);
  }

  resolveMarkdownTrackFile(pathSetting: string, sourcePath: string): TFile | null {
    const file = this.resolveTrackFile(pathSetting, sourcePath);
    return file instanceof TFile && file.extension === "md" ? file : null;
  }

  // Resolve the same wiki-link, alias, quoted, and direct-path forms accepted by loadTrackFromPath.
  resolveTrackFile(pathSetting: string, sourcePath: string): TFile | null {
    const resolved = this.resolveTrackFileOnce(pathSetting, sourcePath);
    if (resolved) return resolved;
    // Both arguments can be stale after a note rename: ctx.sourcePath stays
    // frozen for already-rendered blocks, and blocks with no explicit track
    // bake that frozen path into the setting itself (classify's implicit
    // self-note case). Resolve each through the session rename record and
    // retry before giving up.
    const trackPath = normalizeTrackPathSetting(pathSetting);
    const currentTrackPath = resolveCurrentSourcePath(trackPath);
    const currentSourcePath = resolveCurrentSourcePath(sourcePath);
    if (currentTrackPath === trackPath && currentSourcePath === sourcePath) return null;
    return this.resolveTrackFileOnce(currentTrackPath, currentSourcePath);
  }

  private resolveTrackFileOnce(pathSetting: string, sourcePath: string): TFile | null {
    const trackPath = normalizeTrackPathSetting(pathSetting);
    const linkedFile = this.app.metadataCache.getFirstLinkpathDest(trackPath, sourcePath)
      ?? (trackPath.toLowerCase().endsWith('.md')
        ? this.app.metadataCache.getFirstLinkpathDest(trackPath.slice(0, -3), sourcePath)
        : null);
    if (linkedFile instanceof TFile) return linkedFile;
    const abstractFile = this.app.vault.getAbstractFileByPath(normalizePath(trackPath));
    return abstractFile instanceof TFile ? abstractFile : null;
  }

  async writeOverlayToFile(file: TFile, trackData: TrackData): Promise<void> {
    const geojson = JSON.stringify(this.trackDataToGeoJson(trackData));
    const frontmatterFields = this.buildOverlayFrontmatter(trackData, geojson, "geojson");

    await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
      assignFrontmatter(frontmatter, frontmatterFields);
    });
  }

  // Create a new markdown track note from track data (used by the snap/elevation "Export to new
  // note" action). The note carries the same GeoJSON `Overlay Source` + metrics frontmatter that
  // {@link writeOverlayToFile} writes, and an exported note is identical data to an in-place replace,
  // plus a `places` map block. The note is created next to `sourcePath`; the caller opens it.
  async createTrackNote(trackData: TrackData, options: { sourcePath?: string; name?: string }): Promise<TFile> {
    const geojson = JSON.stringify(this.trackDataToGeoJson(trackData));
    return createOverlayNote(this.app, {
      name: options.name ?? trackData.metadata.name ?? "Places track",
      sourcePath: options.sourcePath,
      frontmatter: this.buildOverlayFrontmatter(trackData, geojson, "geojson"),
    });
  }

  createFromCoordinates(coordinates: Coordinate[], metadata?: { name?: string; description?: string }): TrackData {
    if (coordinates.length === 0) {
      throw new Error("At least one coordinate is required");
    }

    const { points, metrics } = TrackPointProcessor.processTrackData(coordinates);

    return {
      points,
      metrics,
      waypoints: [],
      metadata: {
        name: metadata?.name,
        description: metadata?.description,
        source: 'manual'
      }
    };
  }

  buildOverlayFrontmatter(trackData: TrackData, originalContent: string, sourceFormat: 'gpx' | 'geojson' | 'csv' | 'polyline'): Record<string, unknown> {
    const settings = this.requireSettings();
    const units = settings.units;
    const precomputeCache = settings.precomputeOverlayCache;

    return {
      ...buildTrackNoteFrontmatter(this.toFrontmatterInput(trackData), units),
      ...OverlayImportService.buildOverlayFields(originalContent, sourceFormat, precomputeCache)
    };
  }

  // Called by the recalculation commands, which hold the compressed source already.
  buildOverlayFrontmatterPreservingSource(trackData: TrackData, originalCompressedSource: string): Record<string, unknown> {
    const units = this.requireSettings().units;

    return {
      ...buildTrackNoteFrontmatter(this.toFrontmatterInput(trackData), units),
      "Overlay Source": originalCompressedSource
    };
  }

  // A parsed track as the shared frontmatter schema's inputs, in storage units.
  private toFrontmatterInput(trackData: TrackData): TrackNoteFrontmatterInput {
    const { metrics, metadata, points } = trackData;
    return {
      distanceKm: metrics.distance,
      startCoordinate: points[0],
      totalPoints: points.length,
      // Recalculating has to restate this: a stale count left behind from import
      // is the one number that would still disagree with the recomputed rest.
      featureCount: trackData.segments?.length,
      name: metadata.name,
      description: metadata.description,
      durationSeconds: metrics.duration !== undefined ? metrics.duration * 3600 : undefined,
      movingTimeSeconds: metrics.movingTime !== undefined ? metrics.movingTime * 3600 : undefined,
      averageSpeedKph: metrics.averageSpeed,
      maxSpeedKph: metrics.maxSpeed,
      averagePaceMinPerKm: metrics.averagePace,
      bestPaceMinPerKm: metrics.bestPace,
      elevationGainMeters: metrics.elevationGain,
      elevationLossMeters: metrics.elevationLoss,
      minElevationMeters: metrics.minElevation,
      maxElevationMeters: metrics.maxElevation,
    };
  }





  // Parsed tracks keyed by path + data-source variant, valid while the file's
  // mtime+size are unchanged (same pattern as TrackDataExtractor.trackCache).
  // Chart/compare/similar blocks re-extract on every render; decompress+parse
  // of a multi-thousand-point track is the dominant cost. Entries are shared
  // by reference - consumers must not mutate the returned TrackData.
  private static noteTrackCache = new Map<string, { mtime: number; size: number; track: TrackData }>();
  private static readonly NOTE_TRACK_CACHE_MAX = 200;

  extractTrackFromNote(file: TFile, options?: TrackLoadOptions): TrackData {
    // The speed window is baked into the parsed points, and it keys the memo:
    // changing the setting must not serve speeds computed with the old span.
    const cacheKey = `${file.path}|${options?.skipCache ? 'source' : 'cache'}|${formatMetricWindow(options?.speedWindow ?? getSpeedWindow())}`;
    const cached = TrackDataService.noteTrackCache.get(cacheKey);
    if (cached && cached.mtime === file.stat.mtime && cached.size === file.stat.size) {
      TrackDataService.noteTrackCache.delete(cacheKey);
      TrackDataService.noteTrackCache.set(cacheKey, cached);
      return cached.track;
    }

    const track = this.extractTrackFromNoteUncached(file, options);
    TrackDataService.noteTrackCache.set(cacheKey, { mtime: file.stat.mtime, size: file.stat.size, track });
    if (TrackDataService.noteTrackCache.size > TrackDataService.NOTE_TRACK_CACHE_MAX) {
      const oldest = TrackDataService.noteTrackCache.keys().next().value;
      if (oldest !== undefined) TrackDataService.noteTrackCache.delete(oldest);
    }
    return track;
  }

  private extractTrackFromNoteUncached(file: TFile, options?: TrackLoadOptions): TrackData {
    const fileCache = this.app.metadataCache.getFileCache(file);
    const frontmatter = fileCache?.frontmatter;

    if (!frontmatter) {
      throw new Error("No frontmatter found in file");
    }

    const failures: string[] = [];

    // Priority 1: Overlay Cache (precomputed GeoJSON - fastest, map-only, no time/speed data)
    const overlayCache = scalarToString(frontmatter["Overlay Cache"]);
    if (!options?.skipCache && overlayCache) {
      try {
        const decompressed = StringCompressor.decodeAndDecompress(overlayCache);
        return this.parseGeoJsonContent(decompressed, options?.speedWindow);
      } catch (error) {
        failures.push(`Overlay Cache: ${getErrorMessage(error)}`);
      }
    }

    // Priority 2: Overlay Source (original content - needs format detection and possible conversion)
    const overlaySource = scalarToString(frontmatter["Overlay Source"]);
    if (overlaySource) {
      try {
        const decompressed = StringCompressor.decodeAndDecompress(overlaySource);
        const format = detectOverlayFormat(decompressed);

        switch (format) {
          case 'gpx':
            return GpxParser.parse(decompressed, options?.speedWindow);
          case 'geojson':
            return this.parseGeoJsonContent(decompressed, options?.speedWindow);
          case 'csv':
            return this.parseCsvContent(decompressed, undefined, options?.speedWindow);
          case 'polyline':
            return this.parseEncodedPolyline(decompressed, options?.speedWindow);
        }
      } catch (error) {
        failures.push(`Overlay Source: ${getErrorMessage(error)}`);
      }
    }

    // Priority 3: Location field (single point)
    const location = scalarToString(frontmatter["Location"]);
    if (location) {
      const coordinate = parseCoordinate(location);
      if (coordinate) {
        return this.createFromCoordinates([coordinate]);
      }
    }

    throw new Error(`No track data found in file${failures.length > 0 ? ` (${failures.join('; ')})` : ''}`);
  }

  calculateElevationMetrics(points: RawTrackPoint[]): {
    gainInMeters: Meters;
    lossInMeters: Meters;
    minInMeters?: Meters;
    maxInMeters?: Meters;
  } {
    let elevationGainInMeters = 0;
    let elevationLossInMeters = 0;
    let previousElevationInMeters: Meters | null = null;
    let minElevationInMeters: Meters | null = null;
    let maxElevationInMeters: Meters | null = null;

    points.forEach(point => {
      if (point.elevationMeters !== undefined) {
        if (minElevationInMeters === null || point.elevationMeters < minElevationInMeters) {
          minElevationInMeters = point.elevationMeters;
        }
        if (maxElevationInMeters === null || point.elevationMeters > maxElevationInMeters) {
          maxElevationInMeters = point.elevationMeters;
        }

        if (previousElevationInMeters !== null) {
          const delta = point.elevationMeters - previousElevationInMeters;
          if (delta > 0) {
            elevationGainInMeters += delta;
          } else if (delta < 0) {
            elevationLossInMeters += Math.abs(delta);
          }
        }
        previousElevationInMeters = point.elevationMeters;
      }
    });

    return {
      gainInMeters: meters(elevationGainInMeters),
      lossInMeters: meters(elevationLossInMeters),
      minInMeters: minElevationInMeters ?? undefined,
      maxInMeters: maxElevationInMeters ?? undefined
    };
  }

  hasElevationData(trackData: TrackData): boolean {
    if (trackData.points.length === 0) {
      return false;
    }

    // A track is considered populated only when every point has finite elevation.
    return trackData.points.every(point =>
      point.elevationMeters !== undefined &&
      !isNaN(point.elevationMeters)
    );
  }

  async populateWithElevation(trackData: TrackData, elevationService: IElevationService, options?: { replaceExisting?: boolean }): Promise<TrackData> {
    if (!elevationService) {
      throw new Error("Elevation service is not available");
    }

    if (!options?.replaceExisting && this.hasElevationData(trackData)) {
      return trackData; // Already has elevation data
    }

    if (trackData.points.length === 0) {
      throw new Error("No track points to populate");
    }

    const elevationProfile = await elevationService.getElevationProfile(trackData.points);

    if (elevationProfile.points.length !== trackData.points.length) {
      throw new Error(`Elevation service returned ${elevationProfile.points.length} points for ${trackData.points.length} track points`);
    }

    const populatedPoints: TrackPoint[] = elevationProfile.points.map((elevPoint, index) => {
      const trackPoint = trackData.points[index];

      return {
        ...trackPoint,
        latitude: elevPoint.latitude,
        longitude: elevPoint.longitude,
        distanceKm: km(elevPoint.distance / 1000), // Convert meters to km
        elevationMeters: elevPoint.elevation,
      };
    });

    const populatedMetrics = TrackMetricsCalculator.calculate(populatedPoints);

    const populatedTrackData: TrackData = {
      ...trackData,
      points: populatedPoints,
      metrics: populatedMetrics
    };

    return populatedTrackData;
  }
  decodePolylineToCoordinates(encodedPolyline: string): Coordinate[] {
    return PolylineCodec.decode(encodedPolyline);
  }

  trackDataToGeoJson(trackData: TrackData, options?: { strokeColor?: string; strokeWidth?: number }): GeoJSON.FeatureCollection {
    const features: GeoJSON.Feature[] = [];

    if (trackData.points.length > 0) {
      const coordinates = trackData.points.map(point => {
        const coord: number[] = [point.longitude, point.latitude];
        if (point.elevationMeters !== undefined) {
          coord.push(point.elevationMeters);
        }
        return coord;
      });

      // Only stamp simplestyle when a caller supplies an intentional style. A track carries no
      // baked default, and a renderer's own default (or an explicit overlay style) applies instead
      // of a hardcoded stroke masquerading as a per-feature choice.
      const properties: Record<string, unknown> = {
        name: trackData.metadata?.name,
        description: trackData.metadata?.description,
      };
      if (options?.strokeColor !== undefined) properties.stroke = options.strokeColor;
      if (options?.strokeWidth !== undefined) properties['stroke-width'] = options.strokeWidth;

      features.push({
        type: 'Feature',
        properties,
        geometry: {
          type: 'LineString',
          coordinates
        }
      });
    }

    if (trackData.waypoints && trackData.waypoints.length > 0) {
      for (const waypoint of trackData.waypoints) {
        features.push(gpxWaypointToFeature(waypoint, { markerSymbol: "marker" }));
      }
    }

    return {
      type: 'FeatureCollection',
      features
    };
  }

}
