import { VaultQueryPreparingError } from "./VaultQueryServiceBase";
import { logger } from "places-shared/utils";
import { migrateQueryParameterSourcePath } from "./QueryParameterState";
import { resolveCurrentSourcePath } from "./SourcePathRenames";
import { queryReadsTables, relationKeys, tablesForIndexedFile } from "./QueryTableScope";
import type { FileIndexedSource } from "vaultquery/api";

export interface MapRefreshOptions {
  manual?: boolean;
  parameters?: boolean;
}

// Re-renders the block. Receives the current source path (kept up to date across renames).
export type MapRefreshHandler = (sourcePath: string, options?: MapRefreshOptions) => Promise<void>;

export type MapDataChange = 'all' | 'dataview' | { tables: readonly string[] };

export type QueryRelationResolver = (query: string) => Promise<{ relations: string[]; complete: boolean } | null>;

export interface MapRefreshRegistration {
  sourcePath: string;
  refresh: MapRefreshHandler;
  usesVaultQuery: boolean;
  query?: string;
  usesDataview: boolean;
  usesSelfReferencingPlaceholders?: boolean;
  dependencyPaths?: Iterable<string>;
}

interface TrackedMap {
  container: HTMLElement;
  sourcePath: string;
  refresh: MapRefreshHandler;
  usesVaultQuery: boolean;
  query?: string;
  resolvedTables?: ReadonlySet<string>;
  usesDataview: boolean;
  usesSelfReferencingPlaceholders: boolean;
  dependencyPaths: Set<string>;
  needsRefreshOnReconnect: boolean;
}

export interface RefreshableBlockEntry {
  onRefresh: () => Promise<void>;
  autoRefresh?: boolean;
  shouldAutoRefresh?: (changedPath?: string) => boolean;
  sourcePath?: string;
  usesParameters?: boolean;
  query?: string | null;
}

export interface BlockFileChange {
  path: string;
  source?: FileIndexedSource;
}

export interface RefreshAllBlocksOptions {
  force?: boolean;
  changedPath?: string;
  changedPaths?: string[];
  fileChanges?: BlockFileChange[];
}

export type RefreshableBlockRegistration = symbol;

interface MapRefreshWork {
  pending: MapRefreshOptions | null;
  promise: Promise<boolean>;
  cancelRetry?: () => void;
}

export class MapRefreshService {
  private static instance: MapRefreshService | null = null;
  private queryRelationResolver?: QueryRelationResolver;
  private trackedMaps: Map<HTMLElement, TrackedMap> = new Map();
  private reconnectObservers = new Map<HTMLElement, IntersectionObserver>();
  private trackedBlocks: Map<HTMLElement, RefreshableBlockEntry & { registration: RefreshableBlockRegistration; resolvedTables?: ReadonlySet<string> }> = new Map();
  private blockRefreshWork = new Map<HTMLElement, { pending: boolean; promise: Promise<void> }>();
  private containerRefreshWork = new Map<HTMLElement, MapRefreshWork>();
  private refreshDebounceTimer: number | null = null;
  private refreshWorkInFlight = false;
  private pendingRefreshContainers: Set<HTMLElement> = new Set();
  private dataChangeListeners: Set<(change: MapDataChange) => void> = new Set();
  private static readonly DATA_REFRESH_DEBOUNCE_MS = 200;
  private static readonly INDEX_REFRESH_DEBOUNCE_MS = 750;
  private static readonly INDEX_CHURN_MAX_DEBOUNCE_MS = 60000;
  private static readonly CHURN_FAST_RETRY_MAX_MS = 1500;
  private static readonly CHURN_BACKOFF_COST_FACTOR = 2;
  private indexChurnDebounceMs = 0;
  private static readonly BULK_INDEX_FILE_COUNT = 128;
  private static readonly BULK_INDEX_WINDOW_MS = 30000;
  private static readonly BULK_INDEX_REFRESH_DEBOUNCE_MS = 5000;
  private static readonly BULK_INDEX_REFRESH_COST_FACTOR = 9;
  private static readonly BULK_INDEX_MAX_DEBOUNCE_MS = 30000;
  private lastRefreshCostMs = 0;
  private static readonly REFRESH_MAX_WAIT_MS = 15000;
  private recentIndexing: Array<{ at: number; count: number }> = [];
  private pendingSince: number | null = null;
  private static readonly SOURCE_MODIFIED_REFRESH_DEBOUNCE_MS = 600;
  private static readonly RECONNECT_REFRESH_DEBOUNCE_MS = 150;

  private constructor() {}

  static getInstance(): MapRefreshService {
    if (MapRefreshService.instance === null) {
      MapRefreshService.instance = new MapRefreshService();
    }

    return MapRefreshService.instance;
  }

  setQueryRelationResolver(resolver: QueryRelationResolver | undefined): void {
    this.queryRelationResolver = resolver;
    if (resolver) this.resolveTrackedQueries();
  }

  private resolveTrackedQueries(): void {
    for (const tracked of this.trackedMaps.values()) this.resolveTrackedQuery(tracked);
    for (const tracked of this.trackedBlocks.values()) this.resolveTrackedQuery(tracked);
  }

  private resolveTrackedQuery(tracked: { query?: string | null; resolvedTables?: ReadonlySet<string> }): void {
    const resolver = this.queryRelationResolver;
    const query = tracked.query;

    if (!resolver || !query || tracked.resolvedTables) return;

    void resolver(query)
      .then(resolved => {
        if (!resolved?.complete || tracked.query !== query) return;
        tracked.resolvedTables = relationKeys(resolved.relations);
      })
      .catch((error: unknown) => logger.debug('map query relations unresolved; refreshing on every index change', { error }));
  }

  registerMap(container: HTMLElement, registration: MapRefreshRegistration): void {
    this.stopReconnectWatch(container);
    this.containerRefreshWork.get(container)?.cancelRetry?.();
    this.trackedMaps.set(container, {
      container,
      sourcePath: resolveCurrentSourcePath(registration.sourcePath),
      refresh: registration.refresh,
      usesVaultQuery: registration.usesVaultQuery,
      query: registration.query,
      usesDataview: registration.usesDataview,
      usesSelfReferencingPlaceholders: registration.usesSelfReferencingPlaceholders ?? false,
      dependencyPaths: new Set(registration.dependencyPaths ?? []),
      needsRefreshOnReconnect: false
    });

    this.resolveTrackedQuery(this.trackedMaps.get(container)!);
  }

  updateMapDependencies(container: HTMLElement, dependencyPaths: Iterable<string>): void {
    const tracked = this.trackedMaps.get(container);

    if (!tracked) {
      return;
    }

    tracked.dependencyPaths = new Set(dependencyPaths);
  }

  queueContainerRefresh(container: HTMLElement): void {
    const tracked = this.trackedMaps.get(container);

    if (!tracked) return;

    if (!this.isContainerConnected(container)) {
      this.deferUntilReconnect(tracked);

      return;
    }

    this.pendingRefreshContainers.add(container);
    this.schedulePendingWork();
  }

  unregisterMap(container: HTMLElement): void {
    this.stopReconnectWatch(container);
    this.containerRefreshWork.get(container)?.cancelRetry?.();
    this.containerRefreshWork.delete(container);
    this.trackedMaps.delete(container);
    this.pendingRefreshContainers.delete(container);
  }

  registerBlock(container: HTMLElement, entry: RefreshableBlockEntry): RefreshableBlockRegistration {
    const registration = Symbol('refreshable-block');

    this.trackedBlocks.set(container, {
      ...entry,
      sourcePath: entry.sourcePath ? resolveCurrentSourcePath(entry.sourcePath) : undefined,
      registration
    });
    this.resolveTrackedQuery(this.trackedBlocks.get(container)!);

    return registration;
  }

  unregisterBlock(container: HTMLElement, registration?: RefreshableBlockRegistration): void {
    for (const registeredContainer of this.trackedBlocks.keys()) {
      if (registeredContainer === container || container.contains(registeredContainer)) {
        if (registration !== undefined && this.trackedBlocks.get(registeredContainer)?.registration !== registration) {
          continue;
        }

        this.trackedBlocks.delete(registeredContainer);
      }
    }
  }

  refreshParameterConsumers(sourcePath: string): void {
    sourcePath = resolveCurrentSourcePath(sourcePath);
    this.queueRefreshes(tracked => resolveCurrentSourcePath(tracked.sourcePath) === sourcePath, 'note-parameters-changed');

    for (const [container, entry] of Array.from(this.trackedBlocks.entries())) {
      if (!container.isConnected) {
        this.trackedBlocks.delete(container);
        continue;
      }

      if (!entry.sourcePath || resolveCurrentSourcePath(entry.sourcePath) !== sourcePath || !entry.usesParameters) {
        continue;
      }

      void this.runBlockRefresh(container).catch(error => logger.error('Parameter consumer refresh failed', error));
    }
  }

  async refreshAllBlocks(options: RefreshAllBlocksOptions = {}): Promise<void> {
    const promises: Promise<void>[] = [];
    const changes: BlockFileChange[] = [
      ...(options.fileChanges ?? []),
      ...(options.changedPaths ?? (options.changedPath ? [options.changedPath] : [])).map(path => ({ path })),
    ];

    for (const [container, entry] of Array.from(this.trackedBlocks.entries())) {
      if (!container.isConnected) {
        this.trackedBlocks.delete(container);
        continue;
      }

      if (!options.force && !entry.autoRefresh) {
        continue;
      }

      if (!options.force) {
        const shouldRefresh = changes.length === 0
          ? entry.shouldAutoRefresh?.() ?? true
          : changes.some(({ path, source }) => {
            if (entry.shouldAutoRefresh && !entry.shouldAutoRefresh(path)) return false;
            const tables = source ? tablesForIndexedFile(source, path) : null;

            if (!tables || entry.query === undefined) return true;
            if (entry.sourcePath && path === resolveCurrentSourcePath(entry.sourcePath)) return true;

            return entry.query !== null && queryReadsTables(entry.query, tables, entry.resolvedTables);
          });

        if (!shouldRefresh) {
          continue;
        }
      }

      promises.push(this.runBlockRefresh(container));
    }

    const results = await Promise.allSettled(promises);

    for (const result of results) {
      if (result.status === 'rejected') {
        logger.error('Block refresh failed', result.reason);
      }
    }
  }

  async refreshBlockForElement(element: HTMLElement): Promise<boolean> {
    let matchingContainer: HTMLElement | null = null;
    let matchingEntry: RefreshableBlockEntry | null = null;

    for (const [container, entry] of this.trackedBlocks.entries()) {
      if (!container.isConnected) {
        this.trackedBlocks.delete(container);
        continue;
      }

      if (container === element || container.contains(element)) {
        if (!matchingContainer || matchingContainer.contains(container)) {
          matchingContainer = container;
          matchingEntry = entry;
        }
      }
    }

    if (!matchingEntry) {
      return false;
    }

    try {
      await this.runBlockRefresh(matchingContainer!);

      return true;
    }
    catch (error) {
      logger.error('Block refresh failed', error);

      return false;
    }
  }

  private runBlockRefresh(container: HTMLElement): Promise<void> {
    const active = this.blockRefreshWork.get(container);

    if (active) {
      active.pending = true;

      return active.promise;
    }

    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
    const work = { pending: true, promise };

    this.blockRefreshWork.set(container, work);

    void (async () => {
      try {
        while (work.pending && container.isConnected && this.blockRefreshWork.get(container) === work) {
          work.pending = false;
          const entry = this.trackedBlocks.get(container);

          if (!entry) break;

          try {
            await entry.onRefresh();
          } catch (error) {
            if (!work.pending) throw error;
          }
        }

        resolve();
      } catch (error) {
        reject(error);
      } finally {
        if (this.blockRefreshWork.get(container) === work) this.blockRefreshWork.delete(container);
      }
    })();

    return promise;
  }

  onDataChanged(listener: (change: MapDataChange) => void): () => void {
    this.dataChangeListeners.add(listener);

    return () => this.dataChangeListeners.delete(listener);
  }

  private notifyDataChanged(change: MapDataChange = 'all'): void {
    for (const listener of this.dataChangeListeners) listener(change);
  }

  async refreshContainerNow(container: HTMLElement, options: MapRefreshOptions = { manual: true }): Promise<boolean> {
    this.notifyDataChanged();

    if (!this.trackedMaps.has(container) || !this.isContainerConnected(container)) {
      return false;
    }

    return this.runContainerRefresh(container, options);
  }

  private runContainerRefresh(container: HTMLElement, options: MapRefreshOptions): Promise<boolean> {
    const active = this.containerRefreshWork.get(container);

    if (active) {
      active.pending = {
        manual: Boolean(active.pending?.manual) || Boolean(options.manual),
        parameters: (active.pending ? Boolean(active.pending.parameters) : true) && Boolean(options.parameters),
      };

      return active.promise;
    }

    const work: MapRefreshWork = { pending: null, promise: Promise.resolve(false) };

    work.promise = Promise.resolve().then(async () => {
      let next: MapRefreshOptions | null = options;
      let refreshed = false;
      let retries = 0;

      try {
        while (next && this.isContainerConnected(container) && this.containerRefreshWork.get(container) === work) {
          const current: MapRefreshOptions = next;

          work.pending = null;
          const tracked = this.trackedMaps.get(container);

          if (!tracked) break;
          const attemptStarted = performance.now();

          try {
            await tracked.refresh(tracked.sourcePath, current);
            refreshed = true;
            retries = 0;
            this.indexChurnDebounceMs = 0;
          } catch (error) {
            const attemptMs = performance.now() - attemptStarted;

            if (error instanceof VaultQueryPreparingError && retries < 2 && attemptMs < MapRefreshService.CHURN_FAST_RETRY_MAX_MS) {
              const timerWindow = activeWindow;

              await new Promise<void>(resolve => {
                const finish = (): void => { timerWindow.clearTimeout(timer); work.cancelRetry = undefined; resolve(); };
                const timer = timerWindow.setTimeout(finish, 500 * ++retries);

                work.cancelRetry = finish;
              });
              if (this.trackedMaps.get(container) !== tracked) break;
              const pending = work.pending as MapRefreshOptions | null;

              next = {
                manual: Boolean(current.manual || pending?.manual),
                parameters: Boolean(current.parameters && (!pending || pending.parameters)),
              };
              continue;
            }

            if (error instanceof VaultQueryPreparingError) {
              this.indexChurnDebounceMs = Math.min(MapRefreshService.INDEX_CHURN_MAX_DEBOUNCE_MS,
                Math.max(MapRefreshService.INDEX_REFRESH_DEBOUNCE_MS * 2, this.indexChurnDebounceMs * 2,
                  attemptMs * MapRefreshService.CHURN_BACKOFF_COST_FACTOR));
              logger.warn('map refresh outpaced by the index; waiting longer',
                { nextDebounceMs: this.indexChurnDebounceMs, attemptMs: Math.round(attemptMs), sourcePath: tracked.sourcePath });
            } else {
              logger.error(`Error refreshing map:`, error);
            }

            refreshed = false;
          }

          next = work.pending;
        }
      } finally {
        if (this.containerRefreshWork.get(container) === work) this.containerRefreshWork.delete(container);
      }

      return refreshed;
    });
    this.containerRefreshWork.set(container, work);

    return work.promise;
  }

  onSourceFileModified(modifiedPath: string): void {
    logger.debug('map refresh source file modified', { modifiedPath });
    this.queueRefreshes(tracked =>
      tracked.sourcePath === modifiedPath
      && !tracked.usesVaultQuery
    , 'source-file-modified', MapRefreshService.SOURCE_MODIFIED_REFRESH_DEBOUNCE_MS, false);
  }

  onSourceContextChanged(path: string): void {
    this.queueRefreshes(tracked => tracked.sourcePath === path && tracked.usesSelfReferencingPlaceholders,
      'source-context-changed', MapRefreshService.SOURCE_MODIFIED_REFRESH_DEBOUNCE_MS, false);
  }

  onFileIndexed(indexedPath: string, source: FileIndexedSource = 'note'): void {
    this.onFilesIndexed([indexedPath], source);
  }

  onFilesIndexed(indexedPaths: readonly string[], source: FileIndexedSource = 'note'): void {
    if (!indexedPaths.length) return;
    const tables = source === 'note' ? null
      : [...new Set(indexedPaths.flatMap(path => tablesForIndexedFile(source, path) ?? []))];

    logger.debug('map refresh files indexed', { files: indexedPaths.length, first: indexedPaths[0], source, tables });
    this.queueRefreshes(tracked =>
      (
        tracked.usesVaultQuery
        && (!tables || queryReadsTables(tracked.query, tables, tracked.resolvedTables))
        && (indexedPaths.some(path => tracked.sourcePath !== path) || tracked.usesSelfReferencingPlaceholders)
      )
      || (
        !tracked.usesVaultQuery
        && indexedPaths.includes(tracked.sourcePath)
      )
      || indexedPaths.some(path => tracked.dependencyPaths.has(path))
    , 'file-indexed', this.indexRefreshDelay(indexedPaths.length), tables ? { tables } : 'all');
  }

  onFileRemoved(removedPath: string): void {
    logger.debug('map refresh file removed', { removedPath });
    this.queueRefreshes(
      tracked => tracked.usesVaultQuery || tracked.dependencyPaths.delete(removedPath),
      'file-removed',
      MapRefreshService.INDEX_REFRESH_DEBOUNCE_MS,
    );
  }

  onFileRenamed(oldPath: string, newPath: string): void {
    logger.debug('map refresh file renamed', { oldPath, newPath });
    migrateQueryParameterSourcePath(oldPath, newPath);

    for (const entry of this.trackedBlocks.values()) {
      if (entry.sourcePath === oldPath) entry.sourcePath = newPath;
    }

    this.queueRefreshes(tracked => {
      if (tracked.sourcePath === oldPath) {
        tracked.sourcePath = newPath;

        return true;
      }

      if (tracked.dependencyPaths.delete(oldPath)) {
        tracked.dependencyPaths.add(newPath);

        return true;
      }

      return false;
    }, 'file-renamed', undefined, false);
  }

  onVaultIndexed(): void {
    logger.debug('map refresh vault indexed');
    this.indexChurnDebounceMs = 0;
    this.recentIndexing = [];
    this.resolveTrackedQueries();
    this.queueRefreshes(tracked => tracked.usesVaultQuery, 'vault-indexed');
  }

  onProviderTablesChanged(tables: readonly string[] = []): void {
    logger.debug('map refresh provider tables changed', { tables });
    this.queueRefreshes(tracked => tracked.usesVaultQuery && queryReadsTables(tracked.query, tables, tracked.resolvedTables),
      'provider-tables-changed', undefined, tables.length ? { tables } : 'all');
  }

  onDataviewIndexChanged(): void {
    logger.debug('map refresh dataview index changed');
    this.queueRefreshes(tracked => tracked.usesDataview, 'dataview-index-changed', undefined, 'dataview');
  }

  private queueRefreshes(shouldRefresh: (tracked: TrackedMap) => boolean, reason: string, delayMs?: number, change: MapDataChange | false = 'all'): void {
    let matched = 0;
    const matchedMaps: Array<{
      sourcePath: string;
      usesVaultQuery: boolean;
      usesDataview: boolean;
      usesSelfReferencingPlaceholders: boolean;
      connected: boolean;
    }> = [];

    for (const [container, tracked] of this.trackedMaps) {
      if (!shouldRefresh(tracked)) {
        continue;
      }

      matched++;
      const connected = this.isContainerConnected(container);

      matchedMaps.push({
        sourcePath: tracked.sourcePath,
        usesVaultQuery: tracked.usesVaultQuery,
        usesDataview: tracked.usesDataview,
        usesSelfReferencingPlaceholders: tracked.usesSelfReferencingPlaceholders,
        connected,
      });

      if (!connected) {
        this.deferUntilReconnect(tracked);
        logger.debug('map refresh deferred until reconnect', {
          reason,
          sourcePath: tracked.sourcePath,
          usesVaultQuery: tracked.usesVaultQuery,
          usesDataview: tracked.usesDataview,
          usesSelfReferencingPlaceholders: tracked.usesSelfReferencingPlaceholders,
        });
        continue;
      }

      this.pendingRefreshContainers.add(container);
    }

    if (matched || change) this.notifyDataChanged(change || 'all');
    logger.debug('map refresh queued', {
      reason,
      matched,
      pendingRefreshCount: this.pendingRefreshContainers.size,
      matchedMaps,
    });

    if (this.pendingRefreshContainers.size === 0) {
      return;
    }

    this.schedulePendingWork(delayMs);
  }

  private indexRefreshDelay(indexedCount: number): number {
    const now = Date.now();

    this.recentIndexing.push({ at: now, count: indexedCount });
    const windowStart = now - MapRefreshService.BULK_INDEX_WINDOW_MS;

    while (this.recentIndexing.length > 0 && this.recentIndexing[0].at < windowStart) this.recentIndexing.shift();

    const recentFiles = this.recentIndexing.reduce((total, entry) => total + entry.count, 0);
    const bulk = recentFiles >= MapRefreshService.BULK_INDEX_FILE_COUNT
      ? Math.min(MapRefreshService.BULK_INDEX_MAX_DEBOUNCE_MS, Math.max(
        MapRefreshService.BULK_INDEX_REFRESH_DEBOUNCE_MS,
        this.lastRefreshCostMs * MapRefreshService.BULK_INDEX_REFRESH_COST_FACTOR))
      : 0;

    return Math.max(MapRefreshService.INDEX_REFRESH_DEBOUNCE_MS, this.indexChurnDebounceMs, bulk);
  }

  private schedulePendingWork(delayMs = MapRefreshService.DATA_REFRESH_DEBOUNCE_MS): void {
    if (this.refreshDebounceTimer !== null) {
      window.clearTimeout(this.refreshDebounceTimer);
    }

    const now = Date.now();

    this.pendingSince ??= now;
    const waited = now - this.pendingSince;
    const maxWait = Math.max(MapRefreshService.REFRESH_MAX_WAIT_MS, delayMs);
    const capped = Math.max(0, Math.min(delayMs, maxWait - waited));

    logger.debug('map refresh scheduled', { delayMs: Math.round(delayMs), cappedMs: Math.round(capped), waitedMs: waited, lastRefreshCostMs: Math.round(this.lastRefreshCostMs) });

    this.refreshDebounceTimer = window.setTimeout(() => {
      void this.executePendingWork();
    }, capped);
  }

  private async executePendingWork(): Promise<void> {
    this.refreshDebounceTimer = null;

    if (this.refreshWorkInFlight) {
      logger.debug('map refresh execution coalesced with active work', {
        pendingRefreshCount: this.pendingRefreshContainers.size,
      });

      return;
    }

    const containersToRefresh = Array.from(this.pendingRefreshContainers);

    this.pendingRefreshContainers.clear();
    this.pendingSince = null;
    if (containersToRefresh.length === 0) return;

    this.refreshWorkInFlight = true;
    logger.debug('map refresh executing pending work', {
      refreshCount: containersToRefresh.length,
    });
    const started = performance.now();

    try {
      for (const container of containersToRefresh) {
        const tracked = this.trackedMaps.get(container);

        if (!tracked) continue;

        if (!this.isContainerConnected(container)) {
          this.deferUntilReconnect(tracked);
          continue;
        }

        const refreshed = await this.runContainerRefresh(container, {});

        if (!refreshed && this.trackedMaps.get(container) === tracked && !this.isContainerConnected(container)) {
          this.deferUntilReconnect(tracked);
        }
      }
    } finally {
      this.refreshWorkInFlight = false;
      this.lastRefreshCostMs = performance.now() - started;

      if (this.pendingRefreshContainers.size > 0 && this.refreshDebounceTimer === null) {
        this.schedulePendingWork();
      }
    }
  }

  private deferUntilReconnect(tracked: TrackedMap): void {
    tracked.needsRefreshOnReconnect = true;
    const container = tracked.container;
    const Observer = container.ownerDocument?.defaultView?.IntersectionObserver;

    if (!Observer || this.reconnectObservers.has(container)) return;

    const observer = new Observer(records => {
      if (this.trackedMaps.get(container) === tracked && records.some(record => record.isIntersecting)) {
        this.checkAndRestoreMaps();
      }
    });

    this.reconnectObservers.set(container, observer);
    observer.observe(container);
  }

  private stopReconnectWatch(container: HTMLElement): void {
    this.reconnectObservers.get(container)?.disconnect();
    this.reconnectObservers.delete(container);
  }

  checkAndRestoreMaps(): void {
    let restored = false;

    for (const [container, tracked] of this.trackedMaps) {
      if (!this.isContainerConnected(container)) {
        continue;
      }

      if (tracked.needsRefreshOnReconnect) {
        this.stopReconnectWatch(container);
        tracked.needsRefreshOnReconnect = false;
        this.pendingRefreshContainers.add(container);
        restored = true;
        logger.debug('map refresh restored after reconnect', { sourcePath: tracked.sourcePath, query: tracked.query });
      }
    }

    if (!restored) return;

    this.schedulePendingWork(MapRefreshService.RECONNECT_REFRESH_DEBOUNCE_MS);
  }

  // Maps in background tabs are still refreshed when they become visible again:
  // only connection is checked, not visibility.
  private isContainerConnected(container: HTMLElement): boolean {
    return container.isConnected;
  }

  // Called when the active leaf changes (workspace navigation).
  // On mobile, containers that were off-screen may have been disconnected from the DOM.
  // Any map that was marked stale while disconnected is refreshed now that it may be visible.
  onLeafChange(): void {
    this.checkAndRestoreMaps();
  }

  cleanup(): void {
    if (this.refreshDebounceTimer !== null) {
      window.clearTimeout(this.refreshDebounceTimer);
      this.refreshDebounceTimer = null;
    }

    for (const container of this.reconnectObservers.keys()) this.stopReconnectWatch(container);
    this.trackedMaps.clear();
    this.trackedBlocks.clear();
    this.blockRefreshWork.clear();
    for (const work of this.containerRefreshWork.values()) work.cancelRetry?.();
    this.containerRefreshWork.clear();
    this.refreshWorkInFlight = false;
    this.pendingRefreshContainers.clear();
    this.pendingSince = null;
    this.recentIndexing = [];
    this.dataChangeListeners.clear();

    MapRefreshService.instance = null;
  }
}
