import { logger as rootLogger, clamp, installPlacesGlobalErrorCapture } from "places-shared/utils";
import { DEFAULT_SPEED_WINDOW, parseMetricWindow } from "places-shared/settings";
import { setSpeedWindow } from "./services/TrackPointProcessor";
import { normalizeConsoleLogLevel } from 'obsidian-debug-logger';
import { App, Editor, Events, MarkdownPostProcessorContext, Notice, Plugin, addIcon, Platform, stringifyYaml } from "obsidian";
import { createPlacesCompletionExtension } from "./editor/PlacesCompletionExtension";
import { placesHighlightPlugin } from "./editor/PlacesHighlightExtension";
import { placesIndentExtension } from "./editor/PlacesIndentExtension";
import { AggregatorApiService } from "./places-services/AggregatorApiService";
import { TileCache, configureMarkerIconRules, resolveTerrainDemSpec, type TerrainDemResolution, type TerrainDemSpec } from "places-shared/map";
import { IPlacesPluginSettings, DEFAULT_SETTINGS, type IPlacesExtensionHostSettings } from "places-shared/settings";
import { IPlacesService, IMapBlockProcessor, IElevationService, ITrackMatchService, type IPlacesHostServices, PLACES_EXTENSION_READY_EVENT, PLACES_EXTENSION_UNLOADED_EVENT, PLACES_EXTENSION_API_VERSION, type IPlacePluginExtension, type IPlacePluginExtensionExports, type ImageAlignmentProcessor, type RouteOverlayService, type ISnapService, type ITerrainDemProvider, type PlaceProviderExport, type PlaceExtensionReadyEvent, type PlaceExtensionUnloadedEvent, type ExtensionSettingsGroup } from "places-shared/services";
import { ServiceRegistry } from "./services/ServiceRegistry";
import { PluginDiscoveryService } from "./services/PluginDiscoveryService";
import { renderError, SessionCacheStorage, getErrorMessage, configureRequestLogging, setOverlayCompressionLevel } from "places-shared/utils";
import { initOverlayCompression } from "places-shared/compression";
import { PlacesSettingsTab } from "./PlacesSettingsTab";
import { PlaceDataService } from "./services/PlaceDataService";
import { TrackDataService } from "./services/TrackDataService";
import { PlacesTrackingDecorator } from "./places-services/PlacesTrackingDecorator";
import { PlacesCachingDecorator } from "./places-services/PlacesCachingDecorator";
import { ElevationTrackingDecorator } from "./elevation-services/ElevationTrackingDecorator";
import { ElevationCachingDecorator } from "./elevation-services/ElevationCachingDecorator";
import { OverlayImportService } from "./services/OverlayImportService";
import { DragDropHandler } from "./DragDropHandler";
import { PlacesChartBlockProcessor } from "./code-block-processor/PlacesChartBlockProcessor";
import { SimilarTracksBlockProcessor } from "./code-block-processor/SimilarTracksBlockProcessor";
import { CompareTracksBlockProcessor } from "./code-block-processor/CompareTracksBlockProcessor";
import { PlacesCodeBlockProcessor } from "./code-block-processor/PlacesCodeBlockProcessor";
import { PlacesHelpCodeBlockProcessor } from "./code-block-processor/PlacesHelpCodeBlockProcessor";
import { HeatmapBlockProcessor } from "./code-block-processor/HeatmapBlockProcessor";
import { PlacesParametersBlockProcessor } from "./code-block-processor/PlacesParametersBlockProcessor";
import { BlockParameterSupport } from "./services/BlockParameters";
import { PlacesReferenceCodeBlockProcessor } from "./code-block-processor/PlacesReferenceCodeBlockProcessor";
import { CodeBlockRegistry, MAIN_PLUGIN_DEFINITIONS, MAIN_PLUGIN_HIGHLIGHT_CONFIGS } from "./services/CodeBlockRegistry";
import { renderMapSurface, withHostCapabilities } from "./services/MapSurfaceRenderer";
import { getMapSurfaceController } from "./services/MapSurfaceControllers";
import { buildHostSurfaceRenderOptions } from "./services/HostSurfacePlan";
import { PlacesBasesView } from "./bases/PlacesBasesView";
import { VaultQueryService } from "./services/VaultQueryService";
import { MapRefreshService } from "./services/MapRefreshService";
import type { Coordinate } from "places-shared/geo";
import { resolveMapSettings } from "./services/MapSettingsResolver";
import { TemplateNoteService } from "./services/TemplateNoteService";
import { PlaceNoteCreationService } from "./services/PlaceNoteCreationService";
import { TemplateRenameQueue } from "./services/TemplateReferenceRenamer";
import { BlockRefreshRegistry } from "./services/BlockRefreshRegistry";
import { registerRefreshableCodeBlock, createOwnNoteEditRefreshGuard } from "./code-block-processor/RefreshableCodeBlock";
import { RouteOverlayGenerator } from "./services/RouteOverlayGenerator";
import { BlockSyntaxError, optionalStringSetting, parseCodeBlock } from "./services/CodeBlockParser";
import { CachedRouteOverlay, isCachedRouteOverlay, RouteOverlayCachingDecorator, ROUTE_OVERLAY_MAX_CACHE_ENTRIES, type RouteOverlayCacheStorage } from "./services/RouteOverlayCachingDecorator";
import { RouteOverlayTrackingDecorator } from "./services/RouteOverlayTrackingDecorator";
import { SnapTrackingDecorator } from "./services/SnapTrackingDecorator";

import { CliController } from "./controllers/CliController";
import { CommandRegistrar } from "./controllers/CommandRegistrar";
import { TrackImportController } from "./controllers/TrackImportController";
import { PlaceNoteController } from "./controllers/PlaceNoteController";
import { ProtocolController } from "./controllers/ProtocolController";
import { SnapBlockProcessor } from "./code-block-processor/SnapBlockProcessor";
import { NoteParameterRegistry, QueryParameterState, SharedSelectionService } from "./services/QueryParameterState";
import { applyExternalParameterValue } from "./ui/ParameterStrip";
import { ElevationBlockProcessor } from "./code-block-processor/ElevationBlockProcessor";

import "./styles.css";
import "places-shared/error-styles.css";
import "places-shared/loading-styles.css";
import "places-shared/settings-trace-styles.css";
import "places-shared/marker-styles.css";
import "places-shared/popup-styles.css";
import "places-shared/search-styles.css";
import "places-shared/waypoint-styles.css";
import "places-shared/button-styles.css";
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


interface PlacesPluginData extends Partial<IPlacesPluginSettings> {
  routeOverlayCache?: Record<string, unknown>;
}

class DataJsonRouteOverlayCacheStorage implements RouteOverlayCacheStorage {
  constructor(
    private readonly cache: Record<string, CachedRouteOverlay>,
    private readonly saveData: () => Promise<void>,
  ) {}

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

  toJSON(): Record<string, CachedRouteOverlay> {
    return this.cache;
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
  private readonly sharedSelections = new SharedSelectionService();
  private static _settings: IPlacesPluginSettings;
  private static _instance: PlacesPlugin;
  private static apiStatsSaveTimer: number | null = null;
  private static apiStatsDirty = false;
  private static readonly API_STATS_SAVE_DEBOUNCE_MS = 60000;

  static get settings(): IPlacesPluginSettings {
    return PlacesPlugin._settings;
  }

  static publishSelection(sourcePath: string, selection: import('places-shared/services').SharedSelection | undefined, channel?: string): void {
    PlacesPlugin._instance?.sharedSelections.publish(sourcePath, selection, channel);
  }

  static subscribeSelection(sourcePath: string, handler: (selection: import('places-shared/services').SharedSelection | undefined) => void, channel?: string): () => void {
    return PlacesPlugin._instance?.sharedSelections.subscribe(sourcePath, handler, channel) ?? (() => {});
  }

  // This list must mirror the one in `onload` - a setting configured only at
  // load takes effect on the next restart rather than on save. The reach is
  // the main plugin's bundle only:
  // provider bundles read `developerMode` once, in `getPlaceExports`, and a
  // developer-mode change reaches their HTTP logging on reload.
  static async saveSettings(): Promise<void> {
    PlacesPlugin.configureTileCache();
    configureMarkerIconRules(PlacesPlugin._settings.markerIconRules);
    rootLogger.configure(PlacesPlugin._settings.consoleLogLevel);
    configureRequestLogging(PlacesPlugin._settings.developerMode);
    setOverlayCompressionLevel(PlacesPlugin._settings.overlayCompressionLevel);
    PlacesPlugin.applyMetricWindowSettings();
    await PlacesPlugin.savePluginData();
  }

  static async savePluginData(): Promise<void> {
    await PlacesPlugin._instance.saveData({
      ...PlacesPlugin._settings,
      routeOverlayCache: PlacesPlugin._instance.routeOverlayCacheStorage.toJSON(),
    });
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

  static getMapProvider(providerName: string): IMapBlockProcessor | undefined {
    return PlacesPlugin._instance?.mapBlockProcessors.get(providerName);
  }

  static getMapProviderDefaults(providerName: string): import('places-shared/settings').MapConfigPatch {
    return PlacesPlugin._instance?.mapProviderDefaults.get(providerName) ?? {};
  }

  static getSnapService(providerName: string): ISnapService | undefined {
    return PlacesPlugin._instance?.snapServices.get(providerName);
  }

  static getFirstSnapService(): ISnapService | undefined {
    return PlacesPlugin._instance?.snapServices.getFirst();
  }

  static getSnapServiceNames(): string[] {
    return PlacesPlugin._instance?.snapServices.getNames() ?? [];
  }

  static getElevationService(providerName: string): IElevationService | undefined {
    return PlacesPlugin._instance?.elevationServices.get(providerName);
  }

  static getFirstElevationService(): IElevationService | undefined {
    return PlacesPlugin._instance?.elevationServices.getFirst();
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

  static getTrackMatchService(providerName: string): ITrackMatchService | undefined {
    return PlacesPlugin._instance?.trackMatchServices.get(providerName);
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

  // Without an explicit DEM, relief is on only where the chosen map provider
  // supplies elevation (mapbox, maptiler, stadia), and silently absent otherwise.
  // `reliefProvider` feeds the relief layers alone, leaving terrainDem unset so
  // the map stays flat: only terrainDem raises the 3D mesh and pitch.
  static resolveTerrainRuntime(config: import('places-shared/settings').ResolvedMapConfig): {
    terrainDem?: TerrainDemSpec;
    reliefDem?: TerrainDemSpec;
    errors: Array<{ path: string; error: string }>;
  } {
    const terrain = PlacesPlugin.resolveTerrainDem(config.terrainProvider);
    const errors: Array<{ path: string; error: string }> = [];
    if (terrain.error) errors.push({ path: 'terrain.provider', error: terrain.error });

    const relief = config.reliefProvider.trim() ? PlacesPlugin.resolveTerrainDem(config.reliefProvider) : undefined;
    if (relief?.error) errors.push({ path: 'terrain.reliefProvider', error: relief.error });

    const reliefWanted = config.hillshadeIntensity > 0 || config.colorReliefOpacity > 0;
    const reliefDem = !reliefWanted
      ? undefined
      : relief
        ? relief.dem
        : config.terrainProvider.trim()
          ? terrain.dem
          : (PlacesPlugin._instance?.terrainDemProviders.get(config.mapProvider)?.getDemSource() ?? undefined);
    return { terrainDem: terrain.dem, reliefDem, errors };
  }

  static getFirstTrackMatchService(): ITrackMatchService | undefined {
    return PlacesPlugin._instance?.trackMatchServices.getFirst();
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
  private mapProviderDefaults = new ServiceRegistry<import('places-shared/settings').MapConfigPatch>();
  private elevationServices = new ServiceRegistry<IElevationService>();
  private routeOverlayServices = new ServiceRegistry<RouteOverlayService>();
  private snapServices = new ServiceRegistry<ISnapService>();
  private trackMatchServices = new ServiceRegistry<ITrackMatchService>();
  private terrainDemProviders = new ServiceRegistry<ITerrainDemProvider>();
  private providerStyles = new ServiceRegistry<string[]>();
  private imageAlignmentProcessors = new ServiceRegistry<ImageAlignmentProcessor>();
  private extensionSettingsGroups: Record<string, ExtensionSettingsGroup> = {};
  // Session caches outlive extension re-initialization.
  private readonly apiCacheStorage = new SessionCacheStorage();
  private readonly elevationCacheStorage = new SessionCacheStorage();
  private routeOverlayCacheStorage!: DataJsonRouteOverlayCacheStorage;
  private readonly extensionCodeBlockHandlers = new Map<string, (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => void | Promise<void>>();
  // Per-block-type `colonTextKeys`: the host's pre-parse accepts the same value syntax the processor does.
  private readonly extensionColonTextKeys = new Map<string, readonly string[]>();
  private readonly registeredExtensionBlockTypes = new Set<string>();
  private extensionCommandIds = new Set<string>();
  private extensionCommandHelp: Array<{ name: string; description: string }> = [];
  private commandRegistrar!: CommandRegistrar;
  private registeredProviderExports: PlaceProviderExport[] = [];
  private readonly extensionExports = new Map<string, { name: string; exports: IPlacePluginExtensionExports }>();
  private readonly versionMismatchWarned = new Set<string>();
  private blockRefreshTimer: number | null = null;
  private pendingBlockRefreshPaths = new Set<string>();

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

  // "Search for a place here", stamped onto every render plan.
  static get reverseGeocodeHost(): (coordinate: Coordinate) => void {
    return (coordinate) => PlacesPlugin._instance.protocolController.openReverseGeocode(coordinate);
  }
  private helpCodeBlockProcessor!: PlacesHelpCodeBlockProcessor;
  private vaultQueryService!: VaultQueryService;
  private routeOverlayGenerator!: RouteOverlayGenerator;
  private vaultQueryUnsubscribe: (() => void) | null = null;
  private vaultQueryRemovedUnsubscribe: (() => void) | null = null;
  private vaultQueryIndexedUnsubscribe: (() => void) | null = null;
  private vaultQueryProviderTablesChangedUnsubscribe: (() => void) | null = null;

  async onload() {
    PlacesPlugin._instance = this;
    this.register(installPlacesGlobalErrorCapture(window));
    const loadedData = await this.loadData() as PlacesPluginData | null;
    this.routeOverlayCacheStorage = new DataJsonRouteOverlayCacheStorage(
      normalizeRouteOverlayCache(loadedData?.routeOverlayCache),
      () => PlacesPlugin.savePluginData(),
    );
    PlacesPlugin._settings = this.normalizeSettings({ ...DEFAULT_SETTINGS, ...(loadedData ?? {}) });
    PlacesPlugin._settings.consoleLogLevel = normalizeConsoleLogLevel(PlacesPlugin._settings.consoleLogLevel);
    PlacesPlugin.configureTileCache();
    configureMarkerIconRules(PlacesPlugin._settings.markerIconRules);
    rootLogger.configure(PlacesPlugin._settings.consoleLogLevel);
    configureRequestLogging(PlacesPlugin._settings.developerMode);
    setOverlayCompressionLevel(PlacesPlugin._settings.overlayCompressionLevel);
    // Overlay Source / Overlay Cache decoding needs the Zstandard codec;
    // awaited before any block renders. A failure disables overlay decode
    // (StringCompressor throws where used) but must not take down the rest of
    // the plugin.
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
      this.routeOverlayServices,
      this.vaultQueryService,
      () => PlacesPlugin.settings.defaultRouteLabelTemplate,
    );

    // Deliberately not awaited: it waits on another plugin's startup event and
    // must never hold up this one.
    this.vaultQueryService.initialize().catch(() => { /* VaultQuery not available */ });

    new CliController(this.app, this.overlayImportService, this.trackImportController, () => PlacesPlugin.settings).register(this);

    // Register before layout restore, letting Obsidian revive saved Bases map views.
    this.initializeBasesView();

    this.registerEditorExtension(placesHighlightPlugin);
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

    // Register exports immediately: every registerMarkdownCodeBlockProcessor
    // call after first paint re-renders each open preview.
    this.registerEvent((this.app.workspace as Events).on(PLACES_EXTENSION_READY_EVENT, (payload: unknown) => {
      if (!isExtensionReadyEvent(payload)) return;
      const event = payload;
      this.loadExtension(event.pluginId, event.extension);
      this.rebuildExtensionRegistries();
      PlacesBasesView.refreshViewsWaitingForProviders();
    }));

    // When the extension reloads, the ready event re-registers the new
    // instance's exports.
    this.registerEvent((this.app.workspace as Events).on(PLACES_EXTENSION_UNLOADED_EVENT, (payload: unknown) => {
      if (!isExtensionUnloadedEvent(payload)) return;
      const event = payload;
      this.disposeExtension(event.pluginId);
      this.extensionExports.delete(event.pluginId);
      this.rebuildExtensionRegistries();
    }));

    // Everything that registers a markdown processor runs here in onload, before
    // the restored workspace renders, and every open note renders exactly once
    // with all processors in place. Extensions that loaded before this plugin
    // never fired a ready event this plugin could hear; the discovery scan picks
    // them up.
    this.initializeExtensions();
    this.registerCodeBlockProcessors();
    this.commandRegistrar = new CommandRegistrar(
      this,
      this.placesServiceAggregator,
      this.trackImportController,
      () => PlacesPlugin.settings,
      (file, place) => this.placeNoteController.sync(file, place),
    );
    this.commandRegistrar.register();
    this.addSettingTab(new PlacesSettingsTab(this.app, this, this.extensionSettingsGroups));
    this.registerDragAndDrop();
    this.protocolController = new ProtocolController(
      this.app,
      this.placesServiceAggregator,
      () => PlacesPlugin.settings,
      (file, place) => this.placeNoteController.sync(file, place),
    );
    this.protocolController.register(this);
    this.subscribeToVaultQueryEvents();

    this.app.workspace.onLayoutReady(() => {
      // Insurance for load orders the event handler and onload scan cannot see;
      // a no-op when every extension is already registered.
      this.initializeExtensions();

      // A backstop for reattachment that raises no leaf change: reading view
      // detaches offscreen sections and puts the same elements back. The
      // active-leaf-change handler covers navigation, and a detached map is kept
      // for a minute, so a sweep this side of that is soon enough.
      this.registerInterval(window.setInterval(() => {
        MapRefreshService.getInstance().checkAndRestoreMaps();
      }, 10000));

      PlacesBasesView.refreshViewsWaitingForProviders();
    });
  }

  private normalizeSettings(settings: IPlacesPluginSettings): IPlacesPluginSettings {
    settings.tileCacheDurationHoursDesktop = this.normalizeTileCacheDurationHours(settings.tileCacheDurationHoursDesktop);
    settings.tileCacheDurationHoursMobile = this.normalizeTileCacheDurationHours(settings.tileCacheDurationHoursMobile);
    settings.tileCacheMaxSizeMBDesktop = this.normalizeTileCacheMaxSizeMB(settings.tileCacheMaxSizeMBDesktop);
    settings.tileCacheMaxSizeMBMobile = this.normalizeTileCacheMaxSizeMB(settings.tileCacheMaxSizeMBMobile);
    settings.tileCacheEnabledProviders = this.normalizeTileCacheEnabledProviders(settings.tileCacheEnabledProviders);
    settings.newPlaceTagFilterPatterns = Array.isArray(settings.newPlaceTagFilterPatterns)
      ? settings.newPlaceTagFilterPatterns
      : DEFAULT_SETTINGS.newPlaceTagFilterPatterns;
    return settings;
  }

  private normalizeTileCacheDurationHours(value: number): number {
    return Number.isFinite(value) ? clamp(Math.floor(value), 0, 999) : 0;
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

  // Extensions already loaded keep their instances: getPlaceExports constructs
  // each provider's services. Unloads are handled by the unloaded event, not by
  // this scan.
  private initializeExtensions() {
    let discovered = false;
    for (const { pluginId, extension } of new PluginDiscoveryService(this.app).discoverPlugins()) {
      if (this.extensionExports.has(pluginId)) continue;
      this.loadExtension(pluginId, extension);
      discovered = true;
    }
    if (discovered) this.rebuildExtensionRegistries();
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

    const pluginName = pluginId.slice('places-'.length);
    PlacesPlugin.settings.extensionSettings[pluginName] ??= {};
    this.disposeExtension(pluginId);
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

  private disposeExtension(pluginId: string): void {
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
      if (disposal) void Promise.resolve(disposal).catch(error => logger.extensions.warn(`Failed to dispose ${pluginId}`, error));
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
    this.terrainDemProviders.clear();
    this.providerStyles.clear();
    this.imageAlignmentProcessors.clear();
    this.extensionCodeBlockHandlers.clear();
    this.extensionColonTextKeys.clear();
    this.registeredProviderExports = [];
    // Clear in place - PlacesSettingsTab holds a reference to this object across re-initialization.
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

    for (const { name: pluginName, exports } of this.extensionExports.values()) {

      if (exports.providers) {
        this.registeredProviderExports.push(...exports.providers);

        exports.providers.forEach(provider => {
          const providerName = provider.name;

          if (provider.geocoding) {
            const wrappedService = this.wrapPlacesService(provider.geocoding.service, providerName, this.apiCacheStorage);
            this.placesServices.register(providerName, wrappedService);
            addIcon(providerName, provider.geocoding.icon);
          }

          if (provider.map) {
            this.mapBlockProcessors.register(providerName, provider.map);
          }

          this.mapProviderDefaults.register(providerName, provider.mapDefaults ?? {});

          if (provider.styles) {
            this.providerStyles.register(providerName, [...provider.styles]);
          }

          if (provider.elevation) {
            const wrappedService = this.wrapElevationService(provider.elevation, providerName, this.elevationCacheStorage);
            this.elevationServices.register(providerName, wrappedService);
          }

          if (provider.trackMatch) {
            this.trackMatchServices.register(providerName, provider.trackMatch);
          }

          if (provider.terrain) {
            this.terrainDemProviders.register(providerName, provider.terrain);
          }

          if (provider.routeOverlay) {
            const trackedService = new RouteOverlayTrackingDecorator(provider.routeOverlay, providerName, this.getApiStatsSettings(), () => PlacesPlugin.scheduleApiStatsSave());
            this.routeOverlayServices.register(providerName, new RouteOverlayCachingDecorator(trackedService, providerName, this.routeOverlayCacheStorage));
          }

          if (provider.snap) {
            const trackedService = new SnapTrackingDecorator(provider.snap, providerName, this.getApiStatsSettings(), () => PlacesPlugin.scheduleApiStatsSave());
            this.snapServices.register(providerName, trackedService);
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
          this.registerExtensionCodeBlockProcessor(processor.blockType, processor.processor, processor.colonTextKeys);
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

    // Every provider's styles, so the highlighter accepts what completion offers.
    // Set after the whole scan, not per provider, because the scan reruns on load
    // and unload and this replaces the previous set rather than adding to it.
    registry.setProvidedValues('style', this.providerStyles.getNames().flatMap(name => this.providerStyles.get(name) ?? []));
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

  // Obsidian has no public way to unregister a code block processor, and
  // registering the same block type twice throws. Block types are
  // lowercase-only; Obsidian matches fence languages case-sensitively.
  private registerExtensionCodeBlockProcessor(blockType: string, processor: (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => void | Promise<void>, colonTextKeys?: readonly string[]): void {
    this.extensionCodeBlockHandlers.set(blockType, processor);
    // Re-read on every render: the extension may have reloaded with a different list.
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
        const parsed = parseCodeBlock(source, { colonTextKeys: this.extensionColonTextKeys.get(blockType) });
        const parameterSupport = new BlockParameterSupport(this.app, this.vaultQueryService);
        const parameters = await parameterSupport.apply(parsed, el, ctx);
        registerRefreshableCodeBlock({
          source,
          el,
          ctx,
          process: processExtensionBlock,
          shouldAutoRefresh: createOwnNoteEditRefreshGuard(source, ctx.sourcePath),
          ariaLabel: `Refresh ${blockType}`,
          onError: error => rootLogger.error(`Refresh ${blockType} failed:`, error),
          usesParameters: parameters !== null,
        });
        const resolvedSource = parameters
          ? `${stringifyYaml(parsed.settings).trimEnd()}${parsed.embeddedPlaces !== undefined ? `\n---\n${parsed.embeddedPlaces}` : ''}`
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

  // Capabilities handed to extensions via getPlaceExports. Extension blocks
  // (e.g., places-classify in places-utilities) consume main-plugin services
  // exclusively through this facade - they never import the main plugin.
  private buildHostServices(): IPlacesHostServices {
    return {
      parameters: {
        getNoteValue: (sourcePath, name) => QueryParameterState.resolveNoteValue(sourcePath, name),
        setNoteValue: (sourcePath, name, value) => {
          const stateKey = NoteParameterRegistry.noteStateKey(sourcePath);
          const definition = NoteParameterRegistry.definitionsFor(sourcePath).find(entry => entry.name === name);
          if (!definition && PlacesPlugin.settings.developerMode) {
            logger.extensions.warn(`Host setNoteValue: no places-parameters block in "${sourcePath}" declares "${name}"; the value will not reach a query.`);
          }
          // null clears to the declared default (a distinct value, not the empty string).
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
        // Provider-authored surfaces resolve config through the host, applying
        // the global settings layer to them too; resolving it themselves
        // would silently drop every global to its coded default.
        resolveMapConfig: (request) => {
          const resolved = resolveMapSettings({
            providerName: request.providerName,
            rawBlockSettings: request.blockSettings,
            placeCount: request.placeCount,
            warnings: request.warnings,
          });
          return { config: resolved.config, clusteringEnabled: resolved.clusteringEnabled };
        },
        renderMapSurface: async (request) => (await renderMapSurface(buildHostSurfaceRenderOptions(request))).rendered,
        updateMapSurface: async (request) => {
          // The camera defaults to 'preserve': streamed data never moves it.
          const controller = getMapSurfaceController(request.mapContainer);
          if (!controller) return false;
          // Same capability fill as the initial render: streamed plans from
          // provider bundles cannot carry the hosts themselves.
          const plan = withHostCapabilities(request.renderPlan);
          controller.setPlan(plan, { source: 'host-update' });
          await controller.reconcile();
          return controller.getState().appliedPlanSignature === plan.signature;
        },
      },
      trackMatch: {
        get: (providerName) => this.trackMatchServices.get(providerName),
        getFirst: () => this.trackMatchServices.getFirst(),
        getNames: () => this.trackMatchServices.getNames(),
      },
    };
  }

  private wrapPlacesService(service: IPlacesService, serviceName: string, cacheStorage: SessionCacheStorage): IPlacesService {
    const trackedService = new PlacesTrackingDecorator(
      service,
      serviceName,
      this.getApiStatsSettings(),
      () => PlacesPlugin.scheduleApiStatsSave(),
      () => PlacesPlugin.settings.poiFilterPatterns,
    );
    return new PlacesCachingDecorator(trackedService, serviceName, cacheStorage);
  }

  private wrapElevationService(service: IElevationService, serviceName: string, cacheStorage: SessionCacheStorage): IElevationService {
    const trackedService = new ElevationTrackingDecorator(
      service,
      serviceName,
      this.getApiStatsSettings(),
      () => PlacesPlugin.scheduleApiStatsSave(),
    );
    return new ElevationCachingDecorator(trackedService, serviceName, cacheStorage);
  }

  private getApiStatsSettings(): Record<string, unknown> {
    return PlacesPlugin.settings.apiStats;
  }

  // Block types are lowercase-only. Obsidian matches fence languages
  // case-sensitively and every registration re-renders open previews, and no
  // case aliases are registered.
  private registerCodeBlockProcessors() {
    const blockParameters = new BlockParameterSupport(this.app, this.vaultQueryService);
    this.templateNoteService = new TemplateNoteService(this.app);
    this.placeNoteCreationService = new PlaceNoteCreationService(this.app, () => PlacesPlugin.settings);
    this.templateRenameQueue = new TemplateRenameQueue(this.app, () => void MapRefreshService.getInstance().refreshAllBlocks());
    this.codeBlockProcessor = new PlacesCodeBlockProcessor(this.app, this, this.placeDataService, this.mapBlockProcessors, this.placesServiceAggregator, () => this.getRegisteredProviders(), this.vaultQueryService, this.trackDataService, this.routeOverlayGenerator, this.templateNoteService);
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
      () => [...this.commandRegistrar.getCommandHelp(), ...this.extensionCommandHelp]);
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

      // An explicitly requested provider must support alignment - no silent
      // substitution.
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
      await processor(source, el, ctx);
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

  // Same debounce as the map data refreshes.
  private scheduleDataBlockRefresh(path: string): void {
    this.pendingBlockRefreshPaths.add(path);
    if (this.blockRefreshTimer !== null) {
      window.clearTimeout(this.blockRefreshTimer);
    }
    this.blockRefreshTimer = window.setTimeout(() => {
      const changedPaths = Array.from(this.pendingBlockRefreshPaths);
      this.pendingBlockRefreshPaths.clear();
      this.blockRefreshTimer = null;
      void BlockRefreshRegistry.refreshAll({ changedPaths });
    }, 200);
  }

  private subscribeToVaultQueryEvents(): void {
    // VaultQueryService invalidates its cache before notifying listeners.
    this.vaultQueryUnsubscribe = this.vaultQueryService.onFileIndexed((path) => {
      try {
        const refreshService = MapRefreshService.getInstance();
        refreshService.onFileIndexed(path);
      } catch (error) {
        logger.refresh.error('Error queueing map refresh on file indexed', error);
      }
      this.scheduleDataBlockRefresh(path);
    });
    // Without this, a deleted note's marker stays until a manual refresh.
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
    this.vaultQueryProviderTablesChangedUnsubscribe = this.vaultQueryService.onProviderTablesChanged(() => {
      try {
        const refreshService = MapRefreshService.getInstance();
        refreshService.onProviderTablesChanged();
      } catch (error) {
        logger.refresh.error('Error queueing map refresh on provider tables changed', error);
      }
    });

    // Dataview signals index updates via the workspace 'dataview:refresh-views'
    // event (the same signal ensureDataviewReady waits on), independent of
    // whether VaultQuery is active.
    this.registerEvent((this.app.workspace as Events).on('dataview:refresh-views', () => {
      try {
        MapRefreshService.getInstance().onDataviewIndexChanged();
      } catch (error) {
        logger.refresh.error('Error queueing map refresh on dataview index changed', error);
      }
    }));

    // VaultQuery's file-indexed event doesn't fire on renames (Obsidian limitation).
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      try {
        // ctx.sourcePath is stale (contains the old path) immediately after rename
        this.vaultQueryService.registerRename(oldPath, file.path);
        // Query results carry file paths.
        this.vaultQueryService.invalidateCache();
        const refreshService = MapRefreshService.getInstance();
        refreshService.onFileRenamed(oldPath, file.path);
      } catch (error) {
        logger.refresh.error('Error queueing map refresh on file rename', error);
      }
    }));

    // On mobile, containers can be detached from the DOM while off-screen.
    // Flush any stale-marked maps when the user navigates back to a leaf.
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
      MapRefreshService.getInstance().onLeafChange();
    }));

    // Frontmatter-backed maps also refresh on file-indexed events, once
    // metadataCache has caught up.
    this.registerEvent(this.app.vault.on('modify', (file) => {
      try {
        this.vaultQueryService.invalidateCache();
        const refreshService = MapRefreshService.getInstance();
        refreshService.onSourceFileModified(file.path);
        this.onTemplateNoteMaybeChanged(file.path);
      } catch (error) {
        logger.refresh.error('Error queueing map refresh on file modify', error);
      }
    }));

    // A template note is not the source note of the blocks that use it, and the
    // path-matched refreshes above never reach them.
    this.registerEvent(this.app.vault.on('create', (file) => this.onTemplateNoteMaybeChanged(file.path)));
    this.registerEvent(this.app.vault.on('delete', (file) => this.onTemplateNoteMaybeChanged(file.path)));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      this.onTemplateNoteMaybeChanged(file.path);
      this.onTemplateNoteMaybeChanged(oldPath);
      // Obsidian rewrites links it parses, and it does not parse links inside
      // code fences; a renamed template note would silently break every block
      // referencing it.
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
    // Bases view registration exists at runtime but is not in Obsidian's public types yet.
    (this as unknown as ObsidianPluginWithBasesViewRegistration).registerBasesView("places-map", {
        name: "Places Map",
        icon: "lucide-map",
        factory: (controller: unknown, containerEl: HTMLElement) => new PlacesBasesView(controller as ConstructorParameters<typeof PlacesBasesView>[0], containerEl),
        options: () => PlacesBasesView.getViewOptions(),
    });
  }

  onunload(): void {
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
    this.pendingBlockRefreshPaths.clear();

    this.templateRenameQueue.dispose();

    this.vaultQueryService.cleanup();

    MapRefreshService.getInstance().cleanup();

    void TileCache.shutdown();
    void PlacesPlugin.flushApiStatsSave(false);
  }


}
