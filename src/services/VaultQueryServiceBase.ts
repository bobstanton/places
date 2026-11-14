import { App } from "obsidian";
import { getVaultQueryAPI, waitForVaultQueryAPI } from "vaultquery/api";
import type { IVaultQueryAPI, EventRef } from "vaultquery/api";
import { logger as rootLogger } from "places-shared/utils";
import { getErrorMessage, sleep } from "places-shared/utils";

const logger = rootLogger.scope('VaultQuery');

const MAX_LOGGED_SQL_CHARS = 2000;

export function vaultQuerySqlError(sql: string, sourcePath: string | undefined, error: unknown): Error {
  const message = getErrorMessage(error);

  logger.warn('SQL failed', {
    sourcePath,
    sql: sql.length > MAX_LOGGED_SQL_CHARS ? `${sql.slice(0, MAX_LOGGED_SQL_CHARS)} [+${sql.length - MAX_LOGGED_SQL_CHARS} chars]` : sql,
    error: message,
  });

  return new Error("VaultQuery SQL error: " + message);
}

interface VaultQueryPluginManager {
  enabledPlugins?: Set<string>;
  plugins?: Record<string, unknown>;
}

// The API can legitimately be absent while an enabled plugin is still loading,
// especially when mobile startup has been suspended. Keep that state distinct
// from a genuinely missing or disabled plugin.
export function isVaultQueryPluginEnabled(app: App): boolean {
  const manager = (app as unknown as { plugins?: VaultQueryPluginManager }).plugins;

  return manager?.enabledPlugins?.has('vaultquery') === true || manager?.plugins?.vaultquery !== undefined;
}

// Thrown when VaultQuery is reachable but its database is not yet in its
// final shape (indexing has not pivoted note_properties). Callers should
// render a waiting state and retry on the next vault-indexed event rather
// than show an error.
export class VaultQueryPreparingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultQueryPreparingError';
  }
}

export class VaultQueryService {
  private static readonly INITIAL_INDEXING_WAIT_MS = 10_000;
  private static readonly DATABASE_HEALTH_MAX_ATTEMPTS = 3;
  private static readonly DATABASE_HEALTH_RETRY_DELAY_MS = 500;

  private readyPromise: Promise<void> | null = null;
  private ready = false;
  private databaseLostRef: EventRef | null = null;
  private disposed = false;
  private cancelIndexingWait: (() => void) | null = null;

  constructor(protected app: App) {}

  async initialize(): Promise<void> {
    return this.ensureReady();
  }

  protected async ensureReady(): Promise<void> {
    if (this.ready) return;
    if (this.readyPromise !== null) return this.readyPromise;

    this.readyPromise = this.doInitialize();

    try {
      await this.readyPromise;
      if (this.disposed) throw new VaultQueryPreparingError('Places was unloaded during startup.');
      this.ready = true;
    } catch (error) {
      this.readyPromise = null;

      throw error;
    }
  }

  private async doInitialize(): Promise<void> {
    const startTime = Date.now();

    logger.info('Starting initialization');

    const api = await waitForVaultQueryAPI(this.app);

    if (this.disposed) return;

    if (!api) {
      if (isVaultQueryPluginEnabled(this.app)) {
        throw new VaultQueryPreparingError('Waiting for VaultQuery to finish starting...');
      }

      throw new Error('VaultQuery API not available');
    }

    await this.assertDatabaseHealthy(api);
    if (this.disposed) return;

    const apiReadyTime = Date.now() - startTime;
    const indexingStatus = api.getIndexingStatus();

    logger.info(`API ready ${apiReadyTime}ms, isIndexing=${indexingStatus.isIndexing}` + (indexingStatus.progress ? `, ${indexingStatus.progress.current}/${indexingStatus.progress.total}` : ', no progress'));

    const waitStart = Date.now();

    await api.waitForIndexing(VaultQueryService.INITIAL_INDEXING_WAIT_MS);
    if (this.disposed) return;
    const waitDuration = Date.now() - waitStart;
    const postStatus = api.getIndexingStatus();

    logger.debug(`waitForIndexing ${waitDuration}ms, post: isIndexing=${postStatus.isIndexing}` + (postStatus.progress ? `, ${postStatus.progress.current}/${postStatus.progress.total}` : ''));

    if (postStatus.isIndexing) {
      logger.info('Indexing notes; waiting for VaultQuery indexing to complete', postStatus.progress);
      await this.waitForIndexingCompletion(api);
      if (this.disposed) return;
      const latestStatus = api.getIndexingStatus();

      logger.info(`Indexing complete, total ${Date.now() - startTime}ms` + (latestStatus.progress ? `, ${latestStatus.progress.current}/${latestStatus.progress.total}` : ''));
    } else {
      logger.info(`Complete in ${Date.now() - startTime}ms`);
    }

    await this.onInitialized(api);
    this.subscribeToDatabaseEvents();
  }

  private async assertDatabaseHealthy(api: IVaultQueryAPI): Promise<void> {
    if (!('checkDatabaseHealthAsync' in api)) {
      return;
    }

    let lastHealth: Awaited<ReturnType<IVaultQueryAPI['checkDatabaseHealthAsync']>> | null = null;

    for (let attempt = 1; attempt <= VaultQueryService.DATABASE_HEALTH_MAX_ATTEMPTS; attempt++) {
      const health = await api.checkDatabaseHealthAsync();

      lastHealth = health;

      if (health.healthy) {
        logger.debug('Database health check passed');

        return;
      }

      if (!this.isTransientDatabaseHealthFailure(health)) {
        logger.warn('Database health check failed', health.error, health.diagnostics);

        throw new Error(`VaultQuery database is not healthy: ${health.error ?? 'unknown error'}`);
      }

      if (attempt < VaultQueryService.DATABASE_HEALTH_MAX_ATTEMPTS) {
        logger.warn(`Database health check timed out, retrying (${attempt}/${VaultQueryService.DATABASE_HEALTH_MAX_ATTEMPTS})`, health.error, health.diagnostics);

        await sleep(VaultQueryService.DATABASE_HEALTH_RETRY_DELAY_MS);
      }
    }

    logger.warn('Database health check timed out after retries; proceeding with normal indexing/query readiness checks', lastHealth?.error, lastHealth?.diagnostics);
  }

  private isTransientDatabaseHealthFailure(health: Awaited<ReturnType<IVaultQueryAPI['checkDatabaseHealthAsync']>>): boolean {
    const message = health.error ?? '';
    const diagnostics = health.diagnostics ?? {};

    return /timed out|timeout/i.test(message) || diagnostics.workerCallTimedOut === true || diagnostics.healthCheckTimedOut === true;
  }

  protected onInitialized(_api: IVaultQueryAPI): void | Promise<void> {}

  private async waitForIndexingCompletion(api: IVaultQueryAPI): Promise<void> {
    if (!api.getIndexingStatus().isIndexing) {
      return;
    }

    await new Promise<void>((resolve) => {
      let ref: EventRef | null = null;

      const complete = (): void => {
        if (ref) {
          api.off(ref);
          ref = null;
        }

        this.cancelIndexingWait = null;
        resolve();
      };

      this.cancelIndexingWait = complete;
      ref = api.on('vault-indexed', complete);

      if (!api.getIndexingStatus().isIndexing) {
        complete();
      }
    });
  }

  protected getApi(): IVaultQueryAPI | null {
    return getVaultQueryAPI(this.app);
  }

  protected resetState(): void {
    this.ready = false;
    this.readyPromise = null;
  }

  protected onDatabaseLost(): void {}

  private subscribeToDatabaseEvents(): void {
    if (this.databaseLostRef) return;

    const api = this.getApi();

    if (!api) return;

    this.databaseLostRef = api.on('database-lost', () => {
      logger.debug('Database lost, resetting state for lazy re-initialization');
      this.resetState();

      // Unsubscribe before clearing the ref: since VaultQuery's event bus
      // survives database recovery, leaving the listener attached and then
      // re-subscribing would accumulate a duplicate per recovery cycle.
      // (On older VaultQuery versions the bus dies with the API, making
      // this off() a harmless no-op.)
      if (this.databaseLostRef) {
        api.off(this.databaseLostRef);
      }

      this.databaseLostRef = null;
      this.onDatabaseLost();
    });
  }

  isAvailable(): boolean {
    return this.getApi() !== null;
  }

  // The in-flight initialization, or null when the service is already usable.
  //
  // Startup is one shared wait, not per-block work: every block on a note blocks
  // on this same promise, and a caller can report it without threading state
  // through the query path. On a cold mobile start it is the larger half of what
  // a block spends before its map appears - 1.4s of a 2.2s prepare in the traces
  // behind this - which is worth naming rather than reporting as loading time.
  //
  // Null also covers "not started yet" and "a previous attempt failed", since
  // both clear `readyPromise`; the caller is expected to treat null as "do not
  // claim the index is being waited on", not as proof the index is ready.
  pendingReadiness(): Promise<void> | null {
    return this.ready ? null : this.readyPromise;
  }

  getLoadingProgress(): { current: number; total: number } | undefined {
    if (this.ready) return undefined;
    const status = this.getApi()?.getIndexingStatus();

    return status?.isIndexing ? status.progress : undefined;
  }

  async executeQuery(sql: string, sourcePath?: string): Promise<unknown[]> {
    await this.ensureReady();

    const api = this.getApi()!;

    try {
      return await api.query(sql, sourcePath) || [];
    } catch (error) {
      throw vaultQuerySqlError(sql, sourcePath, error);
    }
  }

  cleanup(): void {
    this.disposed = true;
    this.cancelIndexingWait?.();

    if (this.databaseLostRef) {
      const api = this.getApi();

      if (api) api.off(this.databaseLostRef);
      this.databaseLostRef = null;
    }
  }
}
