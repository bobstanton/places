import { logger } from "places-shared/utils";
import { migrateQueryParameterSourcePath } from "./QueryParameterState";
import { resolveCurrentSourcePath } from "./SourcePathRenames";

// Tracks active map containers that use queries and can be refreshed when data changes.
// Automatically refreshes maps when VaultQuery indexes files that might affect query results.
//
// The service only routes events and tracks container liveness. How a block
// re-renders itself - including re-reading its current source text and
// patching a renamed source path into its render context - is owned by the
// registrant's refresh handler (see MapRefreshInputs.createMapRefreshInputResolver).

export interface MapRefreshOptions {
  // True when the user clicked the refresh button; bypasses caches.
  manual?: boolean;
}

// Re-renders the block. Receives the current source path (kept up to date across renames).
export type MapRefreshHandler = (sourcePath: string, options?: MapRefreshOptions) => Promise<void>;

export interface MapRefreshRegistration {
  sourcePath: string;
  refresh: MapRefreshHandler;
  usesVaultQuery: boolean;
  usesDataview: boolean;
  // Whether the query uses {this.} placeholders that depend on the current file's metadata
  usesSelfReferencingPlaceholders?: boolean;
  // Direct note dependencies outside the source note, such as places listed by wikilink.
  dependencyPaths?: Iterable<string>;
}

interface TrackedMap {
  container: HTMLElement;
  sourcePath: string;
  refresh: MapRefreshHandler;
  usesVaultQuery: boolean;
  usesDataview: boolean;
  usesSelfReferencingPlaceholders: boolean;
  dependencyPaths: Set<string>;
  // Refresh was skipped because container was disconnected - execute it when container reconnects
  needsRefreshOnReconnect: boolean;
  // Temporary disconnect timestamp used to tolerate Obsidian DOM virtualization
  detachedAt?: number;
}

export interface RefreshableBlockEntry {
  onRefresh: () => Promise<void>;
  autoRefresh?: boolean;
  shouldAutoRefresh?: (changedPath?: string) => boolean;
  // Note the block lives in; enables note-scoped parameter refreshes.
  sourcePath?: string;
  // True when the block's settings resolve {parameter.*} placeholders.
  usesParameters?: boolean;
}

export interface RefreshAllBlocksOptions {
  force?: boolean;
  changedPath?: string;
  changedPaths?: string[];
}

export type RefreshableBlockRegistration = symbol;

export class MapRefreshService {
  private static instance: MapRefreshService | null = null;
  private trackedMaps: Map<HTMLElement, TrackedMap> = new Map();
  private trackedBlocks: Map<HTMLElement, RefreshableBlockEntry & { registration: RefreshableBlockRegistration }> = new Map();
  private refreshDebounceTimer: number | null = null;
  private pendingRefreshContainers: Set<HTMLElement> = new Set();
  private dataChangeListeners: Set<() => void> = new Set();
  private static readonly DETACHED_MAP_TTL_MS = 60000;
  private static readonly DATA_REFRESH_DEBOUNCE_MS = 200;
  private static readonly RECONNECT_REFRESH_DEBOUNCE_MS = 150;

  private constructor() {}

  static getInstance(): MapRefreshService {
    if (MapRefreshService.instance === null) {
      MapRefreshService.instance = new MapRefreshService();
    }
    return MapRefreshService.instance;
  }

  registerMap(container: HTMLElement, registration: MapRefreshRegistration): void {
    this.trackedMaps.set(container, {
      container,
      sourcePath: resolveCurrentSourcePath(registration.sourcePath),
      refresh: registration.refresh,
      usesVaultQuery: registration.usesVaultQuery,
      usesDataview: registration.usesDataview,
      usesSelfReferencingPlaceholders: registration.usesSelfReferencingPlaceholders ?? false,
      dependencyPaths: new Set(registration.dependencyPaths ?? []),
      needsRefreshOnReconnect: false
    });
  }

  updateMapDependencies(container: HTMLElement, dependencyPaths: Iterable<string>): void {
    const tracked = this.trackedMaps.get(container);
    if (!tracked) {
      return;
    }
    tracked.dependencyPaths = new Set(dependencyPaths);
  }

  unregisterMap(container: HTMLElement): void {
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

  // Refresh everything in a note that resolves parameters, after a note-scoped
  // parameter changed (places-parameters strip, map context menu, selection
  // action). Maps self-limit through the data fingerprint: a map whose
  // parameter signature did not change skips as unchanged data.
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
      void entry.onRefresh().catch(error => logger.error('Parameter consumer refresh failed', error));
    }
  }

  async refreshAllBlocks(options: RefreshAllBlocksOptions = {}): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const [container, entry] of Array.from(this.trackedBlocks.entries())) {
      if (!container.isConnected) {
        this.trackedBlocks.delete(container);
        continue;
      }
      if (!options.force && !entry.autoRefresh) {
        continue;
      }
      if (!options.force && entry.shouldAutoRefresh) {
        const changedPaths = options.changedPaths ?? (options.changedPath ? [options.changedPath] : []);
        const shouldRefresh = changedPaths.length === 0
          ? entry.shouldAutoRefresh()
          : changedPaths.some(path => entry.shouldAutoRefresh?.(path));
        if (!shouldRefresh) {
          logger.debug('Block refresh skipped', { changedPaths });
          continue;
        }
      }
      promises.push(entry.onRefresh());
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
      await matchingEntry.onRefresh();
      return true;
    }
    catch (error) {
      logger.error('Block refresh failed', error);
      return false;
    }
  }

  // Notified whenever anything moves through this service that could change
  // what a block would render: file and index events, provider table changes,
  // parameter changes, manual refreshes. PlacesRenderPreparer drops its
  // completed-prepare cache on this signal.
  onDataChanged(listener: () => void): () => void {
    this.dataChangeListeners.add(listener);
    return () => this.dataChangeListeners.delete(listener);
  }

  private notifyDataChanged(): void {
    for (const listener of this.dataChangeListeners) listener();
  }

  // Refresh one container immediately. Defaults to a manual refresh (the user
  // wants fresh data, not cached data); pass `{}` for programmatic refreshes
  // like query parameter changes that should keep caches warm.
  async refreshContainerNow(container: HTMLElement, options: MapRefreshOptions = { manual: true }): Promise<boolean> {
    // The query cache may stay warm on a parameter change, but a prepared render
    // does not: prepare results key on block text, and the parameter values that
    // just changed are session state outside that key.
    this.notifyDataChanged();
    const tracked = this.trackedMaps.get(container);
    if (!tracked || !this.isContainerConnected(container)) {
      return false;
    }

    try {
      await tracked.refresh(tracked.sourcePath, options);
      return true;
    } catch (error) {
      logger.error(`Error refreshing map:`, error);
      return false;
    }
  }

  // Called when a source file is modified (via vault 'modify' event).
  // Refreshes maps in the modified note that are not backed by VaultQuery.
  // VaultQuery maps wait for file-indexed events, keeping routine mobile editor
  // saves from forcing immediate map work before the index catches up.
  onSourceFileModified(modifiedPath: string): void {
    logger.debug('map refresh source file modified', { modifiedPath });
    this.queueRefreshes(tracked =>
      tracked.sourcePath === modifiedPath
      && !tracked.usesVaultQuery
    , 'source-file-modified');
  }

  // Called when a file is indexed by VaultQuery.
  // Query-backed maps refresh after indexed data changes. Non-query maps in the
  // indexed note also refresh here because they read frontmatter through
  // Obsidian's metadata cache, which can lag behind the raw vault modify event.
  onFileIndexed(indexedPath: string): void {
    logger.debug('map refresh file indexed', { indexedPath });
    this.queueRefreshes(tracked =>
      (
        tracked.usesVaultQuery
        && (tracked.sourcePath !== indexedPath || tracked.usesSelfReferencingPlaceholders)
      )
      || (
        !tracked.usesVaultQuery
        && tracked.sourcePath === indexedPath
      )
      || tracked.dependencyPaths.has(indexedPath)
    , 'file-indexed');
  }

  // Called when VaultQuery drops a deleted note from the index. Query-backed
  // maps refresh, and the deleted note's marker leaves the map; maps that named
  // the note as a dependency (linkedPlaces, tracks) refresh and forget it. A
  // map whose own note was deleted disappears with its view, and there is no
  // self-path case. Dataview maps are covered by dataview-index-changed.
  onFileRemoved(removedPath: string): void {
    logger.debug('map refresh file removed', { removedPath });
    this.queueRefreshes(tracked => tracked.usesVaultQuery || tracked.dependencyPaths.delete(removedPath), 'file-removed');
  }

  // Called when Obsidian renames a file. MarkdownPostProcessorContext.sourcePath
  // can remain stale for already-rendered code blocks, and tracked maps keep their
  // own mutable source path and use it for subsequent refresh preparation.
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
      return tracked.usesVaultQuery;
    }, 'file-renamed');
  }

  // Called when VaultQuery finishes a full indexing pass. This catches maps
  // that first rendered against a partial startup database after their relevant
  // per-file events had already fired.
  onVaultIndexed(): void {
    logger.debug('map refresh vault indexed');
    this.queueRefreshes(tracked => tracked.usesVaultQuery, 'vault-indexed');
  }

  onProviderTablesChanged(): void {
    logger.debug('map refresh provider tables changed');
    this.queueRefreshes(tracked => tracked.usesVaultQuery, 'provider-tables-changed');
  }

  // Called when Dataview re-indexes (its `dataview:refresh-views` signal). A DQL
  // query can select any note: like a VaultQuery map on vault-indexed, a
  // `dataview:` map must re-run when the vault's Dataview index changes, not only
  // when its own note is edited. This is the Dataview-native equivalent of the
  // VaultQuery index events above; without it, `dataview:` maps went stale on
  // cross-note edits (the tracked `usesDataview` flag was never read).
  onDataviewIndexChanged(): void {
    logger.debug('map refresh dataview index changed');
    this.queueRefreshes(tracked => tracked.usesDataview, 'dataview-index-changed');
  }

  private queueRefreshes(shouldRefresh: (tracked: TrackedMap) => boolean, reason: string): void {
    // Before match filtering: the signal invalidates prepared results for every
    // block, tracked live maps included or not.
    this.notifyDataChanged();
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
        tracked.needsRefreshOnReconnect = true;
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

    logger.debug('map refresh queued', {
      reason,
      matched,
      pendingRefreshCount: this.pendingRefreshContainers.size,
      matchedMaps,
    });

    if (this.pendingRefreshContainers.size === 0) {
      return;
    }

    this.schedulePendingWork();
  }

  private schedulePendingWork(delayMs = MapRefreshService.DATA_REFRESH_DEBOUNCE_MS): void {
    if (this.refreshDebounceTimer) {
      window.clearTimeout(this.refreshDebounceTimer);
    }

    this.refreshDebounceTimer = window.setTimeout(() => {
      void this.executePendingWork();
    }, delayMs);
  }

  private async executePendingWork(): Promise<void> {
    const containersToRefresh = Array.from(this.pendingRefreshContainers);
    this.pendingRefreshContainers.clear();
    this.refreshDebounceTimer = null;
    logger.debug('map refresh executing pending work', {
      refreshCount: containersToRefresh.length,
    });

    this.cleanupExpiredDetachedMaps();

    for (const container of containersToRefresh) {
      const tracked = this.trackedMaps.get(container);
      if (tracked && this.isContainerConnected(container)) {
        try {
          await tracked.refresh(tracked.sourcePath);
        } catch (error) {
          logger.error(`Error auto-refreshing map:`, error);
        }
      }
    }
  }

  // Periodically inspect tracked maps and restore any that became reconnectable.
  checkAndRestoreMaps(): void {
    const now = Date.now();

    for (const [container, tracked] of this.trackedMaps) {
      if (!this.isContainerConnected(container)) {
        tracked.detachedAt ??= now;
        continue;
      }

      tracked.detachedAt = undefined;

      if (tracked.needsRefreshOnReconnect) {
        tracked.needsRefreshOnReconnect = false;
        this.pendingRefreshContainers.add(container);
      }
    }

    this.cleanupExpiredDetachedMaps(now);

    if (this.pendingRefreshContainers.size === 0) {
      return;
    }

    this.schedulePendingWork(MapRefreshService.RECONNECT_REFRESH_DEBOUNCE_MS);
  }

  private cleanupExpiredDetachedMaps(now: number = Date.now()): void {
    for (const [container, tracked] of this.trackedMaps) {
      if (!tracked.detachedAt) {
        continue;
      }

      if (tracked.needsRefreshOnReconnect) {
        continue;
      }

      if (now - tracked.detachedAt > MapRefreshService.DETACHED_MAP_TTL_MS) {
        this.unregisterMap(container);
      }
    }
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

  // Called when the plugin is unloaded; also resets the singleton.
  cleanup(): void {
    if (this.refreshDebounceTimer) {
      window.clearTimeout(this.refreshDebounceTimer);
      this.refreshDebounceTimer = null;
    }

    this.trackedMaps.clear();
    this.trackedBlocks.clear();
    this.pendingRefreshContainers.clear();
    this.dataChangeListeners.clear();

    MapRefreshService.instance = null;
  }
}
