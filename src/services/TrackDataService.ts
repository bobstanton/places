import { PolylineCodec } from "places-shared/track";
import { parseTrackContent, type TrackContent } from 'places/core';
import { trackPreparation, TrackPreparationWorkerError } from './TrackPreparationWorker';
import { TFile, App, normalizePath } from "obsidian";
import { Coordinate, parseCoordinate } from "places-shared/geo";
import { detectOverlayFormat } from 'places/core';
import { resolveCurrentSourcePath } from "./SourcePathRenames";
import { formatMetricWindow, type IPlacesPluginSettings, type MetricWindow } from "places-shared/settings";
import { IElevationService, buildTrackNoteFrontmatter, type TrackNoteFrontmatterInput, assignFrontmatter } from "places-shared/services";
import { createOverlayNote } from "./OverlayNoteCreator";
import { getErrorMessage, StringCompressor, scalarToString } from "places-shared/utils";
import { isTrackFileFormat } from 'places/core';
import { TrackMetricsCalculator } from 'places/core';
import { readTrackFileContent } from "./TrackFileReader";
import { OverlayImportService } from 'places/core';
import { km } from "places-shared/units";
import { TrackPoint, TrackData } from 'places-shared/geo';
import { TrackPointProcessor, getSpeedWindow } from 'places/core';

export interface TrackLoadOptions {
  skipCache?: boolean;
  signal?: AbortSignal;
  speedWindow?: MetricWindow;
}
import type * as GeoJSON from "geojson";
import { gpxWaypointToFeature } from 'places/core';

function normalizeTrackPathSetting(pathSetting: string): string {
  let trackPath = pathSetting.trim();
  const quoted = trackPath.match(/^(["'])([\s\S]*)\1$/);

  if (quoted) trackPath = quoted[2].trim();
  const wikiLink = trackPath.match(/^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/);

  return (wikiLink?.[1] ?? trackPath).trim();
}

export type { TrackPoint, TrackData } from "places-shared/geo";

export class TrackDataService {
  constructor(private app: App, private getSettings?: () => IPlacesPluginSettings) {}

  private requireSettings(): IPlacesPluginSettings {
    const settings = this.getSettings?.();

    if (!settings) {
      throw new Error('TrackDataService settings are required for frontmatter formatting.');
    }

    return settings;
  }

  async loadTrackFromPath(pathSetting: string, sourcePath: string, options?: TrackLoadOptions): Promise<TrackData> {
    options?.signal?.throwIfAborted();
    const trackPath = normalizeTrackPathSetting(pathSetting);
    const file = this.resolveTrackFile(pathSetting, sourcePath);

    if (!file) {
      throw new Error(`File not found: ${trackPath}`);
    }

    const extension = file.extension.toLowerCase();

    const window = options?.speedWindow ?? getSpeedWindow();
    const prepare = (input: TrackContent) => trackPreparation.prepare(input, window, options?.signal);

    if (extension === 'md') {
      const steps = this.noteTrackSteps(file, options);
      let step = steps.next();

      while (!step.done) {
        options?.signal?.throwIfAborted();

        try {
          const track = await prepare(step.value);

          options?.signal?.throwIfAborted();
          step = steps.next(track);
        } catch (error) {
          options?.signal?.throwIfAborted();
          if (error instanceof TrackPreparationWorkerError) throw error;
          step = steps.throw(error);
        }
      }

      return step.value;
    }

    if (isTrackFileFormat(extension) || extension === 'geojson' || extension === 'json' || extension === 'csv') {
      const content = await readTrackFileContent(this.app, file);

      options?.signal?.throwIfAborted();

      return prepare({ content, format: extension === 'json' ? 'geojson' : extension, name: file.basename });
    }

    throw new Error(`Unsupported file type: .${extension}. Supported: .gpx, .fit, .csv, .geojson, .json, .md`);
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
    const cacheKey = `${file.path}|${options?.skipCache ? 'source' : 'cache'}|${formatMetricWindow(options?.speedWindow ?? getSpeedWindow())}`;
    const cached = TrackDataService.noteTrackCache.get(cacheKey);

    if (cached && cached.mtime === file.stat.mtime && cached.size === file.stat.size) {
      TrackDataService.noteTrackCache.delete(cacheKey);
      TrackDataService.noteTrackCache.set(cacheKey, cached);

      return cached.track;
    }

    const steps = this.noteTrackSteps(file, options);
    let step = steps.next();

    while (!step.done) {
      try {
 step = steps.next(parseTrackContent(step.value, options?.speedWindow)); 
}
      catch (error) {
 step = steps.throw(error); 
}
    }

    const track = step.value;

    TrackDataService.noteTrackCache.set(cacheKey, { mtime: file.stat.mtime, size: file.stat.size, track });

    if (TrackDataService.noteTrackCache.size > TrackDataService.NOTE_TRACK_CACHE_MAX) {
      const oldest = TrackDataService.noteTrackCache.keys().next().value;

      if (oldest !== undefined) TrackDataService.noteTrackCache.delete(oldest);
    }

    return track;
  }

  private *noteTrackSteps(file: TFile, options?: TrackLoadOptions): Generator<TrackContent, TrackData, TrackData> {
    const fileCache = this.app.metadataCache.getFileCache(file);
    const frontmatter = fileCache?.frontmatter;

    if (!frontmatter) {
      throw new Error("No frontmatter found in file");
    }

    const failures: string[] = [];

    const overlayCache = scalarToString(frontmatter["Overlay Cache"]);

    if (!options?.skipCache && overlayCache) {
      try {
        const decompressed = StringCompressor.decodeAndDecompress(overlayCache);

        return yield { content: decompressed, format: 'geojson' };
      } catch (error) {
        failures.push(`Overlay Cache: ${getErrorMessage(error)}`);
      }
    }

    const overlaySource = scalarToString(frontmatter["Overlay Source"]);

    if (overlaySource) {
      try {
        const decompressed = StringCompressor.decodeAndDecompress(overlaySource);
        const format = detectOverlayFormat(decompressed);

        return yield { content: decompressed, format };
      } catch (error) {
        failures.push(`Overlay Source: ${getErrorMessage(error)}`);
      }
    }

    const location = scalarToString(frontmatter["Location"]);

    if (location) {
      const coordinate = parseCoordinate(location);

      if (coordinate) {
        return this.createFromCoordinates([coordinate]);
      }
    }

    throw new Error(`No track data found in file${failures.length > 0 ? ` (${failures.join('; ')})` : ''}`);
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
