import { normalizeFrontmatterTags } from "places-shared/map";
import { getErrorMessage, isRecord, logger, sleep, type PerformanceMonitor } from "places-shared/utils";
import { App, MarkdownPostProcessorContext, TFile, normalizePath } from "obsidian";
import { km, miles, feet, milesToKm, metersToKm, feetToMeters, Kilometers } from "places-shared/units";
import { DistanceCalculator, Coordinate, parseNamedCoordinate } from "places-shared/geo";
import { MapPlace } from "places-shared/overlay";
import { DEFAULT_MARKER_ICON, resolveWaypointIcon } from "places-shared/map";
import { extractFrontmatterTagsFromFile } from "./PlaceTagExtractor";
import { Utilities, getError, getFileNameWithoutExtension, readNormalizedProperty, scalarToString } from "places-shared/utils";
import { compactOverlayBlobs, createMapPlaceFromProperties } from "./MapPlaceFactory";
import { MapBlockSettings, type PlaceSource, type MapPrepareSourceTiming } from "places-shared/settings";
import { TrackDataService } from "./TrackDataService";
import { QueryPreparationCanceled, VaultQueryService, type VaultQueryPlaceResult, type QueryConversionProgress } from "./VaultQueryService";
import PlacesPlugin from "../main";
import { overlayFormatFromPath } from 'places/core';
import { readTrackFileContent } from './TrackFileReader';
import { resolveCurrentSourcePath } from './SourcePathRenames';

interface DataviewTableData {
  headers: string[];
  values: unknown[][];
}

type DataviewQueryResult =
  | { type: 'table'; headers: string[]; values: unknown[][] }
  | { type: 'list'; values: unknown[] }
  | { type: 'task' | 'calendar'; values: unknown };

interface DataviewApiAdapter {
  index?: { initialized?: boolean };
  tryQuery(source: string, originFile?: string): Promise<DataviewQueryResult>;
}

// What obsidian-dataview's getAPI() returns. Importing the package would
// bundle its DQL engine + Luxon (~150 KB); queries run inside the user's own
// Dataview plugin.
const getDataviewAPI = (app: App): DataviewApiAdapter | undefined =>
  (app as unknown as { plugins?: { plugins?: { dataview?: { api?: DataviewApiAdapter } } } }).plugins?.plugins?.dataview?.api;

const vaultQueryLogger = logger.scope('VaultQuery');
const dataviewLogger = logger.scope('Dataview');
const DATAVIEW_INDEX_WAIT_MS = 10_000;

type WorkspaceEventRef = ReturnType<App['workspace']['on']>;
type DataviewWorkspaceEvents = {
  on(name: 'dataview:refresh-views', callback: () => void): WorkspaceEventRef;
};

type RadiusUnit = 'miles' | 'km' | 'meters' | 'feet';

type PlaceSourceId = 'vault-query' | 'dataview' | 'current-note' | 'places';

interface PlaceSourceResult {
  id: PlaceSourceId;
  places: MapPlace[];
  error?: Error;
  queryErrors?: VaultQueryPlaceResult['errors'];
  unreadable?: boolean;
}

export interface CollectedPlaces {
  places: MapPlace[];
  sourcesUnreadable: boolean;
  queryErrors: VaultQueryPlaceResult['errors'];
}

const UNIT_ALIASES: Record<string, RadiusUnit> = {
  mi: 'miles',
  mile: 'miles',
  miles: 'miles',
  km: 'km',
  kilometer: 'km',
  kilometers: 'km',
  m: 'meters',
  meter: 'meters',
  meters: 'meters',
  ft: 'feet',
  feet: 'feet',
};

const UNIT_CONVERSIONS: Record<RadiusUnit, { toKm: (distance: number) => Kilometers; label: string }> = {
  miles: { toKm: (distance) => milesToKm(miles(distance)), label: 'miles' },
  km: { toKm: (distance) => km(distance), label: 'km' },
  meters: { toKm: (distance) => km(distance / 1000), label: 'meters' },
  feet: { toKm: (distance) => metersToKm(feetToMeters(feet(distance))), label: 'feet' },
};

export class PlaceDataService {
  private dataviewReady: Promise<void> | null = null;
  private vaultQueryService: VaultQueryService;

  constructor(private app: App, private trackDataService: TrackDataService, vaultQueryService: VaultQueryService) {
    this.vaultQueryService = vaultQueryService;
  }

  invalidateQueryCache(): void {
    this.vaultQueryService.invalidateCache();
  }

  extractFromFrontmatter(ctx: MarkdownPostProcessorContext): Promise<{ places: MapPlace[]; unreadable: boolean }> {
    try {
      const path = normalizePath(ctx.sourcePath);
      const file = this.app.vault.getFileByPath(path);
      const fileCache = file ? this.app.metadataCache.getFileCache(file) : this.app.metadataCache.getCache(path);
      const frontmatter = fileCache?.frontmatter;

      if (!fileCache) {
        logger.debug('The current note is not indexed yet; its places are unknown', { path, inVaultIndex: file !== null });

        return Promise.resolve({ places: [], unreadable: true });
      }

      if (frontmatter && !frontmatter["Location"] && frontmatter["Overlay Source"]) {
        if (!file) return Promise.resolve({ places: [], unreadable: false });

        return Promise.resolve({ places: this.extractWaypointsFromFile(file, ctx.sourcePath), unreadable: false });
      }

      if (!frontmatter) return Promise.resolve({ places: [], unreadable: false });

      const place = this.extractPlaceFromFrontmatter(frontmatter, path);

      if (!place) return Promise.resolve({ places: [], unreadable: false });

      place.tags = normalizeFrontmatterTags(frontmatter.tags);
      if (!place.metadata) place.metadata = {};
      place.metadata.sourceFile = ctx.sourcePath;

      return Promise.resolve({ places: [place], unreadable: false });
    } catch (error) {
      logger.error('Error extracting from frontmatter:', error);

      return Promise.resolve({ places: [], unreadable: false });
    }
  }

  loadTrackPlaceFromPath(pathSetting: string, sourcePath: string): MapPlace | null {
    const file = this.trackDataService.resolveMarkdownTrackFile(pathSetting, sourcePath);

    if (!file) return null;
    const place = this.extractPlaceFromFile(file);

    if (!place) return null;
    place.tags = extractFrontmatterTagsFromFile(this.app, file.path);
    place.metadata ??= {};
    place.metadata.sourceFile = file.path;

    return place;
  }

  async collectAllPlaces(blockSettings: MapBlockSettings, ctx: MarkdownPostProcessorContext, perf?: PerformanceMonitor, sourceTimings?: MapPrepareSourceTiming[], progress?: QueryConversionProgress): Promise<CollectedPlaces> {
    const queryProgress = progress ? {
      ...progress,
      isPriorityPlace: progress.isPriorityPlace ? (place: MapPlace) => progress.isPriorityPlace!(place)
        && this.filterCollectedPlaces([place], blockSettings, ctx).length > 0 : undefined,
      onBatch: progress.onBatch ? async (result: VaultQueryPlaceResult) => progress.onBatch!({
        ...result, places: this.filterCollectedPlaces(result.places, blockSettings, ctx),
      }) : undefined,
    } : undefined;
    const sourceResults = await Promise.all(this.createPlaceSourceCollectors(blockSettings, ctx, queryProgress).map(async collector => {
      const started = Date.now();
      const result = await collector();
      const durationMs = Date.now() - started;

      perf?.mark('source-collected', { source: result.id, durationMs, places: result.places.length });
      sourceTimings?.push({ id: result.id, durationMs, places: result.places.length });

      return result;
    }));
    const queryError = sourceResults.find(result =>
      (result.id === 'vault-query' || result.id === 'dataview') && result.error
    )?.error ?? null;
    const fallbackPlaces = sourceResults
      .filter(result => result.id !== 'vault-query' && result.id !== 'dataview')
      .flatMap(result => result.places);

    if (queryError && fallbackPlaces.length === 0) {
      throw queryError;
    }

    const places = this.filterCollectedPlaces(sourceResults.flatMap(result => result.places), blockSettings, ctx);

    return { places, sourcesUnreadable: sourceResults.some(result => result.unreadable === true), queryErrors: sourceResults.flatMap(result => result.queryErrors ?? []) };
  }

  private filterCollectedPlaces(collected: MapPlace[], blockSettings: MapBlockSettings, ctx: MarkdownPostProcessorContext): MapPlace[] {
    let places = this.dedupePlacesByIdentity(collected);

    if (blockSettings.radius) {
      let fallbackCenter: Coordinate | undefined;

      if (!blockSettings.radius.toLowerCase().includes(' from ')) {
        if (blockSettings.location) {
          fallbackCenter = parseNamedCoordinate(blockSettings.location) ?? undefined;
        }

        if (!fallbackCenter && ctx.sourcePath) {
          fallbackCenter = this.extractFrontmatterLocation(ctx.sourcePath);
        }
      }

      places = this.filterPlacesByRadius(places, blockSettings, fallbackCenter);
    }

    return places;
  }

  private createPlaceSourceCollectors(blockSettings: MapBlockSettings, ctx: MarkdownPostProcessorContext, progress?: QueryConversionProgress): Array<() => Promise<PlaceSourceResult>> {
    const collectors: Array<() => Promise<PlaceSourceResult>> = [];

    if (blockSettings.query) {
      collectors.push(() => this.collectQuerySource('vault-query', async () => {
        const { places, errors } = await this.vaultQueryService.extractFromQuery(blockSettings.query!, ctx.sourcePath, progress);

        return { places, queryErrors: errors };
      }));
    } else if (blockSettings.dataview) {
      collectors.push(() => this.collectQuerySource('dataview', async () => ({ places: await this.extractFromDataviewQuery(blockSettings.dataview!, ctx.sourcePath) })));
    }

    if (!blockSettings.query && !blockSettings.dataview && blockSettings.places === undefined) {
      collectors.push(async () => {
        const { places, unreadable } = await this.extractFromFrontmatter(ctx);

        return { id: 'current-note', places, unreadable };
      });
    }

    if (blockSettings.places !== undefined) {
      collectors.push(async () => {
        const { places, errors } = await this.extractFromPlaces(blockSettings.places!, ctx.sourcePath, {
          isCanceled: progress?.isCanceled,
          onBatch: !blockSettings.query && !blockSettings.dataview ? progress?.onBatch : undefined,
        });

        return { id: 'places', places, queryErrors: errors };
      });
    }

    return collectors;
  }

  private async collectQuerySource(id: 'vault-query' | 'dataview', collect: () => Promise<Pick<PlaceSourceResult, 'places' | 'queryErrors'>>): Promise<PlaceSourceResult> {
    try {
      return { id, ...await collect() };
    } catch (error) {
      if (Utilities.isDataviewUnavailableError(error) || Utilities.isVaultQueryUnavailableError(error)) {
        return { id, places: [], error: error as Error };
      }

      throw error;
    }
  }

  async extractFromPlaces(sources: readonly PlaceSource[], sourcePath: string, progress?: QueryConversionProgress): Promise<VaultQueryPlaceResult> {
    const places: MapPlace[] = [];
    const errors: VaultQueryPlaceResult['errors'] = [];
    const seen = new Set<string>();
    let yieldedAt = performance.now(), publishedAt = yieldedAt, publicationDelay = 50;

    for (const [index, entry] of sources.entries()) {
      if (progress?.isCanceled?.()) throw new QueryPreparationCanceled();
      let errorPath = `places[${index}]`;

      try {
        let place: MapPlace | null;

        if (typeof entry === 'string') {
          errorPath = entry;
          const file = this.app.metadataCache.getFirstLinkpathDest(resolveCurrentSourcePath(entry), resolveCurrentSourcePath(sourcePath));

          if (!file) throw new Error('Linked file was not found.');
          if (seen.has(file.path)) continue;
          seen.add(file.path);
          errorPath = file.path;
          const format = overlayFormatFromPath(file.path);

          if (format === 'md') {
            place = this.extractPlaceFromFile(file);
          } else if (format === 'gpx' || format === 'fit' || format === 'geojson' || format === 'csv') {
            const content = await readTrackFileContent(this.app, file);

            if (progress?.isCanceled?.()) throw new QueryPreparationCanceled();
            place = createMapPlaceFromProperties({ properties: { overlay_source: content }, name: file.basename, filePath: file.path });
          } else {
            throw new Error('Linked file must be a place note, GPX, FIT, GeoJSON or coordinate CSV.');
          }

          if (!place) throw new Error('Linked file has no valid Location or overlay contents.');
          place.metadata ??= {};
          place.metadata.sourceFile = file.path;
        } else {
          const coordinate = parseNamedCoordinate(readNormalizedProperty(entry, 'location'));

          if (!coordinate) continue;
          place = createMapPlaceFromProperties({
            properties: entry,
            name: scalarToString(readNormalizedProperty(entry, 'name')) || coordinate.name || '',
          });
        }

        if (place) places.push(place);
      } catch (error) {
        if (error instanceof QueryPreparationCanceled) throw error;
        errors.push({ path: errorPath, error: getErrorMessage(error) });
      }

      if (progress?.onBatch && places.length && performance.now() - publishedAt >= publicationDelay) {
        await progress.onBatch({ places: [...places], errors: [...errors] });
        publishedAt = performance.now();
        publicationDelay = Math.min(1000, publicationDelay * 2);
      }

      if (performance.now() - yieldedAt >= 8) { await sleep(0); yieldedAt = performance.now(); }
    }

    if (progress?.isCanceled?.()) throw new QueryPreparationCanceled();

    return { places, errors };
  }

  private dedupePlacesByIdentity(places: MapPlace[]): MapPlace[] {
    const deduped = new Map<string, MapPlace>();

    for (const place of places) {
      deduped.set(this.getPlaceIdentity(place), place);
    }

    return Array.from(deduped.values());
  }

  private getPlaceIdentity(place: MapPlace): string {
    return place.id
      ? ['id', place.id].join(':')
      : place.filePath
        ? ['file', place.filePath].join(':')
        : ['coord', String(place.latitude), String(place.longitude)].join(':');
  }

  private extractFrontmatterLocation(filePath: string): Coordinate | undefined {
    const file = this.app.vault.getFileByPath(normalizePath(filePath));

    if (!file) return undefined;
    const location: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.['Location'];

    if (typeof location !== 'string') return undefined;

    return parseNamedCoordinate(location) ?? undefined;
  }

  // A place within the radius of ANY center point is included.
  // `{distance}[unit] from {lat}, {lng} [or {lat}, {lng} ...]`,
  // where an omitted unit takes the configured units setting.
  //   "50 from 41.408, -75.662"
  //   "50mi from 41.408, -75.662"
  //   "15mi from 41.408, -75.662 or 41.573, -75.501"
  //   "80km from 41.408, -75.662 or 41.573, -75.501 or 40.986, -75.195"
  private filterPlacesByRadius(places: MapPlace[], blockSettings: MapBlockSettings, fallbackCenter?: Coordinate): MapPlace[] {
    if (!blockSettings.radius) return places;

    const radiusStr = blockSettings.radius.toLowerCase();
    const fromIndex = radiusStr.indexOf(' from ');

    const distanceStr = fromIndex !== -1
      ? radiusStr.substring(0, fromIndex).trim()
      : radiusStr.trim();

    const { radiusKm } = this.parseDistanceWithUnit(distanceStr);

    if (radiusKm === null) {
      logger.warn('Invalid radius distance:', distanceStr);

      return places;
    }

    let centers: Coordinate[];

    if (fromIndex !== -1) {
      const coordsStr = blockSettings.radius.substring(fromIndex + 6).trim(); // preserve case for parsing
      const coordParts = coordsStr.split(/\s+or\s+/i);

      centers = [];

      for (const coordPart of coordParts) {
        const center = parseNamedCoordinate(coordPart.trim());

        if (!center) {
          logger.warn('Invalid radius coordinate:', coordPart.trim());

          return places;
        }

        centers.push(center);
      }
    } else if (fallbackCenter) {
      centers = [fallbackCenter];
    } else {
      logger.warn('radius has no "from" clause and no location was found in the code block settings or note frontmatter. Use: radius: 50 from lat, lng');

      return places;
    }

    return places.filter(place =>
      centers.some(center => {
        const distanceKm = DistanceCalculator.haversineDistance(
          center.latitude, center.longitude,
          place.latitude, place.longitude
        );

        return (distanceKm as number) <= (radiusKm as number);
      })
    );
  }

  private parseDistanceWithUnit(distanceStr: string): { distance: number; unitLabel: string; radiusKm: Kilometers | null } {
    const match = distanceStr.match(/^([\d.]+)\s*(mi|miles?|km|kilometers?|m|meters?|ft|feet)?$/i);

    if (!match) {
      return { distance: 0, unitLabel: '', radiusKm: null };
    }

    const distance = parseFloat(match[1]);

    if (isNaN(distance) || distance <= 0) {
      return { distance: 0, unitLabel: '', radiusKm: null };
    }

    const unit = (match[2] || '').toLowerCase();
    const canonicalUnit = UNIT_ALIASES[unit];
    const conversion = canonicalUnit ? UNIT_CONVERSIONS[canonicalUnit] : undefined;

    if (conversion) {
      return { distance, unitLabel: conversion.label, radiusKm: conversion.toKm(distance) };
    }

    const units = PlacesPlugin.settings.units;
    const defaultConversion = UNIT_CONVERSIONS[units === 'imperial' ? 'miles' : 'km'];

    return { distance, unitLabel: defaultConversion.label, radiusKm: defaultConversion.toKm(distance) };
  }

  async extractFromDataviewQuery(query: string, sourcePath: string): Promise<MapPlace[]> {
    try {
      const results = await this.executePlacesQuery(query, sourcePath);

      if (!results) return [];

      const places = this.convertQueryResultsToPlaces(results);

      return places;
    } catch (error) {
      if (Utilities.isDataviewUnavailableError(error)) {
        throw error;
      }

      logger.warn('Dataview query error:', error);

      return [];
    }
  }

  private async executePlacesQuery(query: string, sourcePath: string): Promise<DataviewTableData | undefined> {
    const dataview = getDataviewAPI(this.app);

    if (!dataview) {
      throw new Error("Dataview plugin is not available");
    }

    await this.ensureDataviewReady(dataview);

    if (!query) {
      throw new Error("Query parameter is required");
    }

    const tableQuery = this.transformToTableQuery(query);

    // Yield to allow loading indicator to render before query execution
    await new Promise(resolve => window.requestAnimationFrame(resolve));

    const result = await dataview.tryQuery(tableQuery, sourcePath);

    if (result.type !== 'table') {
      throw new Error(`Expected a Dataview table result, received ${result.type}.`);
    }

    if (result.values.length === 0) {
      return undefined;
    }

    return { headers: result.headers, values: result.values };
  }

  private transformToTableQuery(query: string): string {
    const trimmed = query.trim();
    const upperQuery = trimmed.toUpperCase();

    const fields = 'file.frontmatter';

    if (upperQuery.startsWith('TABLE')) {
      return this.augmentTableQuery(trimmed, fields);
    }

    if (upperQuery.startsWith('LIST')) {
      const afterList = trimmed.substring(4).trim();

      return `TABLE ${fields}\n${afterList}`;
    }

    return `TABLE ${fields}\n${trimmed}`;
  }

  private augmentTableQuery(query: string, requiredFields: string): string {
    const upperQuery = query.toUpperCase();
    const fromIndex = upperQuery.indexOf('FROM');

    if (fromIndex === -1) {
      return query;
    }

    const tableIndex = upperQuery.indexOf('TABLE') + 5;
    const existingFields = query.substring(tableIndex, fromIndex).trim();
    const afterFrom = query.substring(fromIndex);

    if (existingFields.toUpperCase().includes('FILE.FRONTMATTER')) {
      return query;
    }

    const allFields = existingFields ? `${existingFields}, ${requiredFields}` : requiredFields;

    return `TABLE ${allFields}\n${afterFrom}`;
  }

  private convertQueryResultsToPlaces(queryResults: DataviewTableData): MapPlace[] {
    const headers = queryResults.headers;
    const rows = queryResults.values;

    const colIndex: Record<string, number> = {};

    headers.forEach((header, idx) => {
      colIndex[header.toLowerCase()] = idx;
    });

    const getCol = (row: Array<unknown>, name: string): unknown => {
      const idx = colIndex[name.toLowerCase()];

      return idx !== undefined ? row[idx] : undefined;
    };

    const places: MapPlace[] = [];

    for (const row of rows) {
      try {
        const fileLink = row[0];
        const filePath = isRecord(fileLink) && typeof fileLink.path === 'string' ? fileLink.path : undefined;

        if (!filePath) continue;

        const rawFrontmatter = getCol(row, 'file.frontmatter');

        if (!isRecord(rawFrontmatter)) continue;
        const frontmatter = rawFrontmatter;

        const place = createMapPlaceFromProperties({
          properties: frontmatter,
          name: getFileNameWithoutExtension(filePath, 'Unknown', /\.md$/i),
          filePath,
          tags: normalizeFrontmatterTags(frontmatter['tags']),
          metadata: compactOverlayBlobs({ ...frontmatter, sourceFile: filePath }),
        });

        if (!place) continue;

        places.push(place);
      } catch {
        continue;
      }
    }

    return places;
  }

  private extractWaypointsFromFile(file: TFile, filePath: string): MapPlace[] {
    try {
      const trackData = this.trackDataService.extractTrackFromNote(file);
      const { waypoints } = trackData;

      if (!waypoints || waypoints.length === 0) return [];

      return waypoints.map((waypoint, index) => {
        const place: MapPlace = {
          id: `waypoint:${filePath}:${index}`,
          latitude: waypoint.lat,
          longitude: waypoint.lon,
          name: waypoint.name,
          icon: resolveWaypointIcon(waypoint) ?? DEFAULT_MARKER_ICON,
          filePath: filePath
        };

        place.tags = extractFrontmatterTagsFromFile(this.app, filePath);
        if (!place.metadata) place.metadata = {};
        place.metadata.sourceFile = filePath;

        place.metadata.isWaypoint = true;
        place.metadata.waypointDescription = waypoint.description;
        place.metadata.waypointSymbol = waypoint.symbol;
        place.metadata.waypointType = waypoint.type;
        place.metadata.waypointComment = waypoint.comment;
        place.metadata.waypointLink = waypoint.link;
        place.metadata.waypointElevation = waypoint.elevation;

        return place;
      });
    } catch {
      return [];
    }
  }

  private extractPlaceFromFrontmatter(frontmatter: Record<string, unknown>, filePath: string): MapPlace | null {
    try {
      const noteTitle = getFileNameWithoutExtension(filePath, 'Unknown', /\.md$/i);

      return createMapPlaceFromProperties({
        properties: frontmatter,
        name: noteTitle,
        filePath,
        metadata: compactOverlayBlobs({ ...frontmatter }),
      });
    } catch (error) {
      logger.error('Error extracting place from frontmatter:', error);

      return null;
    }
  }

  private extractPlaceFromFile(file: TFile): MapPlace | null {
    try {
      const fileCache = this.app.metadataCache.getFileCache(file);
      const frontmatter = fileCache?.frontmatter;

      if (!frontmatter) return null;

      return this.extractPlaceFromFrontmatter(frontmatter, file.path);
    } catch (error) {
      logger.error('Error extracting place from file:', error);

      return null;
    }
  }

  async getFilesFromQuerySettings(settings: { dataview?: string; query?: string }, sourcePath: string): Promise<TFile[]> {
    if (settings.query) {
      return await this.getFilesFromVaultQuery(settings.query, sourcePath);
    } else if (settings.dataview) {
      return await this.getFilesFromDataviewQuery(settings.dataview, sourcePath);
    }

    return [];
  }

  async getFilesFromDataviewQuery(query: string, sourcePath: string): Promise<TFile[]> {
    const dataview = getDataviewAPI(this.app);

    if (!dataview) {
      throw new Error("Dataview plugin is not available");
    }

    await this.ensureDataviewReady(dataview);

    if (!query || typeof query !== 'string') {
      throw new Error("Dataview query parameter is required and must be a string");
    }

    let dqlQuery = query;

    if (!dqlQuery.startsWith("LIST")) {
      dqlQuery = "LIST \n" + query;
    }

    const result = await dataview.tryQuery(dqlQuery, sourcePath);

    if (result.type !== 'list') {
      throw new Error(`Expected a Dataview list result, received ${result.type}.`);
    }

    if (result.values.length === 0) {
      return [];
    }

    const files: TFile[] = [];

    for (const value of result.values) {
      const filePath = isRecord(value) && typeof value.path === 'string' ? value.path : undefined;

      if (!filePath) continue;
      const file = this.app.vault.getFileByPath(normalizePath(filePath));

      if (file) {
        files.push(file);
      }
    }

    return files;
  }

  // `sourcePath` resolves placeholders like {this.outgoingLinks} against that note.
  async getFilesFromVaultQuery(query: string, sourcePath?: string): Promise<TFile[]> {
    try {
      const results = await this.vaultQueryService.executeQuery(query, sourcePath);

      if (!results || results.length === 0) {
        return [];
      }

      const files: TFile[] = [];

      for (const row of results as Array<{ path?: string }>) {
        if (!row.path) {
          vaultQueryLogger.warn('Skipping row: missing required "path" column');
          continue;
        }

        const file = this.app.vault.getFileByPath(normalizePath(row.path));

        if (file) {
          files.push(file);
        }
      }

      return files;
    } catch (error) {
      throw getError(error);
    }
  }

  private async ensureDataviewReady(dataview: DataviewApiAdapter): Promise<void> {
    if (dataview.index?.initialized) return;
    if (!this.dataviewReady) this.dataviewReady = this.waitForDataviewIndex(dataview);

    await this.dataviewReady;
  }

  private waitForDataviewIndex(dataview: DataviewApiAdapter): Promise<void> {
    const startTime = Date.now();

    dataviewLogger.info('Waiting for Dataview index initialization');

    return new Promise(resolve => {
      if (dataview.index?.initialized) {
        dataviewLogger.debug('Dataview index already initialized');
        resolve();

        return;
      }

      let resolved = false;
      let refreshRef: WorkspaceEventRef | null = null;
      const resolveOnce = (ready: boolean, reason: string) => {
        if (resolved) return;
        resolved = true;
        window.clearTimeout(timeout);
        if (refreshRef) this.app.workspace.offref(refreshRef);
        const duration = Date.now() - startTime;

        if (ready) {
          dataviewLogger.info(`Index ready after ${duration}ms (${reason})`);
        } else {
          dataviewLogger.warn(`Index not ready after ${duration}ms (${reason}); proceeding with current Dataview state`);
        }

        resolve();
      };

      const timeout = window.setTimeout(() => resolveOnce(Boolean(dataview.index?.initialized), 'timeout'), DATAVIEW_INDEX_WAIT_MS);

      refreshRef = (this.app.workspace as unknown as DataviewWorkspaceEvents).on('dataview:refresh-views', () => {
        if (dataview.index?.initialized) resolveOnce(true, 'dataview:refresh-views');
      });
    });
  }
}
