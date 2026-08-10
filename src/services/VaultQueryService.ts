import { logger as rootLogger } from "places-shared/utils";
import { normalizePath, TFile } from "obsidian";
import { MapPlace } from "places-shared/overlay";
import { Utilities, getFileNameWithoutExtension, getErrorMessage, scalarToString } from "places-shared/utils";
import { VaultQueryPreparingError, VaultQueryService as VaultQueryServiceBase } from "./VaultQueryServiceBase";
export { VaultQueryPreparingError } from "./VaultQueryServiceBase";
import type { IVaultQueryAPI, EventRef, FileIndexedEvent, FileRemovedEvent, NoteSource, ProviderTablesChangedEvent } from "vaultquery/api";
import { createMapPlaceFromProperties } from "./MapPlaceFactory";

const logger = rootLogger.scope('VaultQuery');

type ConsistentVaultQueryAPI = Omit<IVaultQueryAPI, 'isIndexSettled' | 'getIndexGeneration' | 'whenIndexSettled'> & {
  isIndexSettled?: () => boolean;
  getIndexGeneration?: () => number;
  whenIndexSettled?: (timeoutMs?: number) => Promise<void>;
};

function isIndexSettled(api: IVaultQueryAPI): boolean {
  const extended = api as ConsistentVaultQueryAPI;
  return extended.isIndexSettled?.() ?? !api.getIndexingStatus().isIndexing;
}

function getIndexGeneration(api: IVaultQueryAPI): number | undefined {
  return (api as ConsistentVaultQueryAPI).getIndexGeneration?.();
}

async function waitForSettledIndex(api: IVaultQueryAPI, timeoutMs: number): Promise<void> {
  const extended = api as ConsistentVaultQueryAPI;
  if (extended.whenIndexSettled) await extended.whenIndexSettled(timeoutMs);
  else await api.waitForIndexing(timeoutMs);
}

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

const KNOWN_COLUMNS = new Set([
  'path', 'title', 'note_tags', 'location', 'icon',
  'overlay_source', 'overlay_cache',
  'trackdefaultvisibility', 'trackcolorby', 'trackstyle',
  'content', 'modified', 'note_modified', 'note_size'
]);

interface QueryCacheEntry {
  results: unknown[];
  timestamp: number;
}

interface PlacesSchemaResult {
  success: boolean;
  error?: string;
  frontmatterIndexingDisabled?: boolean;
}

const QUERY_RESULT_CACHE_TTL_MS = 30 * 1000;
// Rename events can refresh blocks while Obsidian still passes the pre-rename
// source path through MarkdownPostProcessorContext. Keep that mapping only long
// enough for already-queued refreshes to resolve their `{this.*}` placeholders.
const RECENT_RENAME_GRACE_MS = 5 * 1000;
const INDEX_SETTLE_TIMEOUT_MS = 5000;

function toTagList(tags: unknown): string[] {
  if (Array.isArray(tags)) return tags.map(tag => String(tag).replace(/^#/, '').trim()).filter(Boolean);
  if (typeof tags === 'string') return tags.split(/[,\s]+/).map(tag => tag.replace(/^#/, '').trim()).filter(Boolean);
  return [];
}

export class VaultQueryService extends VaultQueryServiceBase {
  private schemaResult: PlacesSchemaResult = { success: false };
  private queryCache: Map<string, QueryCacheEntry> = new Map();
  // Identical queries already running share one execution.
  //
  // `queryCache` only fills once a query completes, and N map blocks opening
  // together all miss it and each ran its own copy of the same SQL - on an
  // eight-map note the last block waited ~2s for rows the first already had.
  private inFlightQueries: Map<string, Promise<unknown[]>> = new Map();
  private cacheInvalidationRef: EventRef | null = null;
  private fileRemovedRef: EventRef | null = null;
  private vaultIndexedRef: EventRef | null = null;
  private providerTablesChangedRef: EventRef | null = null;
  private fileIndexedCallbacks: Set<(path: string) => void> = new Set();
  private fileRemovedCallbacks: Set<(path: string) => void> = new Set();
  private vaultIndexedCallbacks: Set<() => void> = new Set();
  private providerTablesChangedCallbacks: Set<() => void> = new Set();
  private renameMap: Map<string, { newPath: string; timestamp: number }> = new Map();

  protected override async onInitialized(api: IVaultQueryAPI): Promise<void> {
    this.schemaResult = await this.tryCreateSchema(api);

    this.subscribeToFileIndexedEvents();
    this.subscribeToFileRemovedEvents();
    this.subscribeToVaultIndexedEvents();
    this.subscribeToProviderTablesChangedEvents();
  }

  protected override resetState(): void {
    super.resetState();
    this.schemaResult = { success: false };
    this.queryCache.clear();
    this.inFlightQueries.clear();
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

  // Logs warnings on failure rather than throwing; the result carries the message shown to the user.
  private async tryCreateSchema(api: IVaultQueryAPI): Promise<PlacesSchemaResult> {
    if (isFrontmatterIndexingDisabled(api)) {
      return { success: false, error: FRONTMATTER_INDEXING_DISABLED_MESSAGE, frontmatterIndexingDisabled: true };
    }

    try {
      await api.execute(`CREATE INDEX IF NOT EXISTS idx_prop_location ON properties(path, value) WHERE key = 'Location'`);
    } catch { /* Index creation may not be supported */ }

    // On mobile the base table may not exist yet.
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

    // An individual view failure would indicate a systemic issue; one try/catch covers all of them.
    try {
      const views = ['places', 'places_simple', 'places_tracks'];
      for (const view of views) {
        await api.execute(`DROP VIEW IF EXISTS ${view}`);
      }

      // note_properties has one lowercase column per scalar frontmatter key but no title, and the
      // note name comes from a notes join. `title` means the note's own title in every view,
      // matching VaultQuery's `notes.title`. It is selected FIRST: SQLite keeps the first of two
      // same-named view columns and renames the second, and a frontmatter `title` property in
      // `np.*` surfaces as `"title:1"` instead of shadowing the note title.
      //
      // `note_tags` is the note's FRONTMATTER `tags:` property (place categories), read straight
      // from the `properties` table where array-valued tags live one row per element. The pivoted
      // np.* drops array-valued keys, and this correlated scalar subquery - one aggregate per note
      // (no fan-out), an index seek on the properties PK (path,key), evaluated only for rows past
      // the WHERE - supplies the full set without a per-place metadataCache read. Deliberately
      // frontmatter-only: inline body `#hashtags` (the separate `tags` table) are document
      // content, not place categories, and are excluded.
      //
      // `note_modified`/`note_size` are the note's stat (mtime + byte size), prefixed to dodge a
      // frontmatter `modified:`/`size:` in np.*. They let the overlay-decode
      // cache key off the row instead of a per-place vault.getFileByPath - and since they come from
      // the same indexed snapshot as overlay_source/overlay_cache, the key tracks the data it keys.
      await api.execute(`CREATE VIEW IF NOT EXISTS places AS SELECT n.title AS title, np.*, n.modified AS note_modified, n.size AS note_size, (SELECT GROUP_CONCAT(value, char(10)) FROM properties p WHERE p.path = np.path AND p.key = 'tags') AS note_tags FROM note_properties np JOIN notes n ON n.path = np.path WHERE "Location" IS NOT NULL`);
      await api.execute(`CREATE VIEW IF NOT EXISTS places_simple AS SELECT np.path, n.title, "Location" as location, np.icon FROM note_properties np JOIN notes n ON n.path = np.path WHERE "Location" IS NOT NULL`);
      // Overlay columns only exist when some note has overlay frontmatter;
      // substitute NULL otherwise for the view to still create.
      const overlaySource = (await this.notePropertiesColumnExists(api, 'overlay_source')) ? 'np.overlay_source' : 'NULL';
      const overlayCache = (await this.notePropertiesColumnExists(api, 'overlay_cache')) ? 'np.overlay_cache' : 'NULL';
      await api.execute(`CREATE VIEW IF NOT EXISTS places_tracks AS SELECT np.path, n.title, "Location" as location, np.icon, n.modified AS note_modified, n.size AS note_size, ${overlaySource} as overlay_source, ${overlayCache} as overlay_cache FROM note_properties np JOIN notes n ON n.path = np.path WHERE "Location" IS NOT NULL`);

      // Results cached while the views were missing or stale must not outlive
      // the schema change.
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
    return /no such (table|view):\s*places/i.test(message);
  }

  private getCacheKey(sql: string, sourcePath?: string): string {
    return `${sql}|${sourcePath || ''}`;
  }

  private isQueryCacheFresh(entry: QueryCacheEntry, now: number): boolean {
    return now - entry.timestamp < QUERY_RESULT_CACHE_TTL_MS;
  }

  private isRecentRename(timestamp: number, now: number = Date.now()): boolean {
    return now - timestamp <= RECENT_RENAME_GRACE_MS;
  }

  // Called when files are indexed.
  invalidateCache(): void {
    this.queryCache.clear();
    // In-flight queries were issued against the pre-invalidation index; drop them:
    // callers arriving after the change start a fresh execution rather than
    // joining one whose results are already known to be stale.
    this.inFlightQueries.clear();
  }

  // Register a file rename, letting queries find files even when ctx.sourcePath
  // contains the old (stale) path immediately after a rename.
  registerRename(oldPath: string, newPath: string): void {
    const now = Date.now();
    for (const [path, entry] of this.renameMap) {
      if (!this.isRecentRename(entry.timestamp, now)) {
        this.renameMap.delete(path);
      }
    }
    this.renameMap.set(oldPath, { newPath, timestamp: now });
  }

  // Falls back to the rename map: ctx.sourcePath can be stale after a rename.
  private getFileByPath(sourcePath: string): TFile | null {
    let file = this.app.vault.getAbstractFileByPath(normalizePath(sourcePath));
    if (file instanceof TFile) {
      return file;
    }

    const renameEntry = this.renameMap.get(sourcePath);
    if (renameEntry) {
      if (this.isRecentRename(renameEntry.timestamp)) {
        file = this.app.vault.getAbstractFileByPath(normalizePath(renameEntry.newPath));
        if (file instanceof TFile) {
          return file;
        }
      } else {
        this.renameMap.delete(sourcePath);
      }
    }

    return null;
  }

  // Results are briefly cached for duplicate render passes; file/index events
  // invalidate the cache before freshness becomes a correctness boundary.
  override async executeQuery(sql: string, sourcePath?: string): Promise<unknown[]> {
    await this.ensureReady();

    const api = this.getApi()!;

    if (!this.schemaResult.success) {
      // The schema may have been deferred because VaultQuery was still
      // indexing (note_properties not pivoted yet). Re-probe before failing.
      this.schemaResult = await this.tryCreateSchema(api);
      if (!this.schemaResult.success) {
        if (this.schemaResult.frontmatterIndexingDisabled) {
          throw frontmatterIndexingDisabledError();
        }
        throw new VaultQueryPreparingError(this.schemaResult.error ?? VAULTQUERY_DATABASE_PREPARING_MESSAGE);
      }
    }

    const cacheKey = this.getCacheKey(sql, sourcePath);
    const cached = this.queryCache.get(cacheKey);
    const now = Date.now();

    if (cached && this.isQueryCacheFresh(cached, now)) {
      return cached.results;
    }

    // Only share while the index is settled. Mid-index, a transient empty result
    // is exactly the failure this service defends against, and sharing one
    // execution would spread it to every block at once instead of letting each
    // re-query. During indexing the independent runs are deliberately kept.
    if (!isIndexSettled(api)) {
      return await this.runQuery(api, sql, sourcePath, cacheKey, now);
    }

    const existing = this.inFlightQueries.get(cacheKey);
    if (existing) return await existing;

    const execution = this.runQuery(api, sql, sourcePath, cacheKey, now);
    this.inFlightQueries.set(cacheKey, execution);
    // Released when the query settles, never by a caller: nothing strands the
    // others. The swallowed catch keeps this cleanup chain unhandled-safe; every
    // caller still awaits `execution` itself and sees its rejection.
    void execution.catch(() => undefined).finally(() => {
      if (this.inFlightQueries.get(cacheKey) === execution) this.inFlightQueries.delete(cacheKey);
    });
    return await execution;
  }

  // The execute-and-recover path shared by coalesced callers.
  private async runQuery(api: IVaultQueryAPI, sql: string, sourcePath: string | undefined, cacheKey: string, now: number): Promise<unknown[]> {
    try {
      return await this.executeQueryWithRetry(api, sql, sourcePath, cacheKey, now);
    } catch (error) {
      if (this.isPlacesViewError(error) && !this.schemaResult.success) {
        logger.debug('Places view not found, attempting to create views...');
        this.schemaResult = await this.tryCreateSchema(api);
        if (this.schemaResult.success) {
          try {
            return await this.executeQueryWithRetry(api, sql, sourcePath, cacheKey, now);
          } catch (retryError) {
            throw new Error("VaultQuery SQL error: " + getErrorMessage(retryError));
          }
        }
        if (this.schemaResult.frontmatterIndexingDisabled) {
          throw frontmatterIndexingDisabledError();
        }
        if (this.schemaResult.error) {
          throw new VaultQueryPreparingError(this.schemaResult.error);
        }
      }
      throw new Error("VaultQuery SQL error: " + getErrorMessage(error));
    }
  }

  private async executeQueryWithRetry(api: IVaultQueryAPI, sql: string, sourcePath: string | undefined, cacheKey: string, now: number): Promise<unknown[]> {
    // Only a TFile, never a string path: from a string, VaultQuery resolves
    // placeholders like {this.outgoingLinks} against the wrong note.
    const context = sourcePath ? ((this.getFileByPath(sourcePath) ?? undefined) as NoteSource | undefined) : undefined;

    const results = await this.querySettledConsistent(api, sql, context, sourcePath);

    // Empty results are never cached: if the emptiness was transient after
    // all, the next refresh heals immediately instead of serving the cached
    // empty set for the full TTL.
    if (results.length === 0) {
      this.queryCache.delete(cacheKey);
    } else if (isIndexSettled(api)) {
      this.queryCache.set(cacheKey, { results, timestamp: now });
    } else {
      logger.debug('Skipping VaultQuery result cache while index changes are pending');
    }

    if (this.queryCache.size > 50) {
      for (const [key, entry] of this.queryCache) {
        if (!this.isQueryCacheFresh(entry, now)) {
          this.queryCache.delete(key);
        }
      }
    }

    return results;
  }

  // Query against one settled index generation.
  //
  // Non-empty results can be stale too: self-referencing expressions such as
  // `{this.outgoingLinks}` may return the same rows with changed computed columns.
  // If indexing was active or its generation changed while the query ran, wait and
  // execute once more rather than accepting a partially updated snapshot.
  private async querySettledConsistent(api: IVaultQueryAPI, sql: string, context: NoteSource | undefined, sourcePath: string | undefined): Promise<unknown[]> {
    const settledBefore = isIndexSettled(api);
    const generationBefore = getIndexGeneration(api);
    const results = await api.query(sql, context) || [];
    if (settledBefore && isIndexSettled(api) && getIndexGeneration(api) === generationBefore) {
      return results;
    }

    logger.debug('VaultQuery result raced index changes; requerying after settle', { sourcePath, sql, rows: results.length });
    await waitForSettledIndex(api, INDEX_SETTLE_TIMEOUT_MS);
    return await api.query(sql, context) || [];
  }

  async extractFromQuery(query: string, sourcePath?: string): Promise<MapPlace[]> {
    if (!query.trim().match(/select/i)) {
      throw new Error(`VaultQuery requires a SELECT statement. Example: SELECT * FROM places`);
    }

    try {
      const sqlStarted = Date.now();
      const results = await this.executeQuery(query, sourcePath);
      const sqlMs = Date.now() - sqlStarted;
      const convertStarted = Date.now();
      const places = await this.convertResultsToPlaces(results);
      const api = this.getApi();
      const mirrorStatus = api?.getQueryMirrorStatus?.() ?? { active: false, reason: 'VaultQuery is unavailable' };
      rootLogger.scope('Performance').debug('[Places Performance] vault-query timings', { sqlMs, convertMs: Date.now() - convertStarted, rows: results.length, offThread: mirrorStatus.active, ...(mirrorStatus.reason ? { mirrorReason: mirrorStatus.reason } : {}) });
      return places;
    } catch (error) {
      if (Utilities.isVaultQueryUnavailableError(error) || error instanceof VaultQueryValidationError || error instanceof VaultQueryPreparingError) {
        throw error;
      }
      throw new Error(getErrorMessage(error));
    }
  }

  // Lower-case column keys, mapping arbitrary user-query aliases (e.g. `... AS isLinked`) to
  // predictable, case-insensitive metadata keys. VaultQuery already folds case-variant frontmatter
  // keys into a single lowercase column, and the built-in `places` views do not self-collide:
  // duplicate-named columns only arise from a user's own SQL, merged with first-non-null
  // (COALESCE), stripping the `:N` suffix SQLite adds to disambiguate them.
  private normalizeColumns(results: unknown[]): Record<string, unknown>[] {
    if (!results || results.length === 0) return [];

    return results.map(rawRow => {
      const row = rawRow as Record<string, unknown>;
      const normalized: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(row)) {
        const normalKey = key.replace(/:\d+$/, '').toLowerCase();

        if (!(normalKey in normalized) || normalized[normalKey] == null) {
          normalized[normalKey] = value;
        }
      }

      return normalized;
    });
  }

  // Throws VaultQueryValidationError carrying structured help.
  private validateColumns(results: Record<string, unknown>[]): void {
    if (results.length === 0) return;

    const columns = Object.keys(results[0]);
    const missing: string[] = [];

    if (!columns.includes('location')) missing.push('location');

    if (missing.length > 0) {
      throw new VaultQueryValidationError(
        `Missing required column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`,
        [
          {
            type: 'text',
            title: 'Required columns',
            items: [
              'Location - coordinate string (for map placement)'
            ]
          },
          {
            type: 'text',
            title: 'Optional columns',
            items: [
              'title - marker label (defaults to filename)',
              'icon - marker icon (defaults to frontmatter icon, then 📍)',
              'path - note file path (links marker to a note when present)',
              '"Overlay Source" - compressed original overlay data (GPX, GeoJSON, CSV)',
              '"Overlay Cache" - precomputed GeoJSON for faster rendering',
              'Any other property - available as CSS data attribute'
            ]
          },
          {
            type: 'sql',
            title: 'Use the built-in view (includes all properties)',
            code: 'SELECT * FROM places'
          }
        ]
      );
    }
  }

  private async convertResultsToPlaces(results: unknown[]): Promise<MapPlace[]> {
    const normalized = this.normalizeColumns(results);
    this.validateColumns(normalized);

    const places: MapPlace[] = [];

    // Row conversion does real work per row (coordinate parsing, tag lookup,
    // icon resolution, overlay decompression); yield periodically, keeping a
    // 25k-row result from freezing the UI for the whole conversion.
    const YIELD_EVERY_ROWS = 2000;
    let processed = 0;

    for (const row of normalized) {
      if (++processed % YIELD_EVERY_ROWS === 0) {
        await new Promise(resolve => window.setTimeout(resolve, 0));
      }
      try {
        if (!row.location) continue;

        const path = typeof row.path === 'string' && row.path.trim() ? row.path : undefined;
        const name = this.extractName(row.title ?? row.name, path);
        // Frontmatter tags from the `places` view's `note_tags` column (GROUP_CONCAT of the
        // `tags:` property rows in `properties`, which the pivoted np.* drops for array values).
        // No per-place metadataCache read; toTagList splits the concatenation and normalizes.
        // Falls back to a raw `tags` column for custom queries that don't select note_tags.
        const tags: unknown = row.note_tags ?? row.tags;
        const metadata: Record<string, unknown> = path ? { sourceFile: path } : {};
        for (const [key, value] of Object.entries(row)) {
          if (!KNOWN_COLUMNS.has(key) && value != null) {
            metadata[key] = value;
          }
        }
        const place = createMapPlaceFromProperties({ app: this.app, properties: row, name, filePath: path, tags: toTagList(tags), metadata });
        if (!place) continue;
        // Preserve every selected column for label expressions, including
        // structural columns omitted from styling metadata and custom aliases.
        place.queryRow = { ...row };

        places.push(place);
      } catch (error) {
        rootLogger.scope('VaultQuery').debug('Skipped a row that failed to build into a place', { path: row.path, error: getErrorMessage(error) });
      }
    }

    return places;
  }

  private extractName(title: unknown, path?: string): string {
    if (title) {
      return scalarToString(title, 'Unknown');
    }
    if (!path) {
      return 'Unknown';
    }
    return getFileNameWithoutExtension(path, 'Unknown', /\.md$/i);
  }

  // Called once during onInitialized().
  private subscribeToFileIndexedEvents(): void {
    if (this.cacheInvalidationRef) return;

    const api = this.getApi();
    if (!api) return;

    this.cacheInvalidationRef = api.on('file-indexed', (event: FileIndexedEvent) => {
      // Invalidate the cache before notifying: refresh callbacks re-query fresh data.
      this.invalidateCache();

      for (const callback of this.fileIndexedCallbacks) {
        try {
          callback(event.path);
        } catch (error) {
          logger.error('Error in file-indexed callback', error);
        }
      }
    });
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
      this.invalidateCache();

      logger.debug('Provider tables changed', {
        providerId: event.providerId,
        definitionId: event.definitionId,
        tables: event.tables,
      });

      for (const callback of this.providerTablesChangedCallbacks) {
        try {
          callback();
        } catch (error) {
          logger.error('Error in provider-tables-changed callback', error);
        }
      }
    });
  }

  // The callback runs after the query cache has been invalidated.
  // Safe to call before initialize() completes - the callback is queued and
  // will fire once the API is ready and files are indexed.
  onFileIndexed(callback: (path: string) => void): () => void {
    this.fileIndexedCallbacks.add(callback);

    // No-op while the API is not ready.
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

  onProviderTablesChanged(callback: () => void): () => void {
    this.providerTablesChangedCallbacks.add(callback);
    this.subscribeToProviderTablesChangedEvents();

    return () => {
      this.providerTablesChangedCallbacks.delete(callback);
    };
  }

  // Called when the plugin is unloaded.
  override cleanup(): void {
    const api = this.getApi();

    if (this.cacheInvalidationRef) {
      if (api) api.off(this.cacheInvalidationRef);
      this.cacheInvalidationRef = null;
    }
    if (this.vaultIndexedRef) {
      if (api) api.off(this.vaultIndexedRef);
      this.vaultIndexedRef = null;
    }
    if (this.providerTablesChangedRef) {
      if (api) api.off(this.providerTablesChangedRef);
      this.providerTablesChangedRef = null;
    }

    this.fileIndexedCallbacks.clear();
    this.vaultIndexedCallbacks.clear();
    this.providerTablesChangedCallbacks.clear();
    this.queryCache.clear();
    this.inFlightQueries.clear();

    super.cleanup();
  }
}
