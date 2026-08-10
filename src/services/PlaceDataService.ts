import { isRecord, logger, type PerformanceMonitor } from "places-shared/utils";
import { App, MarkdownPostProcessorContext, TFile, normalizePath } from "obsidian";
import { km, miles, feet, milesToKm, metersToKm, feetToMeters, Kilometers } from "places-shared/units";
import { DistanceCalculator, Coordinate, parseNamedCoordinate } from "places-shared/geo";
import { MapPlace } from "places-shared/overlay";
import { resolveMarkerIcon } from "places-shared/map";
import { extractFrontmatterTagsFromFile, normalizeFrontmatterTags } from "./PlaceTagExtractor";
import { Utilities, getError, getFileNameWithoutExtension, readNormalizedProperty, scalarToString } from "places-shared/utils";
import { TrackStyleParser } from "./TrackStyleParser";
import { createMapPlaceFromProperties } from "./MapPlaceFactory";
import { MapBlockSettings, type MapPrepareSourceTiming } from "places-shared/settings";
import { TrackDataService } from "./TrackDataService";
import { VaultQueryService } from "./VaultQueryService";
import PlacesPlugin from "../main";
import { parseLinkedPlaceReferences } from "./LinkedPlaces";
import { parseEmbeddedPlaceProperties } from "./CodeBlockParser";

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

type PlaceSourceId = 'vault-query' | 'dataview' | 'current-note' | 'linked-places' | 'embedded';

interface PlaceSourceResult {
  id: PlaceSourceId;
  places: MapPlace[];
  error?: Error;
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

// The compressed overlay blobs are tens of KB per track and would otherwise
// ride into marker data attributes, render signatures, and the refresh
// fingerprint. Style conditions only need presence, and the value collapses to
// the string 'true' (matching the SQL string-boolean contract for conditions).
const OVERLAY_BLOB_KEYS = ['Overlay Source', 'Overlay Cache'] as const;
function compactOverlayMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  for (const key of OVERLAY_BLOB_KEYS) {
    if (metadata[key] !== undefined) {
      metadata[key] = 'true';
    }
  }
  return metadata;
}

export class PlaceDataService {
  private dataviewReady: Promise<void> | null = null;
  private vaultQueryService: VaultQueryService;

  constructor(private app: App, private trackDataService: TrackDataService, vaultQueryService: VaultQueryService) {
    this.vaultQueryService = vaultQueryService;
  }

  invalidateQueryCache(): void {
    this.vaultQueryService.invalidateCache();
  }

  extractFromFrontmatter(ctx: MarkdownPostProcessorContext): Promise<MapPlace[]> {
    try {
      const file = this.app.vault.getFileByPath(normalizePath(ctx.sourcePath));
      if (!file) return Promise.resolve([]);

      const fileCache = this.app.metadataCache.getFileCache(file);
      const frontmatter = fileCache?.frontmatter;

      if (frontmatter && !frontmatter["Location"] && frontmatter["Overlay Source"]) {
        // A waypoints-only file.
        return Promise.resolve(this.extractWaypointsFromFile(file, ctx.sourcePath));
      }

      const place = this.extractPlaceFromFile(file);
      if (!place) return Promise.resolve([]);

      place.tags = extractFrontmatterTagsFromFile(this.app, ctx.sourcePath);
      if (!place.metadata) place.metadata = {};
      place.metadata.sourceFile = ctx.sourcePath;

      return Promise.resolve([place]);
    } catch (error) {
      logger.error('Error extracting from frontmatter:', error);
      return Promise.resolve([]);
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

  // Properties can be in any order and are case-insensitive, a trailing `---`
  // is optional, and the supported properties are Location, Name, icon and
  // trackStyle.
  // ```
  // ---
  // Location: 41.408, -75.662
  // icon: 🏢
  // Name: Dunder Mifflin Scranton
  // ---
  // Location: 41.573, -75.501
  // icon: 🍕
  // Name: Alfredos Pizza Cafe
  // ```
  extractFromEmbedded(source: string): MapPlace[] {
    if (!source) return [];

    const places: MapPlace[] = [];
    for (const properties of parseEmbeddedPlaceProperties(source)) {
      const locationValue = properties['location'];
      if (!locationValue) continue;

      const coord = parseNamedCoordinate(locationValue);
      if (!coord) continue;

      const { latitude, longitude } = coord;

      const place: MapPlace = {
        latitude,
        longitude,
        name: properties['name'] ?? coord.name ?? "",
        icon: resolveMarkerIcon(properties['icon'])
      };

      const embeddedTrackStyle = scalarToString(readNormalizedProperty(properties, 'trackStyle'));
      if (embeddedTrackStyle) {
        const parsed = TrackStyleParser.parseTrackStyle(embeddedTrackStyle);
        if (parsed) {
          TrackStyleParser.applyToMapPlace(place, parsed);
        }
      }

      places.push(place);
    }

    return places;
  }

  // Query sources are mutually exclusive: VaultQuery wins over Dataview. The
  // current note, explicit wikilinks, and embedded places are additive.
  async collectAllPlaces(blockSettings: MapBlockSettings, ctx: MarkdownPostProcessorContext, perf?: PerformanceMonitor, sourceTimings?: MapPrepareSourceTiming[]): Promise<MapPlace[]> {
    const sourceResults = await Promise.all(this.createPlaceSourceCollectors(blockSettings, ctx).map(async collector => {
      const started = Date.now();
      const result = await collector();
      const durationMs = Date.now() - started;
      perf?.mark('source-collected', { source: result.id, durationMs, places: result.places.length });
      // Unlike perf marks, this survives with developerMode off: the debug overlay
      // shows per-source attribution whenever a block sets `debug: true`.
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

    let places = perf
      ? perf.measure('dedupe-places', () => this.dedupePlacesByIdentity(sourceResults.flatMap(result => result.places)))
      : this.dedupePlacesByIdentity(sourceResults.flatMap(result => result.places));

    if (blockSettings.radius) {
      // Priority: location block setting > note's frontmatter Location.
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

  private createPlaceSourceCollectors(blockSettings: MapBlockSettings, ctx: MarkdownPostProcessorContext): Array<() => Promise<PlaceSourceResult>> {
    const collectors: Array<() => Promise<PlaceSourceResult>> = [];

    if (blockSettings.query) {
      collectors.push(() => this.collectQuerySource('vault-query', () => this.extractFromVaultQuery(blockSettings.query!, ctx.sourcePath)));
    } else if (blockSettings.dataview) {
      collectors.push(() => this.collectQuerySource('dataview', () => this.extractFromDataviewQuery(blockSettings.dataview!, ctx.sourcePath)));
    }

    // The current note's own Location is a fallback source, included only when
    // no explicit place source (query, dataview, linkedPlaces, embeddedPlaces)
    // is specified. Any explicit source suppresses it, even one that yields no
    // results.
    if (!blockSettings.query && !blockSettings.dataview && !blockSettings.linkedPlaces && !blockSettings.embeddedPlaces) {
      collectors.push(async () => ({
        id: 'current-note',
        places: await this.extractFromFrontmatter(ctx),
      }));
    }

    if (blockSettings.linkedPlaces) {
      collectors.push(async () => ({
        id: 'linked-places',
        places: this.extractFromLinkedPlaces(blockSettings.linkedPlaces, ctx.sourcePath),
      }));
    }

    if (blockSettings.embeddedPlaces) {
      collectors.push(async () => ({
        id: 'embedded',
        places: this.extractFromEmbedded(blockSettings.embeddedPlaces!),
      }));
    }

    return collectors;
  }

  private async collectQuerySource(id: 'vault-query' | 'dataview', collect: () => Promise<MapPlace[]>): Promise<PlaceSourceResult> {
    try {
      return { id, places: await collect() };
    } catch (error) {
      if (Utilities.isDataviewUnavailableError(error) || Utilities.isVaultQueryUnavailableError(error)) {
        return { id, places: [], error: error as Error };
      }
      throw error;
    }
  }

  extractFromLinkedPlaces(linkedPlaces: unknown, sourcePath: string): MapPlace[] {
    const places: MapPlace[] = [];

    for (const reference of parseLinkedPlaceReferences(linkedPlaces)) {
      const file = this.app.metadataCache.getFirstLinkpathDest(reference.linkpath, sourcePath);
      if (!file) {
        logger.warn('Could not resolve linked place:', reference.raw);
        continue;
      }

      const place = this.extractPlaceFromFile(file);
      if (!place) {
        logger.warn('Linked place has no Location frontmatter:', file.path);
        continue;
      }

      place.tags = extractFrontmatterTagsFromFile(this.app, file.path);
      if (!place.metadata) place.metadata = {};
      place.metadata.sourceFile = file.path;
      places.push(place);
    }

    return places;
  }

  private dedupePlacesByIdentity(places: MapPlace[]): MapPlace[] {
    const deduped = new Map<string, MapPlace>();

    for (const place of places) {
      deduped.set(this.getPlaceIdentity(place), place);
    }

    return Array.from(deduped.values());
  }

  private getPlaceIdentity(place: MapPlace): string {
    return place.filePath
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

  // `sourcePath` resolves placeholders like {this.outgoingLinks} against that note.
  async extractFromVaultQuery(query: string, sourcePath?: string): Promise<MapPlace[]> {
    return await this.vaultQueryService.extractFromQuery(query, sourcePath);
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
        // First column is always the file link in Dataview TABLE results
        const fileLink = row[0];
        const filePath = isRecord(fileLink) && typeof fileLink.path === 'string' ? fileLink.path : undefined;
        if (!filePath) continue;

        const rawFrontmatter = getCol(row, 'file.frontmatter');
        if (!isRecord(rawFrontmatter)) continue;
        const frontmatter = rawFrontmatter;

        // Place-category tags come from the frontmatter `tags:` property only; inline body
        // #hashtags (which Dataview's file.tags would fold in) are not consumed.
        const place = createMapPlaceFromProperties({
          app: this.app,
          properties: frontmatter,
          name: getFileNameWithoutExtension(filePath, 'Unknown', /\.md$/i),
          filePath,
          tags: normalizeFrontmatterTags(frontmatter['tags']),
          metadata: compactOverlayMetadata({ ...frontmatter, sourceFile: filePath }),
        });
        if (!place) continue;

        places.push(place);
      } catch {
        // Silently skip invalid rows
      }
    }

    return places;
  }

  private extractWaypointsFromFile(file: TFile, filePath: string): MapPlace[] {

    try {
      const trackData = this.trackDataService.extractTrackFromNote(file);
      const { waypoints } = trackData;

      if (!waypoints || waypoints.length === 0) return [];

      return waypoints.map(waypoint => {
        const place: MapPlace = {
          latitude: waypoint.lat,
          longitude: waypoint.lon,
          name: waypoint.name,
          icon: waypoint.symbol || "📍",
          filePath: filePath
        };

        place.tags = extractFrontmatterTagsFromFile(this.app, filePath);
        if (!place.metadata) place.metadata = {};
        place.metadata.sourceFile = filePath;

        place.metadata.isWaypoint = true;
        place.metadata.waypointDescription = waypoint.description;
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
        app: this.app,
        properties: frontmatter,
        name: noteTitle,
        filePath,
        metadata: compactOverlayMetadata({ ...frontmatter }),
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
