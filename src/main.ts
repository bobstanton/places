import { Component, MarkdownRenderer, loadPrism } from 'obsidian';
import { formatMetersInSystem, meters } from "places-shared/units";
import { trackPreparation } from './services/TrackPreparationWorker';
import { logger as rootLogger, clamp } from "places-shared/utils";
import { installPlacesGlobalErrorCapture } from "./services/GlobalErrorCapture";
import { CodeBlockReader, DEFAULT_SPEED_WINDOW, parseMetricWindow } from "places-shared/settings";
import { applyBlockWidth } from "places-shared/obsidian/ui";
import { setSpeedWindow } from 'places/core';
import { normalizeConsoleLogLevel } from 'obsidian-debug-logger';
import { App, DataAdapter, Editor, Events, MarkdownPostProcessorContext, Notice, Plugin, addIcon, Platform, requestUrl, setIcon, stringifyYaml } from "obsidian";
import { createPlacesCompletionExtension } from "./editor/PlacesCompletionExtension";
import { placesHighlightPlugin } from "./editor/PlacesHighlightExtension";
import { getVaultQueryAPI, VAULTQUERY_API_READY_EVENT, type SqlSyntax } from 'vaultquery/api';
import { placesIndentExtension } from "./editor/PlacesIndentExtension";
import { AggregatorApiService } from "./places-services/AggregatorApiService";
import { configureOverlayDecodeCache } from "./services/OverlayDecodeCache";
import { CURRENT_MARKER_ICON_RULES_REVISION, CURRENT_WAYPOINT_ICON_MAPPINGS_REVISION, configureMarkerIconRules, configureWaypointIconMappings, resolveTerrainDemSpec, resolveTerrainRuntime, upgradeMarkerIconRules, upgradeWaypointIconMappings, type PopupRenderer, type TerrainDemResolution, type TerrainRuntime } from "places-shared/map";
import { TileCache } from "places-shared/obsidian/map";
import { IPlacesPluginSettings, DEFAULT_SETTINGS, DEFAULT_TILE_CACHE_DURATION_HOURS, isPopupRendererId, type IPlacesExtensionHostSettings } from "places-shared/settings";
import { API_USAGE_SERVICES, IPlacesService, IMapBlockProcessor, IElevationService, ITrackMatchService, type ApiUsageOrigin, type RouteOverlayService, type ISnapService, type ITerrainDemProvider } from "places-shared/services";
import { type IPlacesHostServices, PLACES_EXTENSION_READY_EVENT, PLACES_EXTENSION_UNLOADED_EVENT, PLACES_EXTENSION_API_VERSION, type IPlacePluginExtension, type IPlacePluginExtensionExports, type ImageAlignmentProcessor, type PlaceProviderExport, type PlaceExtensionReadyEvent, type PlaceExtensionUnloadedEvent, type ExtensionSettingsGroup } from "places-shared/obsidian/services";
import { ServiceRegistry } from "./services/ServiceRegistry";
import { PluginDiscoveryService } from "./services/PluginDiscoveryService";
import { renderError, SessionCacheStorage, getErrorMessage, configureRequestLogging, configureUrlRequester, setOverlayCompressionLevel } from "places-shared/utils";
import { canOpenDevicePaths, configureResourceUrls } from "places-shared/obsidian/utils";
import { setDevicePathsOpenable } from "places-shared/map";
import { configureHostPrimitives } from "places-shared/services";
import { DebugLogFile } from "./services/DebugLogFile";
import { renderPopupContent } from "places-shared/obsidian/map";
import { initOverlayCompression } from "places-shared/compression";
import { PlacesSettingsTab } from "./PlacesSettingsTab";
import { createImagePopupRenderer } from "./popup/ImagePopupRenderer";
import { readKnapTemplateFile } from "places-shared/obsidian/services";
import { createKnapPopupRenderer } from "./popups/KnapPopupRenderer";
import type { VectorTileOverlayPreset } from "places-shared/overlay";
import { PlaceDataService } from "./services/PlaceDataService";
import { TrackDataService } from "./services/TrackDataService";
import { OverlayService } from "./services/OverlayService";
import { PlacesTrackingDecorator } from "./places-services/PlacesTrackingDecorator";
import { PlacesCachingDecorator } from "./places-services/PlacesCachingDecorator";
import { ElevationTrackingDecorator } from "./elevation-services/ElevationTrackingDecorator";
import { ElevationCachingDecorator } from "./elevation-services/ElevationCachingDecorator";
import { OverlayImportService } from 'places/core';
import { DragDropHandler } from "./DragDropHandler";
import { PlacesChartBlockProcessor } from "./code-block-processor/PlacesChartBlockProcessor";
import { SimilarTracksBlockProcessor } from "./code-block-processor/SimilarTracksBlockProcessor";
import { CompareTracksBlockProcessor } from "./code-block-processor/CompareTracksBlockProcessor";
import { PlacesCodeBlockProcessor } from "./code-block-processor/PlacesCodeBlockProcessor";
import { PlacesHelpCodeBlockProcessor } from "./code-block-processor/PlacesHelpCodeBlockProcessor";
import { HeatmapBlockProcessor } from "./code-block-processor/HeatmapBlockProcessor";
import { PlacesParametersBlockProcessor } from "./code-block-processor/PlacesParametersBlockProcessor";
import { BlockParameterSupport } from "./services/BlockParameters";
import { readNoteProperties } from './services/NoteProperties';
import { recordSourcePathCreation } from './services/SourcePathRenames';
import { CodeBlockStartup } from './services/CodeBlockStartup';
import { PlacesReferenceCodeBlockProcessor } from "./code-block-processor/PlacesReferenceCodeBlockProcessor";
import { CodeBlockRegistry, MAIN_PLUGIN_DEFINITIONS, MAIN_PLUGIN_HIGHLIGHT_CONFIGS } from "./services/CodeBlockRegistry";
import { renderMapSurface, withHostCapabilities } from "./services/MapSurfaceRenderer";
import { cleanupMapContainer } from "./services/MapSurfaceCleanup";
import { getMapSurfaceController, retryMapSurfacesWaitingForProvider } from "./services/MapSurfaceControllers";
import { buildHostSurfaceRenderOptions } from "./services/HostSurfacePlan";
import { PlacesBasesView } from "./bases/PlacesBasesView";
import { PlaceLabelCaches } from './services/LabelResultCache';
import { VaultQueryService } from "./services/VaultQueryService";
import { MapRefreshService, type BlockFileChange } from "./services/MapRefreshService";
import { ExtensionReloadScheduler } from "./services/ExtensionReloadScheduler";
import type { Coordinate } from "places-shared/geo";
import { resolveMapSettings } from "./services/MapSettingsResolver";
import { TemplateNoteService } from "./services/TemplateNoteService";
import { PlaceNoteCreationService } from "./services/PlaceNoteCreationService";
import { TemplateRenameQueue } from "./services/TemplateReferenceRenamer";
import { BlockRefreshRegistry } from "./services/BlockRefreshRegistry";
import { splitExtensionBlockSource } from "./code-block-processor/ExtensionBlockSource";
import { registerRefreshableCodeBlock, createOwnNoteEditRefreshGuard } from "./code-block-processor/RefreshableCodeBlock";
import { RouteOverlayGenerator } from "./services/RouteOverlayGenerator";
import { BlockSyntaxError } from "places-shared/settings";
import { optionalStringSetting, parseCodeBlock } from 'places/core';
import { CachedRouteOverlay, isCachedRouteOverlay, RouteOverlayCachingDecorator, ROUTE_OVERLAY_MAX_CACHE_ENTRIES, type RouteOverlayCacheStorage } from "./services/RouteOverlayCachingDecorator";
import { RouteOverlayTrackingDecorator } from "./services/RouteOverlayTrackingDecorator";
import { SnapTrackingDecorator } from "./services/SnapTrackingDecorator";
import { TrackMatchTrackingDecorator } from "./services/TrackMatchTrackingDecorator";
import { ApiUsageStore } from "./places-services/ApiUsageStore";
import { OriginScopedServices } from "./services/OriginScopedServices";

import { CliController } from "./controllers/CliController";
import { CommandRegistrar } from "./controllers/CommandRegistrar";
import { TrackImportController } from "./controllers/TrackImportController";
import { PlaceNoteController } from "./controllers/PlaceNoteController";
import { ProtocolController } from "./controllers/ProtocolController";
import { SnapBlockProcessor } from "./code-block-processor/SnapBlockProcessor";
import { NoteParameterRegistry, QueryParameterState, SharedSelectionService } from "./services/QueryParameterState";
import { toProviderStyles, type ProviderStyle } from "./services/ProviderStyles";
import { applyExternalParameterValue } from "./ui/ParameterStrip";
import { ElevationBlockProcessor } from "./code-block-processor/ElevationBlockProcessor";

import "./styles.css";
import "places-shared/block-styles.css";
import "places-shared/error-styles.css";
import "places-shared/loading-styles.css";
import "places-shared/settings-trace-styles.css";
import "places-shared/marker-styles.css";
import "places-shared/popup-styles.css";
import "places-shared/search-styles.css";
import "places-shared/waypoint-styles.css";
import "places-shared/button-styles.css";
import "places-shared/device-position-styles.css";
import "./generated-help/styles.generated.css";

const logger = {
  refresh: rootLogger.scope('Refresh'),
  protocol: rootLogger.scope('Protocol'),
  elevation: rootLogger.scope('Elevation'),
  tracks: rootLogger.scope('Tracks'),
  export: rootLogger.scope('Export'),
  import: rootLogger.scope('Import'),
  settings: rootLogger.scope('Settings'),
  extensions: rootLogger.scope('Extensions'),
};

function isExtensionReadyEvent(value: unknown): value is PlaceExtensionReadyEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<PlaceExtensionReadyEvent>;

  return typeof event.pluginId === 'string'
    && event.pluginId.startsWith('places-')
    && typeof event.extension?.getPlaceExports === 'function';
}

function isExtensionUnloadedEvent(value: unknown): value is PlaceExtensionUnloadedEvent {
  return Boolean(value && typeof value === 'object'
    && typeof (value as Partial<PlaceExtensionUnloadedEvent>).pluginId === 'string'
    && (value as Partial<PlaceExtensionUnloadedEvent>).pluginId?.startsWith('places-'));
}

function extensionHostSettings(settings: IPlacesPluginSettings): IPlacesExtensionHostSettings {
  return Object.freeze({
    units: settings.units,
    developerMode: settings.developerMode,
    poiFilterPatterns: Object.freeze([...settings.poiFilterPatterns]),
  });
}

interface ObsidianPluginWithBasesViewRegistration {
  registerBasesView(type: string, view: {
    name: string;
    icon: string;
    factory: (controller: unknown, containerEl: HTMLElement) => PlacesBasesView;
    options: typeof PlacesBasesView.getViewOptions;
  }): void;
}

const ROUTE_OVERLAY_CACHE_FILE = 'route-overlay-cache.json';

class RouteOverlayCacheFile implements RouteOverlayCacheStorage {
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly cache: Record<string, CachedRouteOverlay>, private readonly adapter: DataAdapter, private readonly path: string) {}

  static async read(adapter: DataAdapter, path: string): Promise<Record<string, CachedRouteOverlay>> {
    try {
      if (!(await adapter.exists(path))) return {};

      return normalizeRouteOverlayCache(JSON.parse(await adapter.read(path)) as Record<string, unknown>);
    } catch (error) {
      logger.settings.warn('Route overlay cache could not be read', error);

      return {};
    }
  }

  private async saveData(): Promise<void> {
    this.writing = this.writing
      .then(() => this.adapter.write(this.path, JSON.stringify(this.cache)))
      .catch((error: unknown) => { logger.settings.warn('Route overlay cache could not be written', error); });

    await this.writing;
  }

  get(key: string): CachedRouteOverlay | null {
    const entry = this.cache[key];

    if (isCachedRouteOverlay(entry)) return entry;
    if (entry !== undefined) delete this.cache[key];

    return null;
  }

  async set(key: string, entry: CachedRouteOverlay): Promise<void> {
    this.cache[key] = entry;
    this.prune();

    await this.saveData();
  }

  private prune(): void {
    const entries = Object.entries(this.cache)
      .map(([key, entry]) => ({ key, timestamp: entry.t }));

    if (entries.length <= ROUTE_OVERLAY_MAX_CACHE_ENTRIES) return;

    for (const entry of entries
      .sort((left, right) => left.timestamp - right.timestamp)
      .slice(0, entries.length - ROUTE_OVERLAY_MAX_CACHE_ENTRIES)) {
      delete this.cache[entry.key];
    }
  }
}

function normalizeRouteOverlayCache(raw: Record<string, unknown> | undefined): Record<string, CachedRouteOverlay> {
  const cache: Record<string, CachedRouteOverlay> = {};

  if (!raw || typeof raw !== "object") return cache;

  for (const [key, entry] of Object.entries(raw)) {
    if (isCachedRouteOverlay(entry)) {
      cache[key] = entry;
    }
  }

  return cache;
}

export default class PlacesPlugin extends Plugin {
  private readonly basesLabelCaches = new PlaceLabelCaches();
  private readonly sharedSelections = new SharedSelectionService();
  private debugLogFile: DebugLogFile | null = null;
  private settingsUnreadable = false;
  private settingsTab: PlacesSettingsTab | null = null;
  private static _settings: IPlacesPluginSettings;
  private static _instance: PlacesPlugin;
  private static apiStatsSaveTimer: number | null = null;
  private static apiStatsDirty = false;
  private static readonly API_STATS_SAVE_DEBOUNCE_MS = 60000;

  static getSqlSyntax(): SqlSyntax | undefined {
    const app = PlacesPlugin._instance?.app;

    return app ? getVaultQueryAPI(app)?.sqlSyntax : undefined;
  }

  static get settings(): IPlacesPluginSettings {
    return PlacesPlugin._settings;
  }

  static publishSelection(sourcePath: string, selection: import('places-shared/obsidian/services').SharedSelection | undefined, channel?: string): void {
    PlacesPlugin._instance?.sharedSelections.publish(sourcePath, selection, channel);
  }

  static subscribeSelection(sourcePath: string, handler: (selection: import('places-shared/obsidian/services').SharedSelection | undefined) => void, channel?: string): () => void {
    return PlacesPlugin._instance?.sharedSelections.subscribe(sourcePath, handler, channel) ?? (() => {});
  }

  static async saveSettings(): Promise<void> {
    PlacesPlugin.configureTileCache();
    PlacesPlugin.configureOverlayDecodeCache();
    configureMarkerIconRules(PlacesPlugin._settings.markerIconRules);
    configureWaypointIconMappings(PlacesPlugin._settings.waypointIconMappings);
    rootLogger.configure(PlacesPlugin._settings.consoleLogLevel);
    configureRequestLogging(PlacesPlugin._settings.developerMode);
    setOverlayCompressionLevel(PlacesPlugin._settings.overlayCompressionLevel);
    PlacesPlugin.applyMetricWindowSettings();
    await PlacesPlugin._instance?.applyDebugLogFileSetting();

    await PlacesPlugin.savePluginData();
  }

  static async savePluginData(): Promise<void> {
    if (PlacesPlugin._instance.settingsUnreadable) return;

    await PlacesPlugin._instance.saveData({ ...PlacesPlugin._settings });
  }

  static scheduleApiStatsSave(): void {
    PlacesPlugin.apiStatsDirty = true;

    if (PlacesPlugin.apiStatsSaveTimer !== null) {
      return;
    }

    PlacesPlugin.apiStatsSaveTimer = window.setTimeout(() => {
      void PlacesPlugin.flushApiStatsSave();
    }, PlacesPlugin.API_STATS_SAVE_DEBOUNCE_MS);
  }

  async resetApiStats(): Promise<void> {
    this.apiUsage.clear();

    await PlacesPlugin.savePluginData();
  }

  static async flushApiStatsSave(rescheduleOnError = true): Promise<void> {
    if (PlacesPlugin.apiStatsSaveTimer !== null) {
      window.clearTimeout(PlacesPlugin.apiStatsSaveTimer);
      PlacesPlugin.apiStatsSaveTimer = null;
    }

    if (!PlacesPlugin.apiStatsDirty) {
      return;
    }

    PlacesPlugin.apiStatsDirty = false;

    try {
      await PlacesPlugin.saveSettings();
    } catch (error) {
      PlacesPlugin.apiStatsDirty = true;
      logger.settings.error('Failed to save API usage statistics', error);

      if (rescheduleOnError) {
        PlacesPlugin.scheduleApiStatsSave();
      }
    }
  }

  // The speed window keys the parsed-track caches; a change takes effect on
  // the next render.
  static applyMetricWindowSettings(): void {
    try {
      setSpeedWindow(parseMetricWindow(PlacesPlugin.settings.speedWindow, DEFAULT_SPEED_WINDOW));
    } catch (error) {
      rootLogger.warn("Invalid speedWindow setting; keeping the default", { value: PlacesPlugin.settings.speedWindow, error });
      setSpeedWindow(DEFAULT_SPEED_WINDOW);
    }
  }

  static configureOverlayDecodeCache(): void {
    configureOverlayDecodeCache({
      maxSizeMB: Platform.isMobile
        ? PlacesPlugin._settings.overlayCacheMaxSizeMBMobile
        : PlacesPlugin._settings.overlayCacheMaxSizeMBDesktop,
    });
  }

  static configureTileCache(): void {
    TileCache.configure({
      durationHours: Platform.isMobile
        ? PlacesPlugin._settings.tileCacheDurationHoursMobile
        : PlacesPlugin._settings.tileCacheDurationHoursDesktop,
      maxSizeMB: Platform.isMobile
        ? PlacesPlugin._settings.tileCacheMaxSizeMBMobile
        : PlacesPlugin._settings.tileCacheMaxSizeMBDesktop,
      enabledProviders: PlacesPlugin._settings.tileCacheEnabledProviders,
    });
  }

  private registerTileUsageTracking(): void {
    TileCache.configureUsageSink(event => {
      this.apiUsage.record({
        provider: event.provider,
        service: API_USAGE_SERVICES.tiles,
        success: event.success,
        durationMs: 0,
        ...(event.network ? {} : { cached: true }),
      });
    });
  }

  static getMapProvider(providerName: string): IMapBlockProcessor | undefined {
    return PlacesPlugin._instance?.mapBlockProcessors.get(providerName);
  }

  static getMapProviderDefaults(providerName: string): import('places-shared/obsidian/settings').MapConfigPatch {
    return PlacesPlugin._instance?.mapProviderDefaults.get(providerName) ?? {};
  }

  static getSnapService(providerName: string, origin?: ApiUsageOrigin): ISnapService | undefined {
    if (!origin) return PlacesPlugin._instance?.snapServices.get(providerName);

    return PlacesPlugin._instance?.originScopedSnap.get(providerName, origin);
  }

  static getFirstSnapService(origin?: ApiUsageOrigin): ISnapService | undefined {
    const first = PlacesPlugin._instance?.snapServices.getNames()[0];

    return first === undefined ? undefined : PlacesPlugin.getSnapService(first, origin);
  }

  static getSnapServiceNames(): string[] {
    return PlacesPlugin._instance?.snapServices.getNames() ?? [];
  }

  static getElevationService(providerName: string, origin?: ApiUsageOrigin): IElevationService | undefined {
    if (!origin) return PlacesPlugin._instance?.elevationServices.get(providerName);

    return PlacesPlugin._instance?.originScopedElevation.get(providerName, origin);
  }

  static getFirstElevationService(origin?: ApiUsageOrigin): IElevationService | undefined {
    const first = PlacesPlugin._instance?.elevationServices.getNames()[0];

    return first === undefined ? undefined : PlacesPlugin.getElevationService(first, origin);
  }

  static getElevationServiceNames(): string[] {
    return PlacesPlugin._instance?.elevationServices.getNames() ?? [];
  }

  static getAllMapProviders(): string[] {
    return PlacesPlugin._instance?.mapBlockProcessors.getNames() ?? [];
  }

  static getMapTools() {
    return PlacesPlugin._instance?.getRegisteredMapTools() ?? [];
  }

  static getPopupRenderers(): readonly PopupRenderer[] {
    return PlacesPlugin._instance?.getRegisteredPopupRenderers() ?? [];
  }

  static getOverlayPreset(id: string): VectorTileOverlayPreset | undefined {
    return PlacesPlugin._instance?.registeredOverlayPresets.get(id);
  }

  static getTrackMatchService(providerName: string, origin?: ApiUsageOrigin): ITrackMatchService | undefined {
    if (!origin) return PlacesPlugin._instance?.trackMatchServices.get(providerName);

    return PlacesPlugin._instance?.originScopedTrackMatch.get(providerName, origin);
  }

  // Setting `terrainProvider` enables terrain; leaving it empty disables it.
  // A provider name (mapbox, maptiler) resolves through the registry with that
  // provider's key; `aws` uses AWS Terrain Tiles; an `http(s)://` value is a
  // custom tile URL. A named source that does not exist is a surfaced error.
  static resolveTerrainDem(terrainProvider: string | undefined): TerrainDemResolution {
    return resolveTerrainDemSpec(
      terrainProvider,
      (name) => PlacesPlugin._instance?.terrainDemProviders.get(name)?.getDemSource(),
      () => PlacesPlugin._instance?.terrainDemProviders.getNames() ?? [],
    );
  }

  static getTerrainProviderNames(): string[] {
    return PlacesPlugin._instance?.terrainDemProviders.getNames() ?? [];
  }

  static resolveTerrainRuntime(config: import('places-shared/obsidian/settings').ResolvedMapConfig): TerrainRuntime {
    return resolveTerrainRuntime(
      config,
      (name) => PlacesPlugin._instance?.terrainDemProviders.get(name)?.getDemSource(),
      () => PlacesPlugin._instance?.terrainDemProviders.getNames() ?? [],
    );
  }

  static getFirstTrackMatchService(origin?: ApiUsageOrigin): ITrackMatchService | undefined {
    const first = PlacesPlugin._instance?.trackMatchServices.getNames()[0];

    return first === undefined ? undefined : PlacesPlugin.getTrackMatchService(first, origin);
  }

  static getTrackMatchServiceNames(): string[] {
    return PlacesPlugin._instance?.trackMatchServices.getNames() ?? [];
  }

  // Returns lowercase; '' when no provider is available.
  static resolveMapProvider(explicitProvider?: string): string {
    if (explicitProvider) {
      return explicitProvider.toLowerCase();
    }

    const defaultProvider = PlacesPlugin.settings.defaultMapProvider?.toLowerCase();
    const providers = PlacesPlugin.getAllMapProviders();

    if (defaultProvider && providers.includes(defaultProvider)) {
      return defaultProvider;
    }

    return providers.length > 0 ? providers[0] : '';
  }

  static getTrackDataService(): TrackDataService | undefined {
    return PlacesPlugin._instance?.trackDataService;
  }

  static getApp(): App | undefined {
    return PlacesPlugin._instance?.app;
  }

  private placesServices = new ServiceRegistry<IPlacesService>();
  private placesServiceAggregator = new AggregatorApiService(this.placesServices);
  private mapBlockProcessors = new ServiceRegistry<IMapBlockProcessor>();
  private mapProviderDefaults = new ServiceRegistry<import('places-shared/obsidian/settings').MapConfigPatch>();
  private elevationServices = new ServiceRegistry<IElevationService>();
  private routeOverlayServices = new ServiceRegistry<RouteOverlayService>();
  private snapServices = new ServiceRegistry<ISnapService>();
  private trackMatchServices = new ServiceRegistry<ITrackMatchService>();
  private readonly rawPlacesServices = new Map<string, IPlacesService>();
  private readonly rawElevationServices = new Map<string, IElevationService>();
  private readonly rawRouteOverlayServices = new Map<string, RouteOverlayService>();
  private readonly rawSnapServices = new Map<string, ISnapService>();
  private readonly rawTrackMatchServices = new Map<string, ITrackMatchService>();
  private readonly originScopedPlaces = new OriginScopedServices<IPlacesService>((name, origin) => {
    const raw = this.rawPlacesServices.get(name.toLowerCase());

    return raw && this.wrapPlacesService(raw, name.toLowerCase(), origin);
  });
  private readonly originScopedElevation = new OriginScopedServices<IElevationService>((name, origin) => {
    const raw = this.rawElevationServices.get(name.toLowerCase());

    return raw && this.wrapElevationService(raw, name.toLowerCase(), origin);
  });
  private readonly originScopedRouteOverlay = new OriginScopedServices<RouteOverlayService>((name, origin) => {
    const raw = this.rawRouteOverlayServices.get(name.toLowerCase());

    return raw && this.wrapRouteOverlayService(raw, name.toLowerCase(), origin);
  });
  private readonly originScopedSnap = new OriginScopedServices<ISnapService>((name, origin) => {
    const raw = this.rawSnapServices.get(name.toLowerCase());

    return raw && new SnapTrackingDecorator(raw, name.toLowerCase(), this.apiUsage, origin);
  });
  private readonly originScopedTrackMatch = new OriginScopedServices<ITrackMatchService>((name, origin) => {
    const raw = this.rawTrackMatchServices.get(name.toLowerCase());

    return raw && new TrackMatchTrackingDecorator(raw, name.toLowerCase(), this.apiUsage, origin);
  });
  private readonly originScopedAggregators = new OriginScopedServices<AggregatorApiService>((_providerName, origin) => new AggregatorApiService({
    getAll: () => this.placesServices.getNames()
      .map(name => this.originScopedPlaces.get(name, origin))
      .filter((service): service is IPlacesService => service !== undefined),
  }));
  private readonly apiUsage = new ApiUsageStore(
    () => ({ stats: PlacesPlugin.settings.apiStats, origins: PlacesPlugin.settings.apiOrigins }),
    () => PlacesPlugin.scheduleApiStatsSave(),
  );
  private terrainDemProviders = new ServiceRegistry<ITerrainDemProvider>();
  private providerStyles = new ServiceRegistry<ProviderStyle[]>();
  private imageAlignmentProcessors = new ServiceRegistry<ImageAlignmentProcessor>();
  private imageAlignmentOverlayService?: OverlayService;
  private extensionSettingsGroups: Record<string, ExtensionSettingsGroup> = {};
  // Session caches outlive extension re-initialization.
  private readonly apiCacheStorage = new SessionCacheStorage();
  private readonly elevationCacheStorage = new SessionCacheStorage();
  private routeOverlayCacheStorage!: RouteOverlayCacheFile;
  private readonly extensionCodeBlockHandlers = new Map<string, (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => void | Promise<void>>();
  private readonly extensionSourceFormats = new Map<string, 'yaml' | 'yaml-template'>();
  private readonly extensionIndexDependencies = new Map<string, 'notes'>();
  private readonly extensionColonTextKeys = new Map<string, readonly string[]>();
  private readonly registeredExtensionBlockTypes = new Set<string>();
  private extensionCommandIds = new Set<string>();
  private extensionCommandHelp: Array<{ name: string; description: string }> = [];
  private commandRegistrar!: CommandRegistrar;
  private registeredProviderExports: PlaceProviderExport[] = [];
  private registeredPopupRenderers: PopupRenderer[] = [];
  private registeredOverlayPresets = new Map<string, VectorTileOverlayPreset>();
  private readonly extensionInstances = new Map<string, IPlacePluginExtension>();
  private readonly extensionExports = new Map<string, { name: string; exports: IPlacePluginExtensionExports }>();
  private readonly versionMismatchWarned = new Set<string>();
  private readonly extensionReloads = new ExtensionReloadScheduler(
    pluginIds => this.reloadExtensions(pluginIds),
    500,
    error => logger.extensions.error('Failed to apply extension settings', error),
  );
  private blockRefreshTimer: number | null = null;
  private pendingBlockRefreshChanges = new Map<string, BlockFileChange>();

  private dragDropHandler!: DragDropHandler;
  private placesChartBlockProcessor!: PlacesChartBlockProcessor;
  private placeDataService!: PlaceDataService;
  private trackDataService!: TrackDataService;
  private overlayImportService!: OverlayImportService;
  private trackImportController!: TrackImportController;
  private placeNoteController!: PlaceNoteController;
  private codeBlockProcessor!: PlacesCodeBlockProcessor;
  private templateNoteService!: TemplateNoteService;
  private templateRenameQueue!: TemplateRenameQueue;
  private placeNoteCreationService!: PlaceNoteCreationService;
  private protocolController!: ProtocolController;

  static get templateNotes(): TemplateNoteService {
    return PlacesPlugin._instance.templateNoteService;
  }

  // Stamped onto every render plan.
  static get placeNoteHost(): PlaceNoteCreationService {
    return PlacesPlugin._instance.placeNoteCreationService;
  }

  static get placesService(): AggregatorApiService {
    return PlacesPlugin._instance.placesServiceAggregator;
  }

  static placesServiceFor(origin: ApiUsageOrigin): AggregatorApiService {
    return PlacesPlugin._instance?.originScopedAggregators.get('all', origin) ?? PlacesPlugin._instance.placesServiceAggregator;
  }

  static get reverseGeocodeHost(): (coordinate: Coordinate, sourcePath?: string) => void {
    return (coordinate, sourcePath) => PlacesPlugin._instance.protocolController.openReverseGeocode(coordinate, sourcePath);
  }
  private helpCodeBlockProcessor!: PlacesHelpCodeBlockProcessor;
  private codeBlockStartup!: CodeBlockStartup;
  private vaultQueryService!: VaultQueryService;
  private routeOverlayGenerator!: RouteOverlayGenerator;
  private vaultQueryUnsubscribe: (() => void) | null = null;
  private vaultQueryRemovedUnsubscribe: (() => void) | null = null;
  private vaultQueryIndexedUnsubscribe: (() => void) | null = null;
  private vaultQueryProviderTablesChangedUnsubscribe: (() => void) | null = null;

  async onload() {
    PlacesPlugin._instance = this;
    this.codeBlockStartup = new CodeBlockStartup(this.app, (error, el) => {
      rootLogger.error('Error rendering block after startup:', error);
      renderError(el, { title: 'Error loading block', message: getErrorMessage(error) });
    });
    this.register(() => this.codeBlockStartup.cleanup());
    configureHostPrimitives({
      setIcon,
      notify: (message: string) => new Notice(message),
      isMobile: Platform.isMobile,
      renderNoteContent: (place, container) => renderPopupContent(this.app, place, container),
      renderMarkdown: (markdown, container, sourcePath, owner) => {
        const component = new Component();

        component.load();
        owner.register(() => component.unload());

        return MarkdownRenderer.render(this.app, markdown, container, sourcePath, component);
      },
      prepareCodeHighlighting: loadPrism,
    });
    configureUrlRequester(requestUrl);
    configureResourceUrls(this.app);
    setDevicePathsOpenable(canOpenDevicePaths(this.app));
    this.register(installPlacesGlobalErrorCapture(window));
    const loadedData = await this.loadData() as Partial<IPlacesPluginSettings> | null;

    if (loadedData === null) await this.quarantineUnreadableSettings();
    const cachePath = `${this.manifest.dir}/${ROUTE_OVERLAY_CACHE_FILE}`;

    this.routeOverlayCacheStorage = new RouteOverlayCacheFile(
      await RouteOverlayCacheFile.read(this.app.vault.adapter, cachePath),
      this.app.vault.adapter,
      cachePath,
    );
    const loadedSettings: Partial<IPlacesPluginSettings> = { ...(loadedData ?? {}) };

    delete (loadedSettings as { routeOverlayCache?: unknown }).routeOverlayCache;
    PlacesPlugin._settings = this.normalizeSettings({ ...DEFAULT_SETTINGS, ...loadedSettings });
    PlacesPlugin._settings.consoleLogLevel = normalizeConsoleLogLevel(PlacesPlugin._settings.consoleLogLevel);
    PlacesPlugin.configureTileCache();
    PlacesPlugin.configureOverlayDecodeCache();
    this.registerTileUsageTracking();
    configureMarkerIconRules(PlacesPlugin._settings.markerIconRules);
    configureWaypointIconMappings(PlacesPlugin._settings.waypointIconMappings);
    rootLogger.configure(PlacesPlugin._settings.consoleLogLevel);
    configureRequestLogging(PlacesPlugin._settings.developerMode);
    void this.applyDebugLogFileSetting();
    setOverlayCompressionLevel(PlacesPlugin._settings.overlayCompressionLevel);

    try {
      await initOverlayCompression();
    } catch (error) {
      logger.settings.error("Overlay compression failed to initialize", error);
      new Notice("Overlay compression failed to initialize. Overlay Source and Overlay Cache values cannot be read or written.", 8000);
    }

    this.trackDataService = new TrackDataService(this.app, () => PlacesPlugin.settings);
    this.overlayImportService = new OverlayImportService(() => PlacesPlugin.settings);
    this.trackImportController = new TrackImportController(this.app, this.trackDataService, this.overlayImportService);
    this.placeNoteController = new PlaceNoteController(this.app, () => PlacesPlugin.settings);
    this.vaultQueryService = new VaultQueryService(this.app);
    this.placeDataService = new PlaceDataService(this.app, this.trackDataService, this.vaultQueryService);
    this.routeOverlayGenerator = new RouteOverlayGenerator(
      this.app,
      {
        get: (name, origin) => origin ? this.originScopedRouteOverlay.get(name, origin) : this.routeOverlayServices.get(name),
        getNames: () => this.routeOverlayServices.getNames(),
      },
      this.vaultQueryService,
      () => PlacesPlugin.settings.defaultRouteLabelTemplate,
      () => PlacesPlugin.settings.units,
    );

    this.vaultQueryService.initialize().catch(() => {   });

    new CliController(this.app, this.overlayImportService, this.trackImportController, () => PlacesPlugin.settings).register(this);

    this.initializeBasesView();

    this.registerEditorExtension(placesHighlightPlugin);
    this.registerEvent((this.app.workspace as Events).on(VAULTQUERY_API_READY_EVENT, () => this.app.workspace.updateOptions()));
    this.registerEditorExtension(placesIndentExtension);
    this.registerEditorExtension(createPlacesCompletionExtension({
      app: this.app,
      getMapProviders: () => this.mapBlockProcessors.getNames(),
      getRouteProviders: () => this.routeOverlayServices.getNames(),
      getSnapProviders: () => this.snapServices.getNames(),
      getElevationProviders: () => this.elevationServices.getNames(),
      getTrackMatchProviders: () => this.trackMatchServices.getNames(),
      getTerrainProviders: () => [...this.terrainDemProviders.getNames(), 'aws'],
      getStylesForProvider: (providerName) => this.providerStyles.get(providerName) ?? [],
      getStyleProviders: () => this.providerStyles.getNames(),
      resolveMapProvider: (explicitProvider) => PlacesPlugin.resolveMapProvider(explicitProvider),
    }));

    this.registerEvent((this.app.workspace as Events).on(PLACES_EXTENSION_READY_EVENT, (payload: unknown) => {
      if (!isExtensionReadyEvent(payload)) return;
      const event = payload;

      this.loadExtension(event.pluginId, event.extension);
      this.rebuildExtensionRegistries();
      this.settingsTab?.update();
    }));

    this.registerEvent((this.app.workspace as Events).on(PLACES_EXTENSION_UNLOADED_EVENT, (payload: unknown) => {
      if (!isExtensionUnloadedEvent(payload)) return;
      const event = payload;

      this.extensionInstances.delete(event.pluginId);
      this.extensionReloads.cancel(event.pluginId);
      void this.disposeExtension(event.pluginId);
      this.extensionExports.delete(event.pluginId);
      this.rebuildExtensionRegistries();
      this.settingsTab?.update();
    }));

    this.initializeExtensions();
    this.registerCodeBlockProcessors();
    this.commandRegistrar = new CommandRegistrar(
      this,
      sourcePath => PlacesPlugin.placesServiceFor({ sourcePath }),
      this.trackImportController,
      () => PlacesPlugin.settings,
      (file, place) => this.placeNoteController.sync(file, place),
    );
    this.commandRegistrar.register();
    this.settingsTab = new PlacesSettingsTab(this.app, this, this.extensionSettingsGroups);
    this.addSettingTab(this.settingsTab);
    this.registerDragAndDrop();
    this.protocolController = new ProtocolController(
      this.app,
      sourcePath => PlacesPlugin.placesServiceFor({ sourcePath }),
      () => PlacesPlugin.settings,
      this.placeNoteCreationService,
    );
    this.protocolController.register(this);
    this.subscribeToVaultQueryEvents();

    this.app.workspace.onLayoutReady(() => {
      this.initializeExtensions();

      this.registerInterval(window.setInterval(() => {
        MapRefreshService.getInstance().checkAndRestoreMaps();
      }, 10000));
    });
  }

  private normalizeSettings(settings: IPlacesPluginSettings): IPlacesPluginSettings {
    delete (settings as unknown as Record<string, unknown>).defaultElevationService;
    settings.tileCacheDurationHoursDesktop = this.normalizeTileCacheDurationHours(settings.tileCacheDurationHoursDesktop);
    settings.tileCacheDurationHoursMobile = this.normalizeTileCacheDurationHours(settings.tileCacheDurationHoursMobile);
    settings.tileCacheMaxSizeMBDesktop = this.normalizeTileCacheMaxSizeMB(settings.tileCacheMaxSizeMBDesktop);
    settings.tileCacheMaxSizeMBMobile = this.normalizeTileCacheMaxSizeMB(settings.tileCacheMaxSizeMBMobile);
    settings.tileCacheEnabledProviders = this.normalizeTileCacheEnabledProviders(settings.tileCacheEnabledProviders);
    settings.newPlaceTagFilterPatterns = Array.isArray(settings.newPlaceTagFilterPatterns)
      ? settings.newPlaceTagFilterPatterns
      : DEFAULT_SETTINGS.newPlaceTagFilterPatterns;
    settings.markerIconRules = upgradeMarkerIconRules(settings.markerIconRules, settings.markerIconRulesRevision);
    settings.markerIconRulesRevision = CURRENT_MARKER_ICON_RULES_REVISION;
    settings.waypointIconMappings = upgradeWaypointIconMappings(settings.waypointIconMappings, settings.waypointIconMappingsRevision);
    settings.waypointIconMappingsRevision = CURRENT_WAYPOINT_ICON_MAPPINGS_REVISION;

    return settings;
  }

  private normalizeTileCacheDurationHours(value: number): number {
    return Number.isFinite(value) ? clamp(Math.floor(value), 0, 999) : DEFAULT_TILE_CACHE_DURATION_HOURS;
  }

  private normalizeTileCacheMaxSizeMB(value: number | undefined): number {
    return Number.isFinite(value) ? Math.max(1, Math.floor(value ?? DEFAULT_SETTINGS.tileCacheMaxSizeMBDesktop)) : DEFAULT_SETTINGS.tileCacheMaxSizeMBDesktop;
  }

  private normalizeTileCacheEnabledProviders(value: Record<string, boolean> | undefined): Record<string, boolean> {
    if (!value || typeof value !== 'object') return {};

    const normalized: Record<string, boolean> = {};

    for (const [providerName, enabled] of Object.entries(value)) {
      const key = providerName.trim().toLowerCase();

      if (!key || typeof enabled !== 'boolean') continue;
      normalized[key] = enabled;
    }

    return normalized;
  }

  private initializeExtensions() {
    let discovered = false;

    for (const { pluginId, extension } of new PluginDiscoveryService(this.app).discoverPlugins()) {
      if (this.extensionExports.has(pluginId)) continue;
      this.loadExtension(pluginId, extension);
      discovered = true;
    }

    if (discovered) {
      this.rebuildExtensionRegistries();
      this.settingsTab?.update();
    }
  }

  private loadExtension(pluginId: string, extension: IPlacePluginExtension): void {
    const apiVersion = extension.placesExtensionApiVersion;

    if (apiVersion !== PLACES_EXTENSION_API_VERSION) {
      if (!this.versionMismatchWarned.has(pluginId)) {
        this.versionMismatchWarned.add(pluginId);
        logger.extensions.error(`${pluginId} exposes Places extension API v${apiVersion ?? 'unknown'}; this plugin expects v${PLACES_EXTENSION_API_VERSION}.`);
        new Notice(`Places: ${pluginId} is incompatible with this version of Places and was skipped.`);
      }

      return;
    }

    this.extensionInstances.set(pluginId, extension);
    const pluginName = pluginId.slice('places-'.length);

    PlacesPlugin.settings.extensionSettings[pluginName] ??= {};
    void this.disposeExtension(pluginId);
    this.extensionExports.delete(pluginId);

    try {
      const exports = extension.getPlaceExports(
        this.app,
        PlacesPlugin.settings.extensionSettings[pluginName],
        extensionHostSettings(PlacesPlugin.settings),
        this.buildHostServices(),
      );

      if (exports.apiVersion !== PLACES_EXTENSION_API_VERSION) {
        throw new Error(`factory returned API v${exports.apiVersion ?? 'unknown'}`);
      }

      this.extensionExports.set(pluginId, { name: pluginName, exports });
    } catch (error) {
      this.extensionExports.delete(pluginId);
      logger.extensions.error(`Failed to initialize ${pluginId}`, error);
      new Notice(`Places: ${pluginId} failed to initialize and was skipped.`);
    }
  }

  scheduleExtensionReload(pluginName: string): void {
    this.extensionReloads.schedule(`places-${pluginName}`);
  }

  scheduleAllExtensionReloads(): void {
    this.extensionReloads.scheduleAll(this.extensionInstances.keys());
  }

  private async reloadExtensions(pluginIds: readonly string[]): Promise<void> {
    if (pluginIds.length === 0) return;

    for (const pluginId of pluginIds) {
      const extension = this.extensionInstances.get(pluginId);

      if (!extension) continue;
      await this.disposeExtension(pluginId);
      this.extensionExports.delete(pluginId);
      this.loadExtension(pluginId, extension);
    }

    this.rebuildExtensionRegistries();

    await MapRefreshService.getInstance().refreshAllBlocks({ force: true });
  }

  private async disposeExtension(pluginId: string): Promise<void> {
    const current = this.extensionExports.get(pluginId)?.exports;

    if (!current) return;

    for (const provider of current.providers ?? []) {
      try {
        provider.map?.cleanup();
      } catch (error) {
        logger.extensions.warn(`Failed to clean up ${pluginId} map provider`, error);
      }
    }

    try {
      const disposal = current.dispose?.();

      if (disposal) await disposal;
    } catch (error) {
      logger.extensions.warn(`Failed to dispose ${pluginId}`, error);
    }
  }

  private rebuildExtensionRegistries(): void {
    this.placesServices.clear();
    this.mapBlockProcessors.clear();
    this.mapProviderDefaults.clear();
    this.elevationServices.clear();
    this.routeOverlayServices.clear();
    this.snapServices.clear();
    this.trackMatchServices.clear();
    this.rawPlacesServices.clear();
    this.rawElevationServices.clear();
    this.rawRouteOverlayServices.clear();
    this.rawSnapServices.clear();
    this.rawTrackMatchServices.clear();
    this.originScopedPlaces.clear();
    this.originScopedElevation.clear();
    this.originScopedRouteOverlay.clear();
    this.originScopedSnap.clear();
    this.originScopedTrackMatch.clear();
    this.originScopedAggregators.clear();
    this.terrainDemProviders.clear();
    this.providerStyles.clear();
    this.imageAlignmentProcessors.clear();
    this.extensionCodeBlockHandlers.clear();
    this.extensionColonTextKeys.clear();
    this.extensionIndexDependencies.clear();
    this.registeredProviderExports = [];
    this.registeredPopupRenderers = [];
    this.registeredOverlayPresets = new Map();

    for (const key of Object.keys(this.extensionSettingsGroups)) {
      delete this.extensionSettingsGroups[key];
    }

    const registry = CodeBlockRegistry.instance;

    registry.clear();
    registry.registerDefinitions(MAIN_PLUGIN_DEFINITIONS);
    registry.registerHighlightConfigs(MAIN_PLUGIN_HIGHLIGHT_CONFIGS);

    const previousCommandIds = this.extensionCommandIds;

    this.extensionCommandIds = new Set<string>();
    this.extensionCommandHelp = [];
    const popupRenderers = new Map<string, PopupRenderer>();
    const overlayPresets = new Map<string, VectorTileOverlayPreset>();

    for (const renderer of [createImagePopupRenderer(this.app), createKnapPopupRenderer((reference, sourcePath) => readKnapTemplateFile(this.app, reference, sourcePath))]) {
      popupRenderers.set(renderer.id, renderer);
    }

    for (const { name: pluginName, exports } of this.extensionExports.values()) {
      for (const renderer of exports.popupRenderers ?? []) {
        if (!isPopupRendererId(renderer.id) || (renderer.kind !== 'sections' && renderer.kind !== 'dom') || typeof renderer.render !== 'function') {
          logger.extensions.warn(`Invalid popup renderer exported by places-${pluginName}; renderer ignored.`);
          continue;
        }

        if (popupRenderers.has(renderer.id)) {
          logger.extensions.warn(`Duplicate popup renderer id "${renderer.id}" ignored.`);
          continue;
        }

        popupRenderers.set(renderer.id, renderer);
      }

      for (const preset of exports.overlayPresets ?? []) {
        if (!isPopupRendererId(preset.id) || typeof preset.tiles !== 'function' || !Array.isArray(preset.layers)) {
          logger.extensions.warn(`Invalid overlay preset exported by places-${pluginName}; preset ignored.`);
          continue;
        }

        if (overlayPresets.has(preset.id)) {
          logger.extensions.warn(`Duplicate overlay preset id "${preset.id}" ignored.`);
          continue;
        }

        overlayPresets.set(preset.id, preset);
      }

      if (exports.providers) {
        this.registeredProviderExports.push(...exports.providers);

        exports.providers.forEach(provider => {
          const providerName = provider.name;

          if (provider.geocoding) {
            this.rawPlacesServices.set(providerName.toLowerCase(), provider.geocoding.service);
            this.placesServices.register(providerName, this.wrapPlacesService(provider.geocoding.service, providerName.toLowerCase()));
            addIcon(providerName, provider.geocoding.icon);
          }

          if (provider.map) {
            this.mapBlockProcessors.register(providerName, provider.map);
          }

          this.mapProviderDefaults.register(providerName, provider.mapDefaults ?? {});

          if (provider.styles) {
            this.providerStyles.register(providerName, toProviderStyles(provider));
          }

          if (provider.elevation) {
            this.rawElevationServices.set(providerName.toLowerCase(), provider.elevation);
            this.elevationServices.register(providerName, this.wrapElevationService(provider.elevation, providerName.toLowerCase()));
          }

          if (provider.trackMatch) {
            this.rawTrackMatchServices.set(providerName.toLowerCase(), provider.trackMatch);
            this.trackMatchServices.register(providerName, new TrackMatchTrackingDecorator(provider.trackMatch, providerName.toLowerCase(), this.apiUsage));
          }

          if (provider.terrain) {
            this.terrainDemProviders.register(providerName, provider.terrain);
          }

          if (provider.routeOverlay) {
            this.rawRouteOverlayServices.set(providerName.toLowerCase(), provider.routeOverlay);
            this.routeOverlayServices.register(providerName, this.wrapRouteOverlayService(provider.routeOverlay, providerName.toLowerCase()));
          }

          if (provider.snap) {
            this.rawSnapServices.set(providerName.toLowerCase(), provider.snap);
            this.snapServices.register(providerName, new SnapTrackingDecorator(provider.snap, providerName.toLowerCase(), this.apiUsage));
          }

          if (provider.imageAlignment) {
            this.imageAlignmentProcessors.register(providerName, provider.imageAlignment);
          }
        });
      }

      if (exports.commands) {
        exports.commands.forEach(command => {
          this.extensionCommandIds.add(command.id);
          this.extensionCommandHelp.push({ name: command.name, description: command.description ?? '' });
          this.addCommand(command);
        });
      }

      if (exports.codeBlockProcessors) {
        exports.codeBlockProcessors.forEach(processor => {
          this.registerExtensionCodeBlockProcessor(processor.blockType, processor.processor, processor.colonTextKeys, processor.sourceFormat, processor.indexDependencies);
        });
      }

      if (exports.codeBlockDefinitions) {
        registry.registerDefinitions(exports.codeBlockDefinitions);
      }

      if (exports.highlightConfigs) {
        registry.registerHighlightConfigs(exports.highlightConfigs);
      }

      if (exports.settingsGroup) {
        this.extensionSettingsGroups[pluginName] = exports.settingsGroup;
      }
    }

    for (const commandId of previousCommandIds) {
      if (!this.extensionCommandIds.has(commandId)) {
        this.removeCommand(commandId);
      }
    }

    registry.setProvidedValues('style', this.providerStyles.getNames().flatMap(name => (this.providerStyles.get(name) ?? []).map(style => style.id)));
    this.registeredPopupRenderers = [...popupRenderers.values()];
    this.registeredOverlayPresets = overlayPresets;
    registry.setProvidedValues('preset', [...overlayPresets.values()].map(preset => ({
      value: preset.id,
      description: preset.description,
    })));
    registry.setProvidedValues('renderer', [...popupRenderers.values()].map(renderer => ({
      value: renderer.id,
      description: renderer.description,
    })));

    retryMapSurfacesWaitingForProvider(name => this.mapBlockProcessors.get(name) !== undefined);
  }

  // Provider capability bundles registered by the last extension scan.
  getRegisteredProviders(): readonly PlaceProviderExport[] {
    return this.registeredProviderExports;
  }

  getRegisteredMapTools() {
    const tools = [...this.extensionExports.values()].flatMap(entry => entry.exports.mapTools ?? []);
    const unique = new Map<string, typeof tools[number]>();

    for (const tool of tools) {
      if (unique.has(tool.id)) {
        logger.extensions.warn(`Duplicate map tool id "${tool.id}" ignored.`);
        continue;
      }

      unique.set(tool.id, tool);
    }

    return [...unique.values()];
  }

  getRegisteredPopupRenderers(): readonly PopupRenderer[] {
    return this.registeredPopupRenderers;
  }

  override registerMarkdownCodeBlockProcessor(language: string, handler: Parameters<Plugin['registerMarkdownCodeBlockProcessor']>[1], sortOrder?: number): ReturnType<Plugin['registerMarkdownCodeBlockProcessor']> {
    return super.registerMarkdownCodeBlockProcessor(language, (source, el, ctx) =>
      this.codeBlockStartup.process(source, el, ctx, handler), sortOrder);
  }

  private registerExtensionCodeBlockProcessor(blockType: string, processor: (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => void | Promise<void>, colonTextKeys?: readonly string[], sourceFormat: 'yaml' | 'yaml-template' = 'yaml', indexDependencies?: 'notes'): void {
    this.extensionCodeBlockHandlers.set(blockType, processor);
    this.extensionSourceFormats.set(blockType, sourceFormat);

    if (indexDependencies) this.extensionIndexDependencies.set(blockType, indexDependencies);
    else this.extensionIndexDependencies.delete(blockType);

    if (colonTextKeys?.length) this.extensionColonTextKeys.set(blockType, colonTextKeys);
    else this.extensionColonTextKeys.delete(blockType);

    if (this.registeredExtensionBlockTypes.has(blockType)) {
      return;
    }

    this.registeredExtensionBlockTypes.add(blockType);

    const processExtensionBlock = async (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> => {
      const handler = this.extensionCodeBlockHandlers.get(blockType);

      if (!handler) {
        renderError(el, {
          title: "Plugin unavailable",
          message: `The plugin that renders ${blockType} blocks is disabled.`
        });

        return;
      }

      try {
        const blockSource = splitExtensionBlockSource(source, this.extensionSourceFormats.get(blockType));
        const parsed = parseCodeBlock(blockSource.settings, { colonTextKeys: this.extensionColonTextKeys.get(blockType) });
        const autoRefresh = parsed.settings.autorefresh;
        const parameterSupport = new BlockParameterSupport(this.app, this.vaultQueryService);
        const parameters = await parameterSupport.apply(parsed, el, ctx);

        registerRefreshableCodeBlock({
          autoRefresh,
          source,
          el,
          ctx,
          process: processExtensionBlock,
          shouldAutoRefresh: createOwnNoteEditRefreshGuard(source, ctx.sourcePath, path => readNoteProperties(this.app, path)),
          ariaLabel: `Refresh ${blockType}`,
          onError: error => rootLogger.error(`Refresh ${blockType} failed:`, error),
          usesParameters: parameters !== null,
          query: this.extensionIndexDependencies.get(blockType) === 'notes' && parameters === null ? null : undefined,
        });
        applyBlockWidth(el, new CodeBlockReader(parsed.settings).text('width'));
        const resolvedSource = parameters
          ? blockSource.withSettings(stringifyYaml(parsed.settings).trimEnd())
          : source;

        await handler(resolvedSource, el, ctx);

        await parameters?.renderStrip();
      } catch (error) {
        rootLogger.error(`Error processing ${blockType} code block:`, error);
        this.renderCodeBlockError(el, blockType, error);
      }
    };

    this.registerMarkdownCodeBlockProcessor(blockType, processExtensionBlock);
  }

  // Keep processor failures inside the code block instead of falling through to Obsidian's generic notice.
  private renderCodeBlockError(el: HTMLElement, blockType: string, error: unknown): void {
    if (error instanceof BlockSyntaxError) {
      const validKeys = CodeBlockRegistry.instance.getValidKeys(blockType);
      const unknownKeyNote = error.key && validKeys && !validKeys.has(error.key)
        ? ` "${error.key}" is not a ${blockType} setting.`
        : '';

      renderError(el, {
        icon: "⚠️",
        title: "Block Syntax Error",
        message: `${error.message}${unknownKeyNote}`,
      });

      return;
    }

    renderError(el, {
      icon: "⚠️",
      title: "Error",
      message: getErrorMessage(error),
    });
  }

  private buildHostServices(): IPlacesHostServices {
    return {
      get placeNotes() { return PlacesPlugin.placeNoteHost; },
      parameters: {
        getNoteValue: (sourcePath, name) => QueryParameterState.resolveNoteValue(sourcePath, name),
        setNoteValue: (sourcePath, name, value) => {
          const stateKey = NoteParameterRegistry.noteStateKey(sourcePath);
          const definition = NoteParameterRegistry.definitionsFor(sourcePath).find(entry => entry.name === name);

          if (!definition && PlacesPlugin.settings.developerMode) {
            logger.extensions.warn(`Host setNoteValue: no places-parameters block in "${sourcePath}" declares "${name}"; the value will not reach a query.`);
          }

          applyExternalParameterValue(stateKey, name, value === null ? (definition?.defaultValue ?? '') : value);
          MapRefreshService.getInstance().refreshParameterConsumers(sourcePath);
        },
        subscribeNoteValue: (sourcePath, name, handler) => QueryParameterState.subscribe(
          NoteParameterRegistry.noteStateKey(sourcePath),
          name,
          value => handler(value),
        ),
      },
      dateRanges: {
        get: (sourcePath, binding) => {
          const values = QueryParameterState.peek(NoteParameterRegistry.noteStateKey(sourcePath));
          const start = values?.[binding?.startParameter ?? 'startDate'];
          const end = values?.[binding?.endParameter ?? 'endDate'];

          return {
            start: typeof start === 'string' ? start : undefined,
            end: typeof end === 'string' ? end : undefined,
          };
        },
        set: (sourcePath, range, binding) => {
          const stateKey = NoteParameterRegistry.noteStateKey(sourcePath);

          if (range.start !== undefined) applyExternalParameterValue(stateKey, binding?.startParameter ?? 'startDate', range.start);
          if (range.end !== undefined) applyExternalParameterValue(stateKey, binding?.endParameter ?? 'endDate', range.end);
          MapRefreshService.getInstance().refreshParameterConsumers(sourcePath);
        },
        subscribe: (sourcePath, handler, binding) => {
          const stateKey = NoteParameterRegistry.noteStateKey(sourcePath);
          let queued = false;
          const emit = () => {
            if (queued) return;
            queued = true;
            queueMicrotask(() => {
              queued = false;
              const values = QueryParameterState.peek(stateKey);
              const start = values?.[binding?.startParameter ?? 'startDate'];
              const end = values?.[binding?.endParameter ?? 'endDate'];

              handler({
                start: typeof start === 'string' ? start : undefined,
                end: typeof end === 'string' ? end : undefined,
              });
            });
          };
          const offStart = QueryParameterState.subscribe(stateKey, binding?.startParameter ?? 'startDate', emit);
          const offEnd = QueryParameterState.subscribe(stateKey, binding?.endParameter ?? 'endDate', emit);

          return () => { offStart(); offEnd(); };
        },
      },
      selections: {
        get: (sourcePath, channel) => this.sharedSelections.get(sourcePath, channel),
        publish: (sourcePath, selection, channel) => this.sharedSelections.publish(sourcePath, selection, channel),
        subscribe: (sourcePath, handler, channel) => this.sharedSelections.subscribe(sourcePath, handler, channel),
      },
      tracks: {
        loadTrackFromPath: (pathSetting, sourcePath, options) => this.trackDataService.loadTrackFromPath(pathSetting, sourcePath, options),
        resolveMarkdownTrackFile: (pathSetting, sourcePath) => this.trackDataService.resolveMarkdownTrackFile(pathSetting, sourcePath),
      },
      maps: {
        resolveMapProvider: (explicitProvider) => PlacesPlugin.resolveMapProvider(explicitProvider),
        getMapProviderDefaults: (providerName) => PlacesPlugin.getMapProviderDefaults(providerName),
        resolveMapConfig: (request) => {
          const resolved = resolveMapSettings({
            providerName: request.providerName,
            rawBlockSettings: request.blockSettings,
            placeCount: request.placeCount,
            warnings: request.warnings,
          });

          return { config: resolved.config, clusteringEnabled: resolved.clusteringEnabled };
        },
        renderMapSurface: async (request) => {
          const surface = await renderMapSurface(buildHostSurfaceRenderOptions(request));

          if (!surface.rendered || !surface.controller) return null;
          const mapContainer = surface.mapContainer;

          return {
            mapContainer,
            update: async (renderPlan) => {
              const controller = getMapSurfaceController(mapContainer);

              if (!controller) return false;
              const plan = withHostCapabilities(renderPlan);

              controller.setPlan(plan, { source: 'host-update' });
              await controller.reconcile();

              return controller.getState().appliedPlanSignature === plan.signature;
            },
            dispose: () => cleanupMapContainer(mapContainer),
          };
        },
        disposeMapSurfaces: (element) => {
          for (const mapContainer of element.querySelectorAll<HTMLElement>('.places-map-container')) cleanupMapContainer(mapContainer);
        },
      },
      trackMatch: {
        get: (providerName, origin) => PlacesPlugin.getTrackMatchService(providerName, origin),
        getFirst: (origin) => PlacesPlugin.getFirstTrackMatchService(origin),
        getNames: () => this.trackMatchServices.getNames(),
      },
      apiUsage: this.apiUsage,
    };
  }

  private wrapPlacesService(service: IPlacesService, serviceName: string, origin?: ApiUsageOrigin): IPlacesService {
    const trackedService = new PlacesTrackingDecorator(service, serviceName, this.apiUsage, () => PlacesPlugin.settings.poiFilterPatterns, origin);

    return new PlacesCachingDecorator(trackedService, serviceName, this.apiCacheStorage, () => this.recordCacheHit(serviceName, API_USAGE_SERVICES.geocoding, origin));
  }

  private wrapElevationService(service: IElevationService, serviceName: string, origin?: ApiUsageOrigin): IElevationService {
    const trackedService = new ElevationTrackingDecorator(service, serviceName, this.apiUsage, origin);

    return new ElevationCachingDecorator(trackedService, serviceName, this.elevationCacheStorage, () => this.recordCacheHit(serviceName, API_USAGE_SERVICES.elevation, origin));
  }

  private wrapRouteOverlayService(service: RouteOverlayService, serviceName: string, origin?: ApiUsageOrigin): RouteOverlayService {
    const trackedService = new RouteOverlayTrackingDecorator(service, serviceName, this.apiUsage, origin);

    return new RouteOverlayCachingDecorator(trackedService, serviceName, this.routeOverlayCacheStorage, () => this.recordCacheHit(serviceName, API_USAGE_SERVICES.routeOverlay, origin));
  }

  private recordCacheHit(serviceName: string, service: string, origin?: ApiUsageOrigin): void {
    this.apiUsage.record({ provider: serviceName, service, success: true, durationMs: 0, cached: true, ...(origin ? { origin } : {}) });
  }

  private registerCodeBlockProcessors() {
    const blockParameters = new BlockParameterSupport(this.app, this.vaultQueryService);

    this.templateNoteService = new TemplateNoteService(this.app);
    this.placeNoteCreationService = new PlaceNoteCreationService(this.app, () => PlacesPlugin.settings);
    this.templateRenameQueue = new TemplateRenameQueue(this.app, () => void MapRefreshService.getInstance().refreshAllBlocks());
    this.codeBlockProcessor = new PlacesCodeBlockProcessor(this.app, this, this.placeDataService, this.mapBlockProcessors, () => this.getRegisteredProviders(), this.vaultQueryService, this.trackDataService, this.routeOverlayGenerator, this.templateNoteService, () => PlacesPlugin.settings.defaultTemplate);
    this.registerMarkdownCodeBlockProcessor("places",
      (source, el, ctx) => this.codeBlockProcessor.processMarkdownCodeBlock(source, el, ctx)
    );

    this.placesChartBlockProcessor = new PlacesChartBlockProcessor(this.app, this.trackDataService, blockParameters);
    this.registerMarkdownCodeBlockProcessor("places-chart",
      (source, el, ctx) => this.placesChartBlockProcessor.processCodeBlock(source, el, ctx)
    );

    const similarTracksProcessor = new SimilarTracksBlockProcessor(this.app, this.trackDataService, blockParameters);

    this.registerMarkdownCodeBlockProcessor("places-similar",
      (source, el, ctx) => similarTracksProcessor.processCodeBlock(source, el, ctx)
    );

    const compareTracksProcessor = new CompareTracksBlockProcessor(this.app, this.trackDataService, blockParameters);

    this.registerMarkdownCodeBlockProcessor("places-compare",
      (source, el, ctx) => compareTracksProcessor.processCodeBlock(source, el, ctx)
    );

    const parametersProcessor = new PlacesParametersBlockProcessor(this.app, this.vaultQueryService);

    this.registerMarkdownCodeBlockProcessor("places-parameters",
      (source, el, ctx) => parametersProcessor.processCodeBlock(source, el, ctx)
    );

    const snapProcessor = new SnapBlockProcessor(this.app, this.trackDataService, blockParameters);

    this.registerMarkdownCodeBlockProcessor("places-snap",
      (source, el, ctx) => snapProcessor.processCodeBlock(source, el, ctx)
    );

    const elevationProcessor = new ElevationBlockProcessor(this.app, this.trackDataService, blockParameters);

    this.registerMarkdownCodeBlockProcessor("places-elevation",
      (source, el, ctx) => elevationProcessor.processCodeBlock(source, el, ctx)
    );

    const heatmapProcessor = new HeatmapBlockProcessor(this.app, this.trackDataService, this.placeDataService, blockParameters);

    this.registerMarkdownCodeBlockProcessor("places-heatmap",
      (source, el, ctx) => heatmapProcessor.processCodeBlock(source, el, ctx)
    );

    this.helpCodeBlockProcessor = new PlacesHelpCodeBlockProcessor(this.app, this, this.mapBlockProcessors, () => this.getRegisteredProviders(),
      () => Array.from(this.extensionCodeBlockHandlers.keys()).filter((blockType) => blockType.endsWith('-help')),
      () => [...this.commandRegistrar.getCommandHelp(), ...this.extensionCommandHelp],
      () => this.getRegisteredPopupRenderers(),
      () => [...this.registeredOverlayPresets.values()]);

    for (const helpType of this.helpCodeBlockProcessor.getHelpTypes()) {
      this.registerMarkdownCodeBlockProcessor(helpType,
        (_source, el) => this.helpCodeBlockProcessor.processHelpCodeBlock(helpType, el)
      );
    }

    const referenceProcessor = new PlacesReferenceCodeBlockProcessor();

    this.registerMarkdownCodeBlockProcessor("places-reference",
      (_source, el) => referenceProcessor.processReferenceCodeBlock(el)
    );

    this.registerMarkdownCodeBlockProcessor("places-image-align",
      (source, el, ctx) => this.processImageAlignCodeBlock(source, el, ctx)
    );
  }

  private async processImageAlignCodeBlock(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
    try {
      const settings = parseCodeBlock(source).settings;

      applyBlockWidth(el, new CodeBlockReader(settings).text('width'));
      const requested = optionalStringSetting(settings, 'mapProvider')?.toLowerCase();
      const availableProviders = this.imageAlignmentProcessors.getNames();

      if (availableProviders.length === 0) {
        renderError(el, {
          icon: "🖼️",
          title: "No Image Alignment Providers",
          message: "Enable a map provider plugin that supports image alignment (Mapbox, MapTiler, Geoapify, Stadia, Thunderforest, OpenFreeMap, or Radar).",
          className: "image-align-error"
        });

        return;
      }

      if (requested && !this.imageAlignmentProcessors.has(requested)) {
        renderError(el, {
          icon: "🖼️",
          title: "Image Alignment Provider Not Found",
          message: `"${requested}" does not support image alignment.`,
          className: "image-align-error"
        });
        const helpDiv = el.createDiv({ cls: 'places-help-section' });

        helpDiv.createEl("p", { text: `Providers that do: ${availableProviders.join(", ")}` });

        return;
      }

      const defaultProvider = PlacesPlugin.resolveMapProvider(undefined).toLowerCase();
      const providerName = requested
        ?? (this.imageAlignmentProcessors.has(defaultProvider) ? defaultProvider : availableProviders[0]);

      const processor = this.imageAlignmentProcessors.get(providerName)!;
      const overlayService = this.imageAlignmentOverlayService ??= new OverlayService(this.app);

      await processor(source, el, ctx, {
        loadOverlays: definitions => overlayService.loadOverlays(definitions),
        formatDistance: value => formatMetersInSystem(meters(value), PlacesPlugin.settings.units, 1),
      });
    } catch (error) {
      rootLogger.error('Error processing places-image-align code block:', error);
      this.renderCodeBlockError(el, 'places-image-align', error);
    }
  }

  private registerDragAndDrop() {
    this.dragDropHandler = new DragDropHandler(this.app, this.overlayImportService, () => PlacesPlugin.settings);

    this.registerEvent(this.app.workspace.on("editor-drop", (evt: DragEvent, _editor: Editor) => {
      if (evt.defaultPrevented) {
        return;
      }

      const handled = this.dragDropHandler.handleEditorDrop(evt);

      if (!handled) {
        return;
      }

      evt.preventDefault();
    }));

    // Capture phase (true) intercepts events before Obsidian's default handlers,
    // keeping GPX files from being copied into the vault when handled here.
    this.registerDomEvent(activeDocument, "drop", (evt: DragEvent) => this.dragDropHandler.handleDrop(evt), { capture: true });
    this.registerDomEvent(activeDocument, "dragover", (evt: DragEvent) => this.dragDropHandler.handleDragOver(evt), { capture: true });
    this.registerDomEvent(activeDocument, "dragenter", (evt: DragEvent) => this.dragDropHandler.handleDragEnter(evt), { capture: true });
    this.registerDomEvent(activeDocument, "dragleave", (evt: DragEvent) => this.dragDropHandler.handleDragLeave(evt), { capture: true });
  }

  private scheduleDataBlockRefresh(path: string, source?: BlockFileChange['source']): void {
    const previous = this.pendingBlockRefreshChanges.get(path);

    if (!previous || source === undefined) this.pendingBlockRefreshChanges.set(path, { path, source });

    if (this.blockRefreshTimer !== null) {
      window.clearTimeout(this.blockRefreshTimer);
    }

    this.blockRefreshTimer = window.setTimeout(() => {
      const fileChanges = Array.from(this.pendingBlockRefreshChanges.values());

      this.pendingBlockRefreshChanges.clear();
      this.blockRefreshTimer = null;
      void BlockRefreshRegistry.refreshAll({ fileChanges });
    }, 200);
  }

  private subscribeToVaultQueryEvents(): void {
    this.registerEvent(this.app.vault.on('create', file => recordSourcePathCreation(file.path)));
    this.registerEvent(this.app.metadataCache.on('changed', file => {
      this.vaultQueryService.invalidateCache(file.path);
      MapRefreshService.getInstance().onSourceContextChanged(file.path);
      this.scheduleDataBlockRefresh(file.path);
    }));
    MapRefreshService.getInstance().setQueryRelationResolver(query => this.vaultQueryService.resolveQueryRelations(query));
    this.vaultQueryUnsubscribe = this.vaultQueryService.onFileIndexed((paths, source) => {
      try {
        const refreshService = MapRefreshService.getInstance();

        refreshService.onFilesIndexed(paths, source);
      } catch (error) {
        logger.refresh.error('Error queueing map refresh on file indexed', error);
      }

      for (const path of paths) this.scheduleDataBlockRefresh(path, source);
    });
    this.vaultQueryRemovedUnsubscribe = this.vaultQueryService.onFileRemoved((path) => {
      try {
        const refreshService = MapRefreshService.getInstance();

        refreshService.onFileRemoved(path);
      } catch (error) {
        logger.refresh.error('Error queueing map refresh on file removed', error);
      }

      this.scheduleDataBlockRefresh(path);
    });
    this.vaultQueryIndexedUnsubscribe = this.vaultQueryService.onVaultIndexed(() => {
      try {
        const refreshService = MapRefreshService.getInstance();

        refreshService.onVaultIndexed();
      } catch (error) {
        logger.refresh.error('Error queueing map refresh on vault indexed', error);
      }
    });
    this.vaultQueryProviderTablesChangedUnsubscribe = this.vaultQueryService.onProviderTablesChanged((tables) => {
      try {
        const refreshService = MapRefreshService.getInstance();

        refreshService.onProviderTablesChanged(tables);
      } catch (error) {
        logger.refresh.error('Error queueing map refresh on provider tables changed', error);
      }
    });

    this.registerEvent((this.app.workspace as Events).on('dataview:refresh-views', () => {
      try {
        MapRefreshService.getInstance().onDataviewIndexChanged();
      } catch (error) {
        logger.refresh.error('Error queueing map refresh on dataview index changed', error);
      }
    }));

    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      try {
        this.vaultQueryService.invalidateCache(oldPath);
        this.vaultQueryService.invalidateCache(file.path);
        const refreshService = MapRefreshService.getInstance();

        refreshService.onFileRenamed(oldPath, file.path);
        this.scheduleDataBlockRefresh(file.path);
      } catch (error) {
        logger.refresh.error('Error queueing map refresh on file rename', error);
      }
    }));

    this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
      MapRefreshService.getInstance().onLeafChange();
    }));

    this.registerEvent(this.app.vault.on('modify', (file) => {
      try {
        const refreshService = MapRefreshService.getInstance();

        refreshService.onSourceFileModified(file.path);
        this.onTemplateNoteMaybeChanged(file.path);
      } catch (error) {
        logger.refresh.error('Error queueing map refresh on file modify', error);
      }
    }));

    this.registerEvent(this.app.vault.on('create', (file) => this.onTemplateNoteMaybeChanged(file.path)));
    this.registerEvent(this.app.vault.on('delete', (file) => this.onTemplateNoteMaybeChanged(file.path)));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      this.onTemplateNoteMaybeChanged(file.path);
      this.onTemplateNoteMaybeChanged(oldPath);
      void this.templateRenameQueue.queue(oldPath, file.path)
        .catch(error => logger.refresh.error('Error updating template references after rename', error));
    }));
  }

  // Templates can live in any note; there is no path test to skip on.
  private onTemplateNoteMaybeChanged(path: string): void {
    if (!this.templateNoteService.isCached(path)) return;
    this.templateNoteService.invalidate(path);
    void MapRefreshService.getInstance().refreshAllBlocks();
  }

  private initializeBasesView() {
    (this as unknown as ObsidianPluginWithBasesViewRegistration).registerBasesView("places-map", {
        name: "Places Map",
        icon: "lucide-map",
        factory: (controller: unknown, containerEl: HTMLElement) => new PlacesBasesView(controller as ConstructorParameters<typeof PlacesBasesView>[0], containerEl, this.basesLabelCaches),
        options: () => PlacesBasesView.getViewOptions(),
    });
  }

  // loadData answers null both for a vault with no settings yet and for a file
  // it could not parse.
  private async quarantineUnreadableSettings(): Promise<void> {
    const path = `${this.manifest.dir}/data.json`;

    try {
      if (!(await this.app.vault.adapter.exists(path))) return;
      const contents = await this.app.vault.adapter.read(path);

      if (!contents.trim()) return;
      this.settingsUnreadable = true;
      const kept = `${this.manifest.dir}/data.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

      await this.app.vault.adapter.write(kept, contents);
      logger.settings.error('Settings file could not be read', { path, size: contents.length, kept });
      new Notice(`Places settings could not be read. A copy was kept as ${kept.split('/').pop()}, and this session will not save over data.json. Restore the file, then restart Obsidian.`, 0);
    } catch (error) {
      logger.settings.error('Settings file could not be set aside', error);
    }
  }

  private async applyDebugLogFileSetting(): Promise<void> {
    const wanted = PlacesPlugin._settings.developerMode;

    if (wanted === Boolean(this.debugLogFile)) return;

    if (!wanted) {
      const file = this.debugLogFile;

      this.debugLogFile = null;
      await file?.stop();

      return;
    }

    this.debugLogFile = await DebugLogFile.start(this.app, this.manifest.id);
  }

  onunload(): void {
    void this.debugLogFile?.stop();
    this.debugLogFile = null;
    TileCache.configureUsageSink(null);
    trackPreparation.dispose();
    this.basesLabelCaches.clear();

    if (this.vaultQueryUnsubscribe) {
      this.vaultQueryUnsubscribe();
      this.vaultQueryUnsubscribe = null;
    }

    if (this.vaultQueryRemovedUnsubscribe) {
      this.vaultQueryRemovedUnsubscribe();
      this.vaultQueryRemovedUnsubscribe = null;
    }

    if (this.vaultQueryIndexedUnsubscribe) {
      this.vaultQueryIndexedUnsubscribe();
      this.vaultQueryIndexedUnsubscribe = null;
    }

    if (this.vaultQueryProviderTablesChangedUnsubscribe) {
      this.vaultQueryProviderTablesChangedUnsubscribe();
      this.vaultQueryProviderTablesChangedUnsubscribe = null;
    }

    if (this.blockRefreshTimer !== null) {
      window.clearTimeout(this.blockRefreshTimer);
      this.blockRefreshTimer = null;
    }

    this.pendingBlockRefreshChanges.clear();
    this.extensionReloads.dispose();
    this.settingsTab = null;

    this.templateRenameQueue.dispose();

    this.vaultQueryService.cleanup();

    MapRefreshService.getInstance().cleanup();

    void TileCache.shutdown();
    void PlacesPlugin.flushApiStatsSave(false);
  }
}
