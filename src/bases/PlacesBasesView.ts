import { logger as rootLogger, createPerformanceMonitor, renderMapSurfaceError, getErrorMessage, hashString36, scalarToString, sleep } from "places-shared/utils";
import { BasesView, debounce, Menu, QueryController, type BasesPropertyId } from "obsidian";
type ViewOption = { displayName: string; type: string; key?: string; default?: string | boolean; placeholder?: string; items?: ViewOption[] };
import { MapPlace, Overlay } from "places-shared/overlay";
import { PlacesBoundingBox } from "places-shared/geo";
import { MapLoadingProgress } from "../ui/MapLoadingProgress";
import { createMapRenderPlan, resolveCameraIntent, type MapCameraIntent, type MapRenderPlan, type CreateMapRenderPlanOptions as MapRenderPlanOptions } from "places-shared/render";
import { CODED_MAP_DEFAULTS, DEFAULT_MAP_HEIGHT, mapConfigPaths, parseMapConfigPatch, type MapBlockSettings, type MetricWindow } from "places-shared/settings";
import { IMapBlockProcessor } from "places-shared/services";
import { BasesDataAdapter } from "./BasesDataAdapter";
import { TrackInspectionService } from "../services/TrackInspectionService";
import PlacesPlugin from "../main";
import { OverlayService } from "../services/OverlayService";
import { getMapSurfaceController } from "../services/MapSurfaceControllers";
import { cleanupMapContainer } from "../services/MapSurfaceCleanup";
import { resolveMapSettings, type ResolvedMapSettings } from "../services/MapSettingsResolver";
import { renderMapSurface } from "../services/MapSurfaceRenderer";
import type { MapSurfaceController } from "../services/MapSurfaceController";
import { MarkerStyleService } from "places-shared/map";
import type { PlaceLabelOutcome } from "../services/LabelTemplateService";
import { postProcessPlaces, summarizeLabelOutcomes } from "../services/PlacesRenderPreparer";
import { PlaceLabelCaches } from '../services/LabelResultCache';
import { createOverlayLoadProgress, handleSearchResultAction, renderMapContentErrors, type MapContentError } from "../services/MapSurfaceChrome";

const logger = rootLogger.scope('Places Bases');

const PlacesMapViewType = 'places-map';

const DEFAULT_MAP_PROVIDER = '';
const BASES_RENDER_DEBOUNCE_MS = 150;
const CONFIG_ERRORS_CLASS = 'places-bases-config-error';
const OVERLAY_ERRORS_CLASS = 'places-bases-overlay-error';

export interface PropertyMappings {
  location: string;
  icon: string;
  title: string;
  locationId: BasesPropertyId | null;
  iconId: BasesPropertyId | null;
  titleId: BasesPropertyId | null;
}

interface BasesPlanInput {
  dataState?: MapRenderPlan['dataState'];
  places: MapPlace[];
  overlays: Overlay[];
  resolved: ResolvedMapSettings;
  camera: MapCameraIntent;
  mapSource: { path: string; lineStart: number };
}

export class PlacesBasesView extends BasesView {
  type = PlacesMapViewType;
  scrollEl: HTMLElement;
  containerEl: HTMLElement;
  mapContainerEl: HTMLElement;

  private mapProvider = '';
  private mapHeight: string = DEFAULT_MAP_HEIGHT;
  private overlays = '';
  private propertyMappings: PropertyMappings = {
    location: "Location",
    icon: "icon",
    title: "",
    locationId: null,
    iconId: null,
    titleId: null
  };

  private currentMapProcessor: IMapBlockProcessor | null = null;
  private needsFullRender = false;
  private overlayService: OverlayService;
  private lastUpdateSignature: string | null = null;
  private lastDataSignature: string | null = null;
  private lastConfigSignature: string | null = null;
  private pendingRenderReason = 'initial';
  private renderGeneration = 0;
  private renderTimer: number | null = null;
  private hasRenderedMap = false;
  private readonly viewId = PlacesBasesView.nextViewId();
  private readonly perf = createPerformanceMonitor('bases-view', { viewId: this.viewId }, { enabled: PlacesPlugin.settings.developerMode });
  private static activeViews = new Set<PlacesBasesView>();
  private static viewSequence = 0;

  private static nextViewId(): number {
    PlacesBasesView.viewSequence += 1;

    return PlacesBasesView.viewSequence;
  }

  constructor(private readonly queryController: QueryController, scrollEl: HTMLElement, private readonly labelCaches = new PlaceLabelCaches()) {
    super(queryController);
    this.scrollEl = scrollEl;
    this.containerEl = scrollEl.createDiv({ cls: 'places-bases-container is-loading', attr: { tabIndex: '0' } });
    this.mapContainerEl = this.containerEl.createDiv({ cls: 'places-bases-map', attr: { tabIndex: '0' } });
    this.overlayService = new OverlayService(this.app, id => PlacesPlugin.getOverlayPreset(id));
  }

  onload(): void {
    PlacesBasesView.activeViews.add(this);
    this.logDebug('view loaded', { activeViews: PlacesBasesView.activeViews.size });

    const handleInteractionStart = (evt: Event) => {
      evt.stopPropagation();
      this.mapContainerEl.focus();
    };

    this.registerDomEvent(this.mapContainerEl, 'mousedown', handleInteractionStart);
    this.registerDomEvent(this.mapContainerEl, 'touchstart', handleInteractionStart, { passive: true });

    this.registerDomEvent(this.containerEl, 'contextmenu', (evt) => {
      evt.preventDefault();
      this.showContextMenu(evt);
    });
  }

  onunload(): void {
    this.renderGeneration++;
    PlacesBasesView.activeViews.delete(this);
    this.logDebug('view unloaded', { activeViews: PlacesBasesView.activeViews.size });

    if (this.renderTimer !== null) {
      window.clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }

    this.cleanupMap();
  }

  private onResizeDebounce = debounce(
    () => {
      this.mapContainerEl.setCssProps({
        '--places-map-height': this.mapHeight
      });
    },
    100,
    true
  );

  onResize(): void {
    this.onResizeDebounce();
  }

  public focus(): void {
    this.containerEl.focus({ preventScroll: true });
  }

  private computeDataSignature(): string {
    const entries = this.data?.data ?? [];

    return entries
      .map((e, index) => `${index}:${e.file.path}:${e.file.stat.mtime}`)
      .join('|');
  }

  private createTrackInspector(speedWindow: MetricWindow | undefined, sourcePath: string | undefined): MapRenderPlanOptions['inspectTrack'] {
    const service = new TrackInspectionService(() => PlacesPlugin.settings, speedWindow);

    return (place, coordinate, signal) => service.inspect(place, coordinate, sourcePath ?? '', signal);
  }

  private collectRawSettings(): Record<string, unknown> {
    const raw: Record<string, unknown> = {};

    for (const path of mapConfigPaths()) {
      const value = coerceViewOptionValue(path, this.config.get(path));

      if (value === undefined || value === null || value === '') continue;

      const segments = path.split('.');
      let node = raw;

      for (const segment of segments.slice(0, -1)) {
        node = (node[segment] as Record<string, unknown> | undefined) ?? (node[segment] = {});
      }

      node[segments[segments.length - 1]] = value;
    }

    raw.mapProvider = this.mapProvider;
    raw.width = '100%';

    return raw;
  }

  private computeConfigSignature(): string {
    const configKeys = [...mapConfigPaths(), 'overlays',
      'locationProperty', 'titleProperty', 'iconProperty'];

    return configKeys.map(k => scalarToString(this.config.get(k))).join(',');
  }

  public onDataUpdated(): void {
    this.perf.mark('data-updated', { entries: this.data?.data?.length ?? 0, mapExists: this.hasRenderedMap });
    this.containerEl.removeClass('is-loading');
    this.scheduleMapUpdate();
  }

  private scheduleMapUpdate(options: { force?: boolean; reason?: string } = {}): void {
    const dataSignature = this.computeDataSignature();
    const configSignature = this.computeConfigSignature();
    const sig = `${dataSignature}||${configSignature}`;

    if (!options.force && sig === this.lastUpdateSignature) {
      this.logDebug('onDataUpdated skipped', {
        reason: 'signature unchanged',
        entries: this.data?.data?.length ?? 0,
        dataHash: hashString36(dataSignature),
        configHash: hashString36(configSignature)
      });

      return;
    }

    const dataChanged = this.lastDataSignature !== null && this.lastDataSignature !== dataSignature;
    const configChanged = this.lastConfigSignature !== null && this.lastConfigSignature !== configSignature;
    const reason = options.reason ?? (this.lastUpdateSignature === null
      ? 'initial'
      : [dataChanged ? 'data' : '', configChanged ? 'config' : ''].filter(Boolean).join('+') || 'manual');

    this.lastUpdateSignature = sig;
    this.lastDataSignature = dataSignature;
    this.lastConfigSignature = configSignature;
    this.pendingRenderReason = reason;
    this.renderGeneration++;

    if (this.renderTimer !== null) {
      window.clearTimeout(this.renderTimer);
      this.logDebug('render timer coalesced', { reason });
    }

    const renderDelay = this.hasRenderedMap ? BASES_RENDER_DEBOUNCE_MS : 0;

    this.logDebug('render scheduled', {
      reason,
      delayMs: renderDelay,
      entries: this.data?.data?.length ?? 0,
      dataHash: hashString36(dataSignature),
      configHash: hashString36(configSignature)
    });

    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      this.loadConfig();
      void this.renderMapGuarded();
    }, renderDelay);
  }

  private reportRenderError(error: unknown): void {
    this.lastUpdateSignature = null;
    logger.error('Error rendering map', error);
    renderMapSurfaceError(this.mapContainerEl, {
      icon: '⚠️',
      title: 'Error rendering map',
      message: getErrorMessage(error)
    });
  }

  private async renderMapGuarded(): Promise<void> {
    const generation = this.renderGeneration;

    try {
      await this.renderMap();
    } catch (error) {
      if (generation === this.renderGeneration) this.reportRenderError(error);
    }
  }

  private async updateMapNow(reason: string): Promise<void> {
    this.labelCaches.clear();
    const dataSignature = this.computeDataSignature();
    const configSignature = this.computeConfigSignature();

    this.lastUpdateSignature = `${dataSignature}||${configSignature}`;
    this.lastDataSignature = dataSignature;
    this.lastConfigSignature = configSignature;
    this.pendingRenderReason = reason;

    if (this.renderTimer !== null) {
      window.clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }

    this.loadConfig();
    this.renderGeneration++;

    await this.renderMapGuarded();
  }

  private readText(key: string): string {
    const value = this.config.get(key);

    return typeof value === 'string' && value.trim() ? value : '';
  }

  private loadConfig(): void {
    this.mapProvider = PlacesPlugin.resolveMapProvider(this.readText('mapProvider') || undefined);
    this.overlays = this.readText('overlays');
    this.propertyMappings = {
      location: "Location",
      icon: "icon",
      title: "",
      locationId: this.config.getAsPropertyId('locationProperty'),
      iconId: this.config.getAsPropertyId('iconProperty'),
      titleId: this.config.getAsPropertyId('titleProperty')
    };
  }

  private buildPlan(input: BasesPlanInput): { plan: MapRenderPlan; errors: MapContentError[] } {
    const terrain = PlacesPlugin.resolveTerrainRuntime(input.resolved.config);
    const plan = createMapRenderPlan({
      perf: this.perf,
      surfaceKind: 'bases-view',
      dataState: input.dataState,
      places: input.places,
      overlays: input.overlays,
      config: input.resolved.config,
      clusteringEnabled: input.resolved.clusteringEnabled,
      source: input.mapSource,
      camera: input.camera,
      placeNoteHost: PlacesPlugin.placeNoteHost,
      reverseGeocodeHost: PlacesPlugin.reverseGeocodeHost,
      onPlaceAction: (place, actionId) => handleSearchResultAction(place, actionId, input.mapSource.path),
      inspectTrack: this.createTrackInspector(input.resolved.config.trackSpeedWindow, input.mapSource.path),
      trackLoader: PlacesPlugin.getTrackDataService(),
      popupRenderers: PlacesPlugin.getPopupRenderers(),
      terrainDem: terrain.terrainDem,
      reliefDem: terrain.reliefDem,
    });

    return {
      plan,
      errors: [
        ...terrain.errors.map(e => ({ ...e, type: 'Terrain' })),
        ...plan.errors.map(e => ({ ...e, type: 'Overlay' })),
      ],
    };
  }

  private async renderMap(): Promise<void> {
    const myGeneration = this.renderGeneration;

    if (!this.data) {
      logger.warn('No data available for map rendering');

      return;
    }

    const places = await this.perf.measureAsync('convert-entries', () => BasesDataAdapter.convertToMapPlaces(this.data.data ?? [], this.app, this.propertyMappings, {
      isCanceled: () => myGeneration !== this.renderGeneration,
      onTiming: timing => this.perf.mark('conversion-profile', timing),
    }));

    if (myGeneration !== this.renderGeneration) return;
    this.perf.mark('render-started', { rows: this.data.data?.length ?? 0, places: places.length, reason: this.pendingRenderReason });
    this.logDebug('render started', {
      generation: myGeneration,
      reason: this.pendingRenderReason,
      rows: this.data.data?.length ?? 0,
      places: places.length,
      provider: this.mapProvider
    });

    if (places.length === 0) {
      this.logDebug('full cleanup', { reason: 'no places' });
      this.cleanupMap();
      this.showNoPlacesMessage();

      return;
    }

    const provider = PlacesPlugin.getMapProvider(this.mapProvider) ?? null;

    const rawSettings = this.collectRawSettings();
    const blockPatch = parseMapConfigPatch(rawSettings);
    const blockSettings: MapBlockSettings = { ...CODED_MAP_DEFAULTS, ...blockPatch };
    const mapSource = { path: this.getViewportStateSourcePath(), lineStart: 0 };

    const initial = resolveMapSettings({ providerName: this.mapProvider, rawBlockSettings: rawSettings, blockPatch, placeCount: places.length });

    this.mapHeight = initial.config.height;
    this.mapContainerEl.setCssProps({ '--places-map-height': this.mapHeight });
    const camera = resolveCameraIntent(initial.config, mapSource, { rememberedFit: 'ignore' });

    if (!blockSettings.heatmapLayer && (this.needsFullRender || this.currentMapProcessor !== provider || !getMapSurfaceController(this.mapContainerEl))) {
      const bounds = PlacesBoundingBox.fromPlaces(places);

      for (const place of places) {
        if (place.overlay?.geojson) bounds.extend(PlacesBoundingBox.fromImmutableGeoJSON(place.overlay.geojson));
      }

      const anchors: MapPlace[] = bounds.getLatLngBounds().map(([latitude, longitude]) => ({
        latitude, longitude, name: '', icon: '', metadata: { boundsAnchor: true },
        iconStyle: { inlineCss: 'display: none', classes: [], opacity: 0 },
      }));
      const preview = this.buildPlan({ places: anchors, overlays: [], resolved: initial, camera, mapSource, dataState: 'loading' });

      if (!await this.applyPlan(provider, preview.plan, myGeneration) || myGeneration !== this.renderGeneration) return;
    }

    let resolved = initial;
    let labelErrors: MapContentError[] = [];

    if (!blockSettings.heatmapLayer) {
      const perf = createPerformanceMonitor('bases-prepare', { places: places.length, provider: this.mapProvider }, { enabled: PlacesPlugin.settings.developerMode });
      const progress = this.addChild(new MapLoadingProgress(this.mapContainerEl, () => undefined));

      try {
        const labelOutcomes = new WeakMap<MapPlace, PlaceLabelOutcome>();
        const baseCss = blockSettings.css;
        let batchSize = 64;
        let batchCount = 0;
        const preparationStarted = performance.now();

        for (let offset = 0; offset < places.length;) {
          const started = performance.now();
          const end = Math.min(places.length, offset + batchSize);
          const settings = { ...blockSettings, css: baseCss };
          const fresh = places.slice(offset, end);

          await postProcessPlaces(fresh, settings, {
            labelCaches: this.labelCaches, labelOutcomes,
            providerName: this.mapProvider, rawBlockSettings: rawSettings, blockPatch,
            placeCount: places.length, selfNoteMap: false, perf,
          });
          if (myGeneration !== this.renderGeneration) return;
          const prepareMs = performance.now() - started;

          batchCount++;
          perf.mark('prepared-batch', { batch: batchCount, added: end - offset, places: end, totalPlaces: places.length, prepareMs });
          offset = end;
          progress.setPhase(`Loading places (${end} ready)`);

          if (end < places.length) {
            await sleep(0);
            if (myGeneration !== this.renderGeneration) return;
          }

          batchSize = Math.max(8, Math.min(256, Math.round(batchSize * 50 / Math.max(1, prepareMs))));
        }

        const badgeCss = MarkerStyleService.buildBadgeCss(places);
        const css = [baseCss, badgeCss].filter(Boolean).join('\n');

        resolved = resolveMapSettings({
          providerName: this.mapProvider, rawBlockSettings: rawSettings, blockPatch,
          blockOverrides: css !== (baseCss ?? '') ? { css } : undefined,
          placeCount: places.length,
        });
        perf.mark('preparation-complete', { batches: batchCount, places: places.length, durationMs: performance.now() - preparationStarted });
        labelErrors = (summarizeLabelOutcomes(places, blockSettings, labelOutcomes)?.errors ?? []).map(e => ({ path: e.filePath || e.placeName, error: e.message, type: 'Label Template' }));
      } finally {
        progress.remove();
        this.removeChild(progress);
      }
    }

    const planPerf = createPerformanceMonitor('bases-plan', { places: places.length, provider: this.mapProvider }, { enabled: PlacesPlugin.settings.developerMode });
    const built = planPerf.measure('build-plan', () => this.buildPlan({ places, overlays: [], resolved, camera, mapSource }));

    built.errors.push(...labelErrors);
    if (!await this.applyPlan(provider, built.plan, myGeneration) || myGeneration !== this.renderGeneration) return;
    renderMapContentErrors(this.containerEl, built.errors, CONFIG_ERRORS_CLASS);

    if (this.overlays) {
      this.attachAsyncOverlayLoad({ places, resolved, camera, mapSource }, myGeneration);
    }
  }

  private async applyPlan(provider: IMapBlockProcessor | null, plan: MapRenderPlan, myGeneration: number): Promise<MapSurfaceController | null> {
    const configSignature = this.computeConfigSignature();
    const existing = this.needsFullRender ? undefined : getMapSurfaceController(this.mapContainerEl);

    if (existing && provider && this.currentMapProcessor === provider) {
      this.logDebug('plan handed to surface controller', {
        reason: this.pendingRenderReason,
        places: plan.places.length,
        configHash: hashString36(configSignature),
        planHash: hashString36(plan.signature),
      });
      existing.setPlan(plan, { source: 'bases-update' });
      await existing.reconcile();

      return existing;
    }

    this.logDebug('full render', {
      reason: this.pendingRenderReason,
      provider: this.mapProvider,
      places: plan.places.length,
      clusteringEnabled: plan.clusteringEnabled,
      configHash: hashString36(configSignature),
      planHash: hashString36(plan.signature),
    });

    this.needsFullRender = false;
    this.cleanupMap();
    this.currentMapProcessor = provider;

    const surface = await renderMapSurface({
      host: this.containerEl,
      mapContainer: this.mapContainerEl,
      places: plan.places,
      providerName: this.mapProvider,
      config: plan.config,
      clusteringEnabled: plan.clusteringEnabled,
      height: plan.config.height,
      focusOnInteraction: false,
      registerCleanup: false,
      renderPlan: plan,
      onRerenderRequested: reason => {
        this.needsFullRender = true;
        this.scheduleMapUpdate({ force: true, reason: `rebuild: ${reason}` });

        return Promise.resolve();
      },
      chrome: { onRefresh: () => this.updateMapNow('manual refresh') },
    });

    if (!surface.rendered || !surface.controller) {
      this.lastUpdateSignature = null;

      return null;
    }

    if (myGeneration !== this.renderGeneration) return null;
    this.hasRenderedMap = true;
    this.logDebug('full render complete', {
      provider: this.mapProvider,
      places: plan.places.length,
      configHash: hashString36(configSignature),
      planHash: hashString36(plan.signature),
    });

    return surface.controller;
  }

  private attachAsyncOverlayLoad(options: Omit<BasesPlanInput, 'overlays'>, generation: number): void {
    const progress = createOverlayLoadProgress(this.containerEl);

    void this.overlayService.loadOverlays(this.overlays)
      .then(async overlayResult => {
        progress.remove();
        if (generation !== this.renderGeneration) return;
        const errors: MapContentError[] = overlayResult.errors.map(e => ({ ...e, type: 'Overlay' }));

        if (overlayResult.overlays.length > 0) {
          const next = this.buildPlan({ ...options, overlays: overlayResult.overlays });

          errors.push(...next.plan.errors.map(e => ({ ...e, type: 'Overlay' })));
          const controller = getMapSurfaceController(this.mapContainerEl);

          if (controller) {
            controller.setPlan(next.plan, { source: 'async-overlays' });

            await controller.reconcile();
          }
        }

        if (generation === this.renderGeneration) renderMapContentErrors(this.containerEl, errors, OVERLAY_ERRORS_CLASS);
      })
      .catch(error => {
        progress.remove();
        if (generation !== this.renderGeneration) return;
        logger.error('Async overlay loading failed', error);
        renderMapContentErrors(this.containerEl, [{
          path: 'overlays',
          error: getErrorMessage(error),
          type: 'Overlay'
        }], OVERLAY_ERRORS_CLASS);
      });
  }

  private logDebug(message: string, details?: Record<string, unknown>): void {
    logger.debug(`${message}`, {
      viewId: this.viewId,
      activeViews: PlacesBasesView.activeViews.size,
      ...(details ?? {}),
    });
  }

  private showNoPlacesMessage(): void {
    const messageDiv = this.mapContainerEl.createDiv({ cls: 'places-instructions' });

    messageDiv.createEl('h3', { text: 'No places found to display' });

    messageDiv.createEl('p', { text: 'The Bases query returned no notes with location data.' });

    const methodsDiv = messageDiv.createDiv({ cls: 'places-method' });

    methodsDiv.createEl('h4', { text: 'Add location information to notes:' });
    const pre = methodsDiv.createEl('pre');

    pre.createEl('code', {
      text: '---\nLocation: 40.748333, -73.985556\nicon: 🏢\n---'
    });

    const { locationId, iconId, titleId } = this.propertyMappings;

    if (locationId || iconId || titleId) {
      const mappingsDiv = messageDiv.createDiv({ cls: 'places-method' });

      mappingsDiv.createEl('h4', { text: 'Current property mappings:' });
      const mappingsList = mappingsDiv.createEl('ul');

      if (locationId) mappingsList.createEl('li', { text: `Location property: ${this.config.getDisplayName(locationId)}` });
      if (iconId) mappingsList.createEl('li', { text: `Icon property: ${this.config.getDisplayName(iconId)}` });
      if (titleId) mappingsList.createEl('li', { text: `Title property: ${this.config.getDisplayName(titleId)}` });
    }
  }

  private cleanupMap(): void {
    cleanupMapContainer(this.mapContainerEl);
    this.currentMapProcessor = null;

    for (const className of [CONFIG_ERRORS_CLASS, OVERLAY_ERRORS_CLASS]) {
      renderMapContentErrors(this.containerEl, [], className);
    }

    this.mapContainerEl.empty();
  }

  private getViewportStateSourcePath(): string {
    const basesPath = this.getBasesFilePath();
    const viewName = this.config?.name || 'places-map';

    return ['bases', basesPath ?? this.getDataSignatureFallback(), viewName].join(':');
  }

  private getBasesFilePath(): string | null {
    const controller = this.queryController as unknown as Record<string, unknown>;
    const candidates = [
      this.readPath(controller.file),
      this.readPath(controller.baseFile),
      this.readString(controller.sourcePath),
      this.readString(controller.filePath),
      this.readString(controller.path),
      this.app.workspace.getActiveFile()?.path ?? null,
      this.scrollEl.closest('[data-path]')?.getAttribute('data-path') ?? null
    ];

    return candidates.find((path): path is string => Boolean(path)) ?? null;
  }

  private readPath(value: unknown): string | null {
    if (value && typeof value === 'object' && 'path' in value) {
      return this.readString((value as { path?: unknown }).path);
    }

    return null;
  }

  private readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value : null;
  }

  private getDataSignatureFallback(): string {
    const paths = (this.data?.data ?? [])
      .map(entry => entry.file?.path)
      .filter((path): path is string => Boolean(path))
      .sort()
      .join('|');

    return paths ? ['query', paths].join(':') : 'unknown';
  }

  private showContextMenu(evt: MouseEvent): void {
    Menu.forEvent(evt);
  }

  static getViewOptions(): ViewOption[] {
    const availableProviders = PlacesPlugin.getAllMapProviders();

    return [
      {
        displayName: 'Map',
        type: 'group',
        items: [
          {
            displayName: 'Map provider',
            type: 'text',
            key: 'mapProvider',
            default: DEFAULT_MAP_PROVIDER,
            placeholder: availableProviders.join(', '),
          },
          {
            displayName: 'Style',
            type: 'text',
            key: 'style',
            placeholder: 'streets, satellite, outdoors, terrain',
          },
          {
            displayName: 'Height',
            type: 'text',
            key: 'height',
            default: DEFAULT_MAP_HEIGHT,
            placeholder: 'calc(100vh - 200px), 500px, 100vh',
          },
          {
            displayName: 'Initial zoom',
            type: 'text',
            key: 'initialZoom',
            placeholder: '12, 14.5',
          },
          {
            displayName: 'Initial center',
            type: 'text',
            key: 'initialCenter',
            placeholder: '41.408, -75.662',
          },
          {
            displayName: 'Minimum zoom',
            type: 'text',
            key: 'minZoom',
            placeholder: '3',
          },
          {
            displayName: 'Show labels',
            type: 'toggle',
            key: 'showLabels',
            default: true,
          },
          {
            displayName: 'Show current device position',
            type: 'toggle',
            key: 'showCurrentDevicePosition',
            default: PlacesPlugin.settings.showCurrentDevicePosition,
          },
          {
            displayName: 'Marker renderer',
            type: 'text',
            key: 'markerRenderer',
            placeholder: 'native, html',
          },
          {
            displayName: 'Cluster threshold',
            type: 'text',
            key: 'clusterThreshold',
            placeholder: 'Number of places before clustering starts',
          },
          {
            displayName: 'Cluster GeoJSON overlays',
            type: 'toggle',
            key: 'clusterGeoJsonOverlays',
          },
          {
            displayName: 'Cluster appearance',
            type: 'text',
            key: 'clusterStyle',
            placeholder: 'circles or heatmap',
          },
          {
            displayName: 'POI discovery',
            type: 'toggle',
            key: 'poiDiscovery',
            default: PlacesPlugin.settings.poiDiscovery,
          },
          {
            displayName: 'Enable pitch/tilt',
            type: 'toggle',
            key: 'pitch',
            default: false,
          },
          {
            displayName: 'Debug overlay',
            type: 'toggle',
            key: 'debug',
            default: false,
          },
          {
            displayName: 'Heatmap layer',
            type: 'toggle',
            key: 'heatmapLayer',
            default: false,
          },
          {
            displayName: 'Heatmap color scheme',
            type: 'text',
            key: 'heatmapColorScheme',
            placeholder: 'plasma, pastel, viridis, inferno, magma, or #ffffcc,#e31a1c',
          },
        ]
      },
      {
        displayName: 'Terrain',
        type: 'group',
        items: [
          {
            displayName: 'Terrain provider',
            type: 'text',
            key: 'terrain.provider',
            placeholder: [...PlacesPlugin.getTerrainProviderNames(), 'aws'].join(', '),
          },
          {
            displayName: 'Exaggeration',
            type: 'text',
            key: 'terrain.exaggeration',
            placeholder: '1.4, 2, 1 @z6, 2.5 @z13',
          },
          {
            displayName: 'Color relief opacity',
            type: 'text',
            key: 'terrain.colorRelief.opacity',
            placeholder: '0.4, 0, 0.7',
          },
        ]
      },
      {
        displayName: 'Tracks',
        type: 'group',
        items: [
          {
            displayName: 'Color tracks by',
            type: 'text',
            key: 'track.colorBy',
            placeholder: 'none, elevation, grade, speed, pace',
          },
          {
            displayName: 'Direction arrows',
            type: 'text',
            key: 'track.directionArrows',
            placeholder: '1, 0, 0.5, 2',
          },
          {
            displayName: 'Default track visibility',
            type: 'text',
            key: 'track.defaultVisibility',
            placeholder: 'hidden, visible',
          },
          {
            displayName: 'Grade window',
            type: 'text',
            key: 'track.gradeWindow',
            default: '100ft',
            placeholder: '100ft, 50m, 0.1mi',
          },
          {
            displayName: 'Track outline',
            type: 'toggle',
            key: 'track.outline',
            default: false,
          },
          {
            displayName: 'Color legend',
            type: 'text',
            key: 'legend',
            default: 'hidden',
            placeholder: 'hidden, top, bottom',
          },
          {
            displayName: 'Track labels',
            type: 'text',
            key: 'track.labels.visibility',
            placeholder: 'all, none, start, midpoint, end',
          },
          {
            displayName: 'Track start label',
            type: 'text',
            key: 'track.labels.start',
            placeholder: '{this.title}',
          },
          {
            displayName: 'Track midpoint label',
            type: 'text',
            key: 'track.labels.midpoint',
            placeholder: "{h.round(this.Distance)}",
          },
          {
            displayName: 'Track end label',
            type: 'text',
            key: 'track.labels.end',
            placeholder: 'Finish',
          },
        ]
      },
      {
        displayName: 'Overlays',
        type: 'group',
        items: [
          {
            displayName: 'Overlays',
            type: 'text',
            key: 'overlays',
            placeholder: '- path: file.gpx\n  labelTemplate: "{this.name}"',
          },
        ]
      },
      {
        displayName: 'Styling',
        type: 'group',
        items: [
          {
            displayName: 'Custom CSS',
            type: 'text',
            key: 'css',
            placeholder: '.places-marker { opacity: 0.8; }',
          },
          {
            displayName: 'Icon styles',
            type: 'text',
            key: 'iconStyles',
            placeholder: 'tag:hiking: opacity: 0.5',
          },
          {
            displayName: 'Label styles',
            type: 'text',
            key: 'labelStyles',
            placeholder: 'tag:favorite: color: gold',
          },
          {
            displayName: 'Label template',
            type: 'text',
            key: 'labelTemplate',
            placeholder: '{this.name.split(",")[0]}',
          },
          {
            displayName: 'Icon rotation',
            type: 'text',
            key: 'iconRotation',
            placeholder: '{this.bearing}',
          },
        ]
      },
      {
        displayName: 'Property Mappings',
        type: 'group',
        items: [
          {
            displayName: 'Location property',
            type: 'property',
            key: 'locationProperty',
            default: 'Location',
            placeholder: 'Location',
          },
          {
            displayName: 'Title property',
            type: 'property',
            key: 'titleProperty',
            default: '',
            placeholder: 'title (empty = filename)',
          },
          {
            displayName: 'Icon property',
            type: 'property',
            key: 'iconProperty',
            default: 'icon',
            placeholder: 'icon',
          },
        ]
      },
    ];
  }
}

export function coerceViewOptionValue(path: string, value: unknown): unknown {
  if (path === 'height' && typeof value === 'number') return `${value}px`;
  if (path === 'track.directionArrows' && typeof value === 'boolean') return value ? 1 : 0;
  if (path === 'initialCenter' && Array.isArray(value) && value.length >= 2) return `${String(value[0])},${String(value[1])}`;

  return value;
}
