import { overlayDecodeCacheStats } from './OverlayDecodeCache';
import { normalizeFrontmatterTags } from "places-shared/map";
import { logger as rootLogger } from "places-shared/utils";
import { MapPlace } from "places-shared/overlay";
import { Utilities, getFileNameWithoutExtension, getErrorMessage, scalarToString, normalizePropertyName, sleep } from "places-shared/utils";
import { OverlayLoadMetrics } from "../core/OverlayLoadMetrics";
import { VaultQueryPreparingError, VaultQueryService as VaultQueryServiceBase, vaultQuerySqlError } from "./VaultQueryServiceBase";
export { VaultQueryPreparingError } from "./VaultQueryServiceBase";
import type { IVaultQueryAPI, EventRef, FileIndexedEvent, FileIndexedSource, FilesIndexedEvent, FileRemovedEvent, ProviderTablesChangedEvent } from "vaultquery/api";
import { resolveCurrentSourcePath } from "./SourcePathRenames";
import { createMapPlaceFromProperties } from "./MapPlaceFactory";
import { relationKeys, tablesForIndexedFile } from './QueryTableScope';

export interface VaultQueryPlaceResult {
  places: MapPlace[];
  errors: Array<{ path: string; error: string }>;
}

export interface QueryConversionProgress {
  onBatch?: (result: VaultQueryPlaceResult) => Promise<void>;
  isCanceled?: () => boolean;
  isPriorityPlace?: (place: MapPlace) => boolean;
}

export class QueryPreparationCanceled extends Error {
  constructor() { super('Query preparation was superseded'); }
}

const logger = rootLogger.scope('VaultQuery');

const VAULTQUERY_DATABASE_PREPARING_MESSAGE = 'Preparing VaultQuery database...';

const FRONTMATTER_INDEXING_DISABLED_MESSAGE = 'VaultQuery is not indexing frontmatter, so note properties (including Location) are unavailable to Places queries.';

// Older VaultQuery releases do not expose getCapabilities; treat those as enabled.
function isFrontmatterIndexingDisabled(api: IVaultQueryAPI): boolean {
  const capabilities = (api as unknown as { getCapabilities?: () => { indexing?: { frontmatter?: boolean } } }).getCapabilities?.();

  return capabilities?.indexing?.frontmatter === false;
}

function frontmatterIndexingDisabledError(): VaultQueryValidationError {
  return new VaultQueryValidationError(FRONTMATTER_INDEXING_DISABLED_MESSAGE, [
    {
      type: 'text',
      title: 'How to fix',
      items: ['Enable "Index frontmatter" in Settings > VaultQuery, wait for indexing to finish, then refresh this block.'],
    },
  ]);
}

export interface VaultQueryHelpSection {
  type: 'text' | 'sql';
  title: string;
  items?: string[];
  code?: string;
}

export class VaultQueryValidationError extends Error {
  constructor(message: string, public readonly helpSections: VaultQueryHelpSection[]) {
    super(message);
    this.name = 'VaultQueryValidationError';
  }
}

interface QueryConsumer {
  progress?: QueryConversionProgress;
  error?: Error;
}

interface PlaceQueryEntry {
  result: Promise<VaultQueryPlaceResult>;
  consumers: Set<QueryConsumer>;
  timestamp: number;
  bytes?: number;
}

interface QueryCacheEntry {
  results: unknown[];
  timestamp: number;
  bytes: number;
}

interface PlacesSchemaResult {
  success: boolean;
  error?: string;
  frontmatterIndexingDisabled?: boolean;
}

const QUERY_RESULT_CACHE_TTL_MS = 30 * 1000;
const QUERY_RESULT_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const QUERY_RESULT_CACHE_MAX_ENTRIES = 50;

function queryResultBytes(value: unknown): number {
  const seen = new Set<object>();
  let bytes = 0;
  const visit = (item: unknown): void => {
    if (bytes > QUERY_RESULT_CACHE_MAX_BYTES) return;

    if (typeof item === 'string') { bytes += 16 + item.length * 2;

 return; }

    if (!item || typeof item !== 'object') { bytes += 8;

 return; }

    if (Array.isArray(item) && item.length > 0 && item.every(value => typeof value === 'number')) {
      bytes += 32 + item.length * 8;

      return;
    }

    if (seen.has(item)) return;
    seen.add(item);

    if (ArrayBuffer.isView(item)) { bytes += 64 + item.buffer.byteLength;

 return; }

    if (item instanceof ArrayBuffer) { bytes += 64 + item.byteLength;

 return; }

    bytes += 64;

    if (Array.isArray(item)) {
      for (const value of item) { bytes += 8; visit(value); if (bytes > QUERY_RESULT_CACHE_MAX_BYTES) break; }

      return;
    }

    for (const key of Object.keys(item)) {
      bytes += 16 + key.length * 2;
      visit((item as Record<string, unknown>)[key]);
      if (bytes > QUERY_RESULT_CACHE_MAX_BYTES) break;
    }
  };

  visit(value);

  return bytes;
}

const INDEX_SETTLE_TIMEOUT_MS = 5000;

class ConvertedRowReuse {
  readonly next = new Map<string, MapPlace[]>();
  private readonly used = new Set<MapPlace>();
  reused = 0;

  constructor(private readonly previous: ReadonlyMap<string, readonly MapPlace[]> | undefined) {}

  take(path: string | undefined, row: Record<string, unknown>): MapPlace | undefined {
    if (!path || !this.previous) return undefined;
    const place = this.previous.get(path)?.find(candidate => !this.used.has(candidate) && candidate.queryRow !== undefined && sameColumns(row, candidate.queryRow));

    if (!place) return undefined;
    this.used.add(place);
    this.reused++;

    return place;
  }

  record(path: string | undefined, place: MapPlace): void {
    if (!path || place.overlay) return;
    const places = this.next.get(path);

    if (places) places.push(place);
    else this.next.set(path, [place]);
  }
}

function sameColumns(row: Record<string, unknown>, previous: Record<string, unknown>): boolean {
  let columns = 0;

  for (const key in row) {
    if (row[key] !== previous[key]) return false;
    columns++;
  }

  for (const key in previous) {
    if (!(key in row)) return false;
    columns--;
  }

  return columns === 0;
}

const MAX_REUSED_RESULTS = 4;

export class VaultQueryService extends VaultQueryServiceBase {
  private schemaResult: PlacesSchemaResult = { success: false };
  private queryCache: Map<string, QueryCacheEntry> = new Map();
  private placeQueries = new Map<string, PlaceQueryEntry>();
  private readonly convertedRows = new Map<string, Map<string, MapPlace[]>>();
  // Identical queries already running share one execution.
  //
  // `queryCache` only fills once a query completes, and N map blocks opening
  // together all miss it and each ran its own copy of the same SQL - on an
  // eight-map note the last block waited ~2s for rows the first already had.
  private inFlightQueries: Map<string, Promise<unknown[]>> = new Map();
  private queryScopes = new Map<string, { tables?: ReadonlySet<string> }>();
  private cacheInvalidationRef: EventRef | null = null;
  private fileRemovedRef: EventRef | null = null;
  private vaultIndexedRef: EventRef | null = null;
  private providerTablesChangedRef: EventRef | null = null;
  private fileIndexedCallbacks: Set<(paths: readonly string[], source: FileIndexedSource) => void> = new Set();
  private fileRemovedCallbacks: Set<(path: string) => void> = new Set();
  private vaultIndexedCallbacks: Set<() => void> = new Set();
  private providerTablesChangedCallbacks: Set<(tables: readonly string[]) => void> = new Set();
  private cacheExpiry: { window: Window; timer: number } | undefined;
  private queriesDisposed = false;

  protected override async onInitialized(api: IVaultQueryAPI): Promise<void> {
    await this.ensureFilesView(api);
    this.schemaResult = await this.tryCreateSchema(api);

    this.subscribeToFileIndexedEvents();
    this.subscribeToFileRemovedEvents();
    this.subscribeToVaultIndexedEvents();
    this.subscribeToProviderTablesChangedEvents();
  }

  protected override resetState(): void {
    super.resetState();
    this.schemaResult = { success: false };
    this.invalidateCache();
  }

  protected override onDatabaseLost(): void {
    // Unsubscribe before nulling the refs, letting onInitialized() re-subscribe
    // without duplicates: VaultQuery's event bus survives database recovery,
    // and the old listeners stay attached unless explicitly removed. (On older
    // VaultQuery versions the bus dies with the API and off() is a no-op.)
    const api = this.getApi();

    if (api) {
      if (this.cacheInvalidationRef) api.off(this.cacheInvalidationRef);
      if (this.fileRemovedRef) api.off(this.fileRemovedRef);
      if (this.vaultIndexedRef) api.off(this.vaultIndexedRef);
      if (this.providerTablesChangedRef) api.off(this.providerTablesChangedRef);
    }

    this.cacheInvalidationRef = null;
    this.fileRemovedRef = null;
    this.vaultIndexedRef = null;
    this.providerTablesChangedRef = null;
  }

  private async ensureFilesView(api: IVaultQueryAPI): Promise<void> {
    const existing = await api.query("SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'places_files'");

    if (existing.length) return;

    await api.execute(`CREATE VIEW IF NOT EXISTS places_files AS
      SELECT path, basename AS title, name, basename, extension, folder,
        size, created, modified, revision, indexed, content_status, content_error,
        content AS overlay_source
      FROM other_files WHERE extension IN ('gpx', 'fit', 'geojson')`);
  }

  private async tryCreateSchema(api: IVaultQueryAPI): Promise<PlacesSchemaResult> {
    if (isFrontmatterIndexingDisabled(api)) {
      return { success: false, error: FRONTMATTER_INDEXING_DISABLED_MESSAGE, frontmatterIndexingDisabled: true };
    }

    try {
      await api.execute(`CREATE INDEX IF NOT EXISTS idx_prop_location ON properties(path, value) WHERE key = 'Location'`);
    } catch (error) {
      logger.debug('Optional location index unavailable', { error });
    }

    try {
      await api.query(`SELECT 1 FROM note_properties LIMIT 1`);
    } catch (e) {
      const msg = getErrorMessage(e);

      logger.warn('note_properties table not available', msg);

      return {
        success: false,
        error: VAULTQUERY_DATABASE_PREPARING_MESSAGE
      };
    }

    if (await this.isNotePropertiesBootstrapShaped(api)) {
      if (api.getIndexingStatus().isIndexing) {
        logger.info('note_properties still has its bootstrap shape; waiting for VaultQuery to finish indexing');
      } else {
        logger.info('note_properties still has its bootstrap shape after VaultQuery indexing reported complete; waiting for schema to settle');
      }

      return {
        success: false,
        error: VAULTQUERY_DATABASE_PREPARING_MESSAGE
      };
    }

    try {
      const views = ['places', 'places_simple', 'places_tracks'];

      for (const view of views) {
        await api.execute(`DROP VIEW IF EXISTS ${view}`);
      }

      const missingOverlayColumns: string[] = [];

      for (const column of ['overlay_source', 'overlay_cache']) {
        if (!await this.notePropertiesColumnExists(api, column)) missingOverlayColumns.push(`NULL AS ${column}`);
      }

      const overlayColumns = missingOverlayColumns.length ? `, ${missingOverlayColumns.join(', ')}` : '';

      await api.execute(`CREATE VIEW IF NOT EXISTS places AS SELECT n.title AS title, np.*${overlayColumns}, n.modified AS note_modified, n.size AS note_size, (SELECT GROUP_CONCAT(value, char(10)) FROM properties p WHERE p.path = np.path AND p.key = 'tags') AS note_tags FROM note_properties np JOIN notes n ON n.path = np.path WHERE "Location" IS NOT NULL`);
      await api.execute(`CREATE VIEW IF NOT EXISTS places_simple AS SELECT np.path, n.title, "Location" as location, np.icon FROM note_properties np JOIN notes n ON n.path = np.path WHERE "Location" IS NOT NULL`);
      await api.execute(`CREATE VIEW IF NOT EXISTS places_tracks AS SELECT * FROM places`);

      this.invalidateCache();

      return { success: true };
    } catch (e) {
      logger.error('Failed to create views', e);

      return { success: false };
    }
  }

  // VaultQuery bootstraps note_properties as an EAV view over notes/properties
  // and later replaces it with the pivoted one-column-per-property view. Do not
  // detect this by selecting `key`, `value`, and `value_type`: those can also be
  // legitimate frontmatter property names in the pivoted view.
  private async isNotePropertiesBootstrapShaped(api: IVaultQueryAPI): Promise<boolean> {
    try {
      const rows = await api.query(`
        SELECT sql
        FROM sqlite_master
        WHERE type = 'view' AND name = 'note_properties'
        LIMIT 1
      `);
      const firstRow = rows?.[0] as Record<string, unknown> | undefined;
      const sql = typeof firstRow?.sql === 'string'
        ? firstRow.sql
        : typeof firstRow?.SQL === 'string'
          ? firstRow.SQL
          : undefined;

      if (!sql) {
        return false;
      }

      const normalizedSql = sql.replace(/\s+/g, ' ').toLowerCase();

      return normalizedSql.includes('from notes n left join properties p')
        && normalizedSql.includes('p.key')
        && normalizedSql.includes('p.value')
        && normalizedSql.includes('p.value_type');
    } catch {
      return false;
    }
  }

  private async notePropertiesColumnExists(api: IVaultQueryAPI, column: string): Promise<boolean> {
    try {
      await api.query(`SELECT ${column} FROM note_properties LIMIT 1`);

      return true;
    } catch {
      return false;
    }
  }

  private isPlacesViewError(error: unknown): boolean {
    const message = getErrorMessage(error);

    return /no such (table|view):\s*(?:main\.)?(?:places|places_simple|places_tracks|note_properties)\b/i.test(message);
  }

  private async recoverQuerySchema(api: IVaultQueryAPI, error: unknown): Promise<boolean> {
    const message = getErrorMessage(error);

    if (/no such (table|view):\s*(?:main\.)?other_files\b/i.test(message)) {
      throw new VaultQueryValidationError('File contents are unavailable in VaultQuery.', [{ type: 'text', title: 'Index file contents', items: ['Enable GPX, FIT and GeoJSON in VaultQuery\'s Index other file content setting, then finish indexing.'] }]);
    }

    if (/no such (table|view):\s*(?:main\.)?places_files\b/i.test(message)) {
      await this.ensureFilesView(api);

      return true;
    }

    if (!this.isPlacesViewError(error)) return false;
    this.schemaResult = await this.tryCreateSchema(api);
    if (this.schemaResult.frontmatterIndexingDisabled) throw frontmatterIndexingDisabledError();
    if (!this.schemaResult.success) throw new VaultQueryPreparingError(this.schemaResult.error ?? VAULTQUERY_DATABASE_PREPARING_MESSAGE);

    return true;
  }

  private getCacheKey(sql: string, sourcePath?: string): string {
    return JSON.stringify([sql, sourcePath ?? '']);
  }

  private trimQueryCache(): void {
    if (this.cacheExpiry) this.cacheExpiry.window.clearTimeout(this.cacheExpiry.timer);
    this.cacheExpiry = undefined;
    const now = Date.now();
    const completed = [
      ...[...this.queryCache].map(([key, entry]) => ({ key, entry, cache: this.queryCache })),
      ...[...this.placeQueries].filter(([, entry]) => entry.bytes !== undefined)
        .map(([key, entry]) => ({ key, entry, cache: this.placeQueries })),
    ].sort((a, b) => b.entry.timestamp - a.entry.timestamp);
    let bytes = 0;
    let count = 0;
    let expires = Infinity;

    for (const { key, entry, cache } of completed) {
      const size = entry.bytes!;

      if (now - entry.timestamp >= QUERY_RESULT_CACHE_TTL_MS
        || size > QUERY_RESULT_CACHE_MAX_BYTES - bytes || count >= QUERY_RESULT_CACHE_MAX_ENTRIES) {
        cache.delete(key);
      } else {
        count++;
        bytes += size;
        expires = Math.min(expires, entry.timestamp + QUERY_RESULT_CACHE_TTL_MS);
      }
    }

    if (Number.isFinite(expires)) {
      const timerWindow = activeWindow;

      this.cacheExpiry = { window: timerWindow, timer: timerWindow.setTimeout(() => this.trimQueryCache(), Math.max(1, expires - now)) };
    }

    for (const key of this.queryScopes.keys()) {
      if (!this.queryCache.has(key) && !this.placeQueries.has(key) && !this.inFlightQueries.has(key)) this.queryScopes.delete(key);
    }
  }

  invalidateCache(sourcePath?: string): void {
    this.invalidateQueryCaches(key => sourcePath === undefined || (JSON.parse(key) as string[])[1] === sourcePath);
  }

  private invalidateQueryCaches(matches: (key: string) => boolean): void {
    for (const cache of [this.queryCache, this.placeQueries, this.inFlightQueries]) {
      for (const key of cache.keys()) {
        if (matches(key)) cache.delete(key);
      }
    }

    this.trimQueryCache();
  }

  private invalidateTables(tables?: readonly string[]): void {
    if (!tables?.length) { this.invalidateCache();

 return; }

    const changed = relationKeys(tables);

    this.invalidateQueryCaches(key => {
      const reads = this.queryScopes.get(key)?.tables;

      return !reads || [...changed].some(table => reads.has(table));
    });
  }

  private rememberQueryScope(key: string, query: string): void {
    if (this.queryScopes.has(key)) return;
    const scope: { tables?: ReadonlySet<string> } = {};

    this.queryScopes.set(key, scope);
    if (query.includes('{')) return;
    void this.resolveQueryRelations(query).then(resolved => {
      if (this.queryScopes.get(key) === scope && resolved?.complete) scope.tables = relationKeys(resolved.relations);
    });
  }

  override async executeQuery(sql: string, sourcePath?: string): Promise<unknown[]> {
    sourcePath = sourcePath ? resolveCurrentSourcePath(sourcePath) : undefined;
    const api = await this.ensureQueryReady();

    this.trimQueryCache();
    const cacheKey = this.getCacheKey(sql, sourcePath);
    const cached = this.queryCache.get(cacheKey);

    if (cached) return cached.results;
    const existing = this.inFlightQueries.get(cacheKey);

    if (existing) return await existing;

    const execution = this.runQuery(api, sql, sourcePath).then(results => {
      if (this.inFlightQueries.get(cacheKey) === execution && results.length && !api.getIndexingStatus().isIndexing) {
        this.queryCache.set(cacheKey, { results, timestamp: Date.now(), bytes: queryResultBytes(results) + cacheKey.length * 2 });
        this.trimQueryCache();
      }

      return results;
    });

    this.inFlightQueries.set(cacheKey, execution);
    this.rememberQueryScope(cacheKey, sql);
    void execution.catch(() => undefined).finally(() => {
      if (this.inFlightQueries.get(cacheKey) === execution) this.inFlightQueries.delete(cacheKey);
      this.trimQueryCache();
    });

    return await execution;
  }

  private async ensureQueryReady(): Promise<IVaultQueryAPI> {
    await this.ensureReady();

    return this.getApi()!;
  }

  private async waitForIndex(api: IVaultQueryAPI): Promise<void> {
    if (api.getIndexingStatus().isIndexing) {
      try {
        await api.waitForIndexing(INDEX_SETTLE_TIMEOUT_MS);
      } catch (error) {
        if (getErrorMessage(error) !== 'Timed out waiting for indexing to complete') throw error;
        if (api.getIndexingStatus().isIndexing) throw new VaultQueryPreparingError(VAULTQUERY_DATABASE_PREPARING_MESSAGE);
      }
    }

    if (api.getIndexingStatus().isIndexing) throw new VaultQueryPreparingError(VAULTQUERY_DATABASE_PREPARING_MESSAGE);
  }

  private async runQuery(api: IVaultQueryAPI, sql: string, sourcePath?: string): Promise<unknown[]> {
    await this.waitForIndex(api);

    try {
      return await api.query(sql, sourcePath);
    } catch (error) {
      if (await this.recoverQuerySchema(api, error)) return api.query(sql, sourcePath);

      throw vaultQuerySqlError(sql, sourcePath, error);
    }
  }

  async extractFromQuery(query: string, sourcePath?: string, progress?: QueryConversionProgress): Promise<VaultQueryPlaceResult> {
    if (progress?.isCanceled?.()) throw new QueryPreparationCanceled();
    sourcePath = sourcePath ? resolveCurrentSourcePath(sourcePath) : undefined;
    this.trimQueryCache();
    const now = Date.now();
    const key = this.getCacheKey(query, sourcePath);
    const consumer: QueryConsumer = { progress };
    let entry = this.placeQueries.get(key);

    if (!entry) {
      const consumers = new Set<QueryConsumer>();
      const active = (): QueryConsumer[] => {
        if (this.queriesDisposed) consumers.clear();

        for (const item of consumers) {
          if (item.progress?.isCanceled?.()) {
            item.error = new QueryPreparationCanceled();
            consumers.delete(item);
          }
        }

        return [...consumers];
      };
      const publish = async (batch: VaultQueryPlaceResult): Promise<void> => {
        await Promise.all(active().map(async item => {
          try {
 await item.progress?.onBatch?.({ places: [...batch.places], errors: [...batch.errors] }); 
}
          catch (error) {
 item.error = error instanceof Error ? error : new Error(getErrorMessage(error)); consumers.delete(item); 
}
        }));
      };
      const result = Promise.resolve().then(() => this.extractQueryBatches(query, sourcePath, {
        isCanceled: () => active().length === 0,
        isPriorityPlace: place => active().some(item => item.progress?.isPriorityPlace?.(place)),
        get onBatch() { return active().some(item => item.progress?.onBatch) ? publish : undefined; },
      }));

      entry = { result, consumers, timestamp: now };
      this.placeQueries.set(key, entry);
      this.rememberQueryScope(key, query);
      const current = entry;

      void result.then(value => {
        if (this.placeQueries.get(key) !== current) return;
        current.timestamp = Date.now();
        current.bytes = queryResultBytes(value) + key.length * 2
        if (!value.places.length) this.placeQueries.delete(key);
        this.trimQueryCache();
      }, () => { if (this.placeQueries.get(key) === current) this.placeQueries.delete(key); this.trimQueryCache(); });
    }

    entry.consumers.add(consumer);

    try {
      const result = await entry.result;

      if (consumer.error) throw consumer.error;
      if (progress?.isCanceled?.()) throw new QueryPreparationCanceled();

      return { places: [...result.places], errors: [...result.errors] };
    } catch (error) {
 throw consumer.error ?? (error instanceof Error ? error : new Error(getErrorMessage(error))); 
}
    finally {
 entry.consumers.delete(consumer); 
}
  }

  private async extractQueryBatches(query: string, sourcePath?: string, progress?: QueryConversionProgress, schemaRetried = false): Promise<VaultQueryPlaceResult> {
    try {
      const readinessStarted = Date.now();
      const api = await this.ensureQueryReady();

      await this.waitForIndex(api);
      if (progress?.isCanceled?.()) throw new QueryPreparationCanceled();
      const readinessMs = Date.now() - readinessStarted;
      const controller = new AbortController();
      const iterator = api.iterateQueryBatches(query, sourcePath, { signal: controller.signal, snapshot: true });
      let sqlMs = 0;
      let resultRows = 0;
      const resultBatches = (async function* () {
        try {
          while (true) {
            if (progress?.isCanceled?.()) throw new QueryPreparationCanceled();
            const started = performance.now();
            const timerWindow = activeWindow;
            const timer = progress?.isCanceled ? timerWindow.setInterval(() => {
              if (progress.isCanceled?.()) controller.abort();
            }, 50) : undefined;
            let batch: IteratorResult<unknown[]>;

            try {
 batch = await iterator.next(); 
}
            finally {
 if (timer !== undefined) timerWindow.clearInterval(timer); 
}

            sqlMs += performance.now() - started;
            if (batch.done) return;
            resultRows += batch.value.length;
            yield batch.value;
          }
        } finally {
 controller.abort();

 await iterator.return?.(); 
}
      })();
      const metrics = new OverlayLoadMetrics();
      const reuseKey = `${sourcePath ?? ''}\u0001${query}`;
      const reuse = new ConvertedRowReuse(this.convertedRows.get(reuseKey));
      const convertStarted = performance.now();
      let batches = 0;
      let publishMs = 0;
      let firstBatchMs: number | undefined;
      let converted: VaultQueryPlaceResult | undefined;
      let conversionCanceled = false;
      let cancellationReason: string | undefined;
      let queryInvalidated = false;
      let conversionComplete = false;

      try {
        converted = await this.convertResultsToPlaces(resultBatches, metrics, {
          isCanceled: progress?.isCanceled,
          isPriorityPlace: progress?.isPriorityPlace,
          onBatch: progress?.onBatch ? async batch => {
            const started = performance.now();

            await progress.onBatch!(batch);
            publishMs += performance.now() - started;
            firstBatchMs ??= performance.now() - convertStarted;
            batches++;
          } : undefined,
        }, reuse);
        conversionComplete = true;
        this.convertedRows.delete(reuseKey);
        this.convertedRows.set(reuseKey, reuse.next);
        while (this.convertedRows.size > MAX_REUSED_RESULTS) this.convertedRows.delete(this.convertedRows.keys().next().value!);

        return converted;
      } catch (error) {
        conversionCanceled = error instanceof QueryPreparationCanceled || progress?.isCanceled?.() === true;
        queryInvalidated = error instanceof Error && error.name === 'QueryIterationInvalidatedError';
        cancellationReason = conversionCanceled ? 'consumer-canceled' : queryInvalidated ? 'index-changed' : undefined;

        throw error;
      } finally {
        const convertMs = performance.now() - convertStarted;
        const mirrorStatus = this.getApi()?.getQueryMirrorStatus?.() ?? { active: false, reason: 'VaultQuery is unavailable' };

        rootLogger.scope('Performance').debug('[Places Performance] vault-query timings', {
          sourcePath, readinessMs, sqlMs, convertMs,
          activeMs: convertMs - sqlMs - metrics.yieldMs, yieldMs: metrics.yieldMs, maxRowMs: metrics.maxRowMs,
          batches, publishMs, firstBatchMs,
          rows: resultRows, reusedRows: reuse.reused, places: converted?.places.length ?? 0,
          conversionFailed: !conversionComplete && !conversionCanceled && !queryInvalidated, conversionCanceled, queryInvalidated,
          ...(cancellationReason ? { cancellationReason } : {}),
          counts: metrics.counts, phaseMs: metrics.phaseMs, phaseFailures: metrics.phaseFailures,
          sqlOffThread: mirrorStatus.active, conversionThread: 'main', overlayCache: overlayDecodeCacheStats(),
          ...(mirrorStatus.reason ? { mirrorReason: mirrorStatus.reason } : {}),
        });
      }
    } catch (error) {
      if (progress?.isCanceled?.()) throw new QueryPreparationCanceled();
      if (error instanceof Error && error.name === 'QueryIterationInvalidatedError') throw new VaultQueryPreparingError('The index changed while loading places. Waiting to reload.');

      if (Utilities.isVaultQueryUnavailableError(error) || error instanceof VaultQueryValidationError || error instanceof VaultQueryPreparingError || error instanceof QueryPreparationCanceled) {
        throw error;
      }

      const api = this.getApi();

      if (!schemaRetried && api && await this.recoverQuerySchema(api, error)) return this.extractQueryBatches(query, sourcePath, progress, true);

      throw vaultQuerySqlError(query, sourcePath, error);
    }
  }

  private normalizeRow(rawRow: unknown): Record<string, unknown> {
    const row = rawRow as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(row)) {
      const columnKey = key.replace(/:\d+$/, '');
      const optionPath = columnKey.match(/^(popup\.content(?:\.\d+)?\.options\.)(.+)$/i);
      const normalKey = optionPath ? optionPath[1].toLowerCase() + optionPath[2] : columnKey.toLowerCase();

      if (!(normalKey in normalized) || normalized[normalKey] == null) normalized[normalKey] = value;
    }

    return normalized;
  }

  private validateColumns(results: Record<string, unknown>[]): void {
    if (results.length === 0) return;

    const columns = Object.keys(results[0]);
    const missing: string[] = [];

    if (!columns.some(key => ['location', 'overlaysource', 'overlaycache'].includes(normalizePropertyName(key)))) missing.push('Location or Overlay Source');

    if (missing.length > 0) {
      throw new VaultQueryValidationError(
        `Missing required column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`,
        [
          {
            type: 'text',
            title: 'Required columns',
            items: [
              'Location - latitude, longitude; or Overlay Source / Overlay Cache containing drawable geometry.'
            ]
          },
          {
            type: 'text',
            title: 'Optional columns',
            items: [
              'title - marker label (defaults to filename)',
              'icon - marker icon (defaults to 📍 when omitted)',
              'path - identifies the source and links to it; file contents must be returned in Overlay Source',
              '"Overlay Source" - original overlay text or bytes (including GPX, FIT and GeoJSON); compressed text is also supported',
              '"Overlay Cache" - precomputed GeoJSON for faster rendering',
              'Setting columns - quote paths such as "track.colorBy", "track.defaultVisibility", "popup.content.options.templateFile", or labelTemplate; query rows override note properties, then the block',
              'Other data columns - available to templates and style conditions; scalar values can become CSS data attributes'
            ]
          },
          {
            type: 'sql',
            title: 'Use the built-in view (includes all properties)',
            code: 'SELECT * FROM places_files'
          }
        ]
      );
    }
  }

  private async convertResultsToPlaces(results: AsyncIterable<unknown[]>, metrics: OverlayLoadMetrics, progress: QueryConversionProgress | undefined, reuse: ConvertedRowReuse): Promise<VaultQueryPlaceResult> {
    const places: MapPlace[] = [];
    const errors: VaultQueryPlaceResult['errors'] = [];

    const WORK_BUDGET_MS = 8;
    let budgetStarted = performance.now();
    let processed = 0;
    let submitted = 0;
    let submittedAt = performance.now();
    let submittedChars = 0;
    let conversionSinceSubmission = 0;
    let publicationDelayMs = 50;
    let conversionBudgetMs = 100;
    let decodedBudgetChars = 2 * 1024 * 1024;
    let hasTrack = false;
    let submittedTrack = false;
    let hasPriorityTrack = false;
    let submittedPriorityTrack = false;

    for await (const batch of results) {
      budgetStarted = performance.now();

      for (const rawRow of batch) {
        if (progress?.isCanceled?.()) throw new QueryPreparationCanceled();
        const elapsedSinceSubmission = performance.now() - submittedAt;
        const firstPriorityTrack = hasPriorityTrack && !submittedPriorityTrack;

        if (progress?.onBatch && places.length > submitted
          && ((elapsedSinceSubmission >= publicationDelayMs || conversionSinceSubmission >= conversionBudgetMs)
            || (hasTrack && !submittedTrack && elapsedSinceSubmission >= 50)
            || (firstPriorityTrack && elapsedSinceSubmission >= 50)
            || metrics.counts.decodedChars + metrics.counts.binaryBytes - submittedChars >= decodedBudgetChars)) {
          const submittedStarted = performance.now();

          await progress.onBatch({ places: [...places], errors: [...errors] });
          const publicationMs = performance.now() - submittedStarted;

          publicationDelayMs = Math.min(1000, Math.max(publicationDelayMs * (firstPriorityTrack ? 4 : 2), publicationMs * 2));
          conversionBudgetMs = firstPriorityTrack ? 200 : 100;

          if (metrics.counts.decodedChars + metrics.counts.binaryBytes > submittedChars) {
            conversionBudgetMs = Math.min(400, Math.max(conversionBudgetMs, publicationMs));
          }

          decodedBudgetChars = 2 * 1024 * 1024 * conversionBudgetMs / 100;
          await sleep(0);
          budgetStarted = performance.now();
          metrics.yieldMs += budgetStarted - submittedStarted;
          submittedAt = budgetStarted;
          conversionSinceSubmission = 0;
          submittedChars = metrics.counts.decodedChars + metrics.counts.binaryBytes;
          submitted = places.length;
          submittedTrack = hasTrack;
          submittedPriorityTrack = hasPriorityTrack;
          if (progress.isCanceled?.()) throw new QueryPreparationCanceled();
        }

        if (processed > 0 && performance.now() - budgetStarted >= WORK_BUDGET_MS) {
          const yieldedAt = performance.now();

          await sleep(0);
          budgetStarted = performance.now();
          metrics.yieldMs += budgetStarted - yieldedAt;
          metrics.counts.yields++;
          if (progress?.isCanceled?.()) throw new QueryPreparationCanceled();
        }

        const rowStarted = performance.now();

        metrics.counts.processedRows++;
        const row = metrics.measure('normalize', () => this.normalizeRow(rawRow));

        if (processed++ === 0) this.validateColumns([row]);
        const reusedPath = typeof row.path === 'string' && row.path.trim() ? row.path : undefined;
        const previous = reuse.take(reusedPath, row);

        if (previous) {
          places.push(previous);
          reuse.record(reusedPath, previous);
          const rowMs = performance.now() - rowStarted;

          conversionSinceSubmission += rowMs;
          metrics.maxRowMs = Math.max(metrics.maxRowMs, rowMs);
          continue;
        }

        try {
          const path = reusedPath;
          const name = this.extractName(row.title ?? row.name, path);
          const tags: unknown = row.note_tags ?? row.tags;
          const metadata: Record<string, unknown> = path ? { sourceFile: path } : {};

          Object.assign(metadata, row);
          const noteProperties = path ? this.app.metadataCache?.getCache(path)?.frontmatter : undefined;
          const place = metrics.measure('place', () => createMapPlaceFromProperties({ properties: row, queryRow: row, noteProperties, name, filePath: path, tags: normalizeFrontmatterTags(tags), metadata, metrics }));

          if (!place) {
            metrics.counts.skippedRows++;
            errors.push({ path: path ?? name, error: 'No valid Location or overlay contents. Include overlay_source to draw a file.' });
            continue;
          }

          places.push(place);
          reuse.record(path, place);
          hasTrack ||= Boolean(place.overlay?.geojson);
          if (place.overlay?.geojson && !hasPriorityTrack) hasPriorityTrack = progress?.isPriorityPlace?.(place) === true;
        } catch (error) {
          metrics.counts.rowFailures++;
          errors.push({
            path: scalarToString(row.path ?? row.title) || `Query row ${processed}`,
            error: getErrorMessage(error),
          });
        } finally {
          const rowMs = performance.now() - rowStarted;

          conversionSinceSubmission += rowMs;
          metrics.maxRowMs = Math.max(metrics.maxRowMs, rowMs);
        }
      }
    }

    if (progress?.isCanceled?.()) throw new QueryPreparationCanceled();

    return { places, errors };
  }

  private extractName(title: unknown, path?: string): string {
    if (title) {
      return scalarToString(title, 'Unknown');
    }

    if (!path) {
      return 'Unknown';
    }

    return getFileNameWithoutExtension(path, 'Unknown', /\.[^/.]+$/);
  }

  private subscribeToFileIndexedEvents(): void {
    if (this.cacheInvalidationRef) return;

    const api = this.getApi();

    if (!api) return;

    try {
      this.cacheInvalidationRef = api.on('files-indexed', (event: FilesIndexedEvent) => {
        this.notifyFileIndexed(event.paths, event.source ?? 'note');
      });

      return;
    } catch (error) {
      logger.debug('VaultQuery has no batched index event; using the per-path event', { error });
    }

    this.cacheInvalidationRef = api.on('file-indexed', (event: FileIndexedEvent) => {
      this.notifyFileIndexed([event.path], event.source ?? 'note');
    });
  }

  private notifyFileIndexed(paths: readonly string[], source: FileIndexedSource): void {
    this.invalidateTables(source === 'note' ? undefined
      : [...new Set(paths.flatMap(path => tablesForIndexedFile(source, path) ?? []))]);

    for (const byPath of this.convertedRows.values()) {
      for (const path of paths) byPath.delete(path);
    }

    for (const callback of this.fileIndexedCallbacks) {
      try {
        callback(paths, source);
      } catch (error) {
        logger.error('Error in file-indexed callback', error);
      }
    }
  }

  // Deletions mirror file-indexed: invalidate the query cache first, then notify: refresh callbacks re-query fresh data.
  private subscribeToFileRemovedEvents(): void {
    if (this.fileRemovedRef) return;

    const api = this.getApi();

    if (!api) return;

    this.fileRemovedRef = api.on('file-removed', (event: FileRemovedEvent) => {
      this.invalidateCache();

      for (const callback of this.fileRemovedCallbacks) {
        try {
          callback(event.path);
        } catch (error) {
          logger.error('Error in file-removed callback', error);
        }
      }
    });
  }

  private subscribeToVaultIndexedEvents(): void {
    if (this.vaultIndexedRef) return;

    const api = this.getApi();

    if (!api) return;

    this.vaultIndexedRef = api.on('vault-indexed', () => {
      this.invalidateCache();

      for (const callback of this.vaultIndexedCallbacks) {
        try {
          callback();
        } catch (error) {
          logger.error('Error in vault-indexed callback', error);
        }
      }
    });
  }

  private subscribeToProviderTablesChangedEvents(): void {
    if (this.providerTablesChangedRef) return;

    const api = this.getApi();

    if (!api) return;

    this.providerTablesChangedRef = api.on('provider-tables-changed', (event: ProviderTablesChangedEvent) => {
      this.invalidateTables(event.tables);

      logger.debug('Provider tables changed', {
        providerId: event.providerId,
        definitionId: event.definitionId,
        tables: event.tables,
      });

      for (const callback of this.providerTablesChangedCallbacks) {
        try {
          callback(event.tables ?? []);
        } catch (error) {
          logger.error('Error in provider-tables-changed callback', error);
        }
      }
    });
  }

  async resolveQueryRelations(query: string): Promise<{ relations: string[]; complete: boolean } | null> {
    const api = this.getApi();

    if (!api || typeof api.getQueryRelations !== 'function') return null;

    try {
      return await api.getQueryRelations(query);
    } catch (error) {
      logger.debug('Could not resolve query relations', { error });

      return null;
    }
  }

  onFileIndexed(callback: (paths: readonly string[], source: FileIndexedSource) => void): () => void {
    this.fileIndexedCallbacks.add(callback);

    this.subscribeToFileIndexedEvents();

    return () => {
      this.fileIndexedCallbacks.delete(callback);
    };
  }

  // Register a callback for file-removed events (a deleted note dropped from the index). Same cache-first ordering and pre-init queueing as onFileIndexed.
  onFileRemoved(callback: (path: string) => void): () => void {
    this.fileRemovedCallbacks.add(callback);
    this.subscribeToFileRemovedEvents();

    return () => {
      this.fileRemovedCallbacks.delete(callback);
    };
  }

  onVaultIndexed(callback: () => void): () => void {
    this.vaultIndexedCallbacks.add(callback);
    this.subscribeToVaultIndexedEvents();

    return () => {
      this.vaultIndexedCallbacks.delete(callback);
    };
  }

  onProviderTablesChanged(callback: (tables: readonly string[]) => void): () => void {
    this.providerTablesChangedCallbacks.add(callback);
    this.subscribeToProviderTablesChangedEvents();

    return () => {
      this.providerTablesChangedCallbacks.delete(callback);
    };
  }

  override cleanup(): void {
    this.queriesDisposed = true;
    this.onDatabaseLost();
    this.fileIndexedCallbacks.clear();
    this.fileRemovedCallbacks.clear();
    this.vaultIndexedCallbacks.clear();
    this.providerTablesChangedCallbacks.clear();
    for (const entry of this.placeQueries.values()) entry.consumers.clear();
    this.invalidateCache();

    super.cleanup();
  }
}
