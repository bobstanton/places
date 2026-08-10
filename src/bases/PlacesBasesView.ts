import { logger as rootLogger } from "places-shared/utils";
import { BasesView, debounce, Menu, Notice, QueryController, type BasesPropertyId } from "obsidian";
type ViewOption = { displayName: string; type: string; key?: string; default?: string | boolean; placeholder?: string; items?: ViewOption[] };
import { type TrackColorBy } from "places-shared/track";
import { createElevationLegend, createGradeLegend, getElevationRange, getLegendPosition } from "../ui/ColorLegend";
import { type Meters } from "places-shared/units";
import { MapPlace, Overlay, OverlayResult } from "places-shared/overlay";
import { type Place } from "places-shared/place";
import { MarkerStyleService, MarkerStyleConfig, setMapRecoveryState, clearMapRecoveryState, suppressMapContextLossDuring, cleanupMapProviderStates } from "places-shared/map";
import { createMapRenderPlan, resolveCameraIntent, type MapCameraIntent, type CreateMapRenderPlanOptions as MapRenderPlanOptions } from "places-shared/render";
import { DEFAULT_MAP_HEIGHT, type MetricWindow } from "places-shared/settings";
import { IMapBlockProcessor } from "places-shared/services";
import { renderMapSurfaceError, getErrorMessage, hashString36, scalarToString } from "places-shared/utils";
import { BasesDataAdapter } from "./BasesDataAdapter";
import { TrackInspectionService } from "../services/TrackInspectionService";
import { applyIconRotation } from "../services/IconRotationService";
import PlacesPlugin from "../main";
import { missingMapProviderError } from "../services/MissingPluginError";
import { OverlayService } from "../services/OverlayService";
import { getLabelTemplateService } from "../services/LabelTemplateService";
import { injectPathLabels } from "../services/PathLabelService";
import { getMapSurfaceController, disposeMapSurfaceController } from "../services/MapSurfaceControllers";
import { resolveMapSettings } from "../services/MapSettingsResolver";
import { mapConfigPaths } from "places-shared/settings";
import { createFloatingButtonContainer, createGeocodingSearchButton, createMarkerSearchButton, createMarkerSearchToggle, CREATE_NOTE_ACTION_ID, type GeocodingSearchButtonHandle } from "../services/MapFloatingControls";
import { createFloatingRefreshButton } from "places-shared/ui";
import { renderMapSurface } from "../services/MapSurfaceRenderer";

const logger = rootLogger.scope('Places Bases');

const PlacesMapViewType = 'places-map';

const DEFAULT_MAP_PROVIDER = '';
const BASES_RENDER_DEBOUNCE_MS = 150;

export interface PropertyMappings {
  location: string;
  icon: string;
  title: string;
  locationId: BasesPropertyId | null;
  iconId: BasesPropertyId | null;
  titleId: BasesPropertyId | null;
}

interface AsyncOverlayLoad {
  promise: Promise<{
    overlays: Overlay[];
    errors: Array<{ path: string; error: string; type: string }>;
  }>;
}

export class PlacesBasesView extends BasesView {
  type = PlacesMapViewType;
  scrollEl: HTMLElement;
  containerEl: HTMLElement;
  mapContainerEl: HTMLElement;

  private mapProvider: string = '';
  private mapHeight: string = DEFAULT_MAP_HEIGHT;
  private mapStyle: string = '';
  private initialZoom?: number;
  private initialCenter?: string;
  private minZoom?: number;
  private trackColorBy?: TrackColorBy;
  private trackDirectionArrows?: number;
  private showLabels: boolean = true;
  private trackDefaultVisibility: string = '';
  private trackGradeWindow = '';
  private trackOutline?: boolean;
  private markerRenderer: string = '';
  private clusterThreshold?: number;
  private clusterGeoJsonOverlays?: boolean;
  private poiDiscovery: boolean = true;
  private pitch: boolean = false;
  private terrainProvider = '';
  private terrainExaggeration = '';
  private colorReliefOpacity = '';
  private overlays: string = '';
  private customCss: string = '';
  private iconStyles: string = '';
  private labelStyles: string = '';
  private labelTemplate: string = '';
  private iconRotation: string = '';
  private legend: string = 'hidden';
  private trackLabelsVisibility: string = '';
  private trackLabelsStart: string = '';
  private trackLabelsMidpoint: string = '';
  private trackLabelsEnd: string = '';
  private debug: boolean = false;
  private heatmapLayer: boolean = false;
  private heatmapColorScheme: string = '';
  private propertyMappings: PropertyMappings = {
    location: "Location",
    icon: "icon",
    title: "",
    locationId: null,
    iconId: null,
    titleId: null
  };

  private currentMapProcessor: IMapBlockProcessor | null = null;
  private currentPlaces: MapPlace[] = [];
  private needsFullRender = false;
  private overlayService: OverlayService;
  private lastUpdateSignature: string | null = null;
  private lastDataSignature: string | null = null;
  private lastConfigSignature: string | null = null;
  private pendingRenderReason = 'initial';
  private renderGeneration = 0;
  private renderTimer: number | null = null;
  private hasRenderedMap = false;
  private needsProviderRetry = false;
  private readonly viewId = PlacesBasesView.nextViewId();
  private static activeViews = new Set<PlacesBasesView>();
  private static viewSequence = 0;

  private static nextViewId(): number {
    PlacesBasesView.viewSequence += 1;
    return PlacesBasesView.viewSequence;
  }

  constructor(private readonly queryController: QueryController, scrollEl: HTMLElement) {
    super(queryController);
    this.scrollEl = scrollEl;
    this.containerEl = scrollEl.createDiv({ cls: 'places-bases-container is-loading', attr: { tabIndex: '0' } });
    this.mapContainerEl = this.containerEl.createDiv({ cls: 'places-bases-map', attr: { tabIndex: '0' } });
    this.overlayService = new OverlayService(this.app);
  }

  private getCombinedIconStyles(): string {
    return [PlacesPlugin.settings.defaultIconStyles, this.iconStyles]
      .filter((value): value is string => Boolean(value?.trim()))
      .join('\n');
  }

  private getCombinedLabelStyles(): string {
    return [PlacesPlugin.settings.defaultLabelStyles, this.labelStyles]
      .filter((value): value is string => Boolean(value?.trim()))
      .join('\n');
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
    const tracks = PlacesPlugin.getTrackDataService();
    if (!tracks) return undefined;
    const service = new TrackInspectionService(tracks, () => PlacesPlugin.settings, speedWindow);
    return (place, coordinate) => service.inspect(place, coordinate, sourcePath ?? '');
  }


  // Copy any declared map setting the explicit reads above do not already handle.
  // Runs last and never overwrites: a view keeps its own behaviour for the keys it
  // interprets, and a setting added for code blocks reaches this view without a
  // second edit here. Dotted paths become the nested shape resolveMapSettings parses.
  private fillDeclaredConfig(target: Record<string, unknown>): void {
    for (const path of mapConfigPaths()) {
      const value = this.config.get(path);
      if (value === undefined || value === null || value === '') continue;

      const segments = path.split('.');
      let node = target;
      let occupied = false;
      for (const segment of segments.slice(0, -1)) {
        const next = node[segment];
        if (next !== undefined && (typeof next !== 'object' || next === null)) { occupied = true; break; }
        node = (next as Record<string, unknown>) ?? (node[segment] = {});
      }
      if (occupied) continue;

      const leaf = segments[segments.length - 1];
      if (node[leaf] === undefined) node[leaf] = value;
    }
  }

  private computeConfigSignature(): string {
    // Map settings come from the shared list, so a setting added for code blocks
    // changes this view's signature too. The rest are Bases-only: which column
    // supplies a place's location, title and icon.
    const configKeys = [...mapConfigPaths(), 'overlays', 'heatmapColorScheme',
      'locationProperty', 'titleProperty', 'iconProperty'];
    return configKeys.map(k => scalarToString(this.config.get(k))).join(',');
  }

  public onDataUpdated(): void {
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
      this.renderGeneration++;
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
    try {
      await this.renderMap();
    } catch (error) {
      this.reportRenderError(error);
    }
  }

  private async updateMapNow(reason: string): Promise<void> {
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

  private getStringConfig(key: string, fallback = ''): string {
    const value = this.config.get(key);
    return typeof value === 'string' && value.trim() ? value : fallback;
  }

  private getBooleanConfig(key: string, fallback: boolean): boolean {
    const value = this.config.get(key);
    if (value === undefined) return fallback;
    return value === true || value === 'true';
  }

  private getOptionalNumberConfig(key: string): number | undefined {
    const value = this.config.get(key);
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private getHeightConfig(key: string, fallback: string): string {
    const value = this.config.get(key);
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number') return value + 'px';
    return fallback;
  }

  private getOptionalBooleanConfig(key: string): boolean | undefined {
    const value = this.config.get(key);
    if (value === undefined) return undefined;
    return value === true || value === 'true';
  }

  private getEnumConfig<T extends string>(key: string, validValues: readonly T[]): T | undefined {
    const value = this.config.get(key);
    return typeof value === 'string' && validValues.includes(value as T) ? value as T : undefined;
  }

  private getDirectionArrowScaleConfig(): number | undefined {
    const value = this.config.get('track.directionArrows');
    if (typeof value === 'boolean') return value ? 1 : 0;
    return this.getOptionalNumberConfig('track.directionArrows');
  }

  private buildTerrainSetting(): Record<string, unknown> | undefined {
    const terrain: Record<string, unknown> = {};
    if (this.terrainProvider) terrain.provider = this.terrainProvider;
    if (this.terrainExaggeration) terrain.exaggeration = this.terrainExaggeration;
    if (this.colorReliefOpacity) terrain.colorRelief = { opacity: this.colorReliefOpacity };
    return Object.keys(terrain).length > 0 ? terrain : undefined;
  }

  private getInitialCenterConfig(): string | undefined {
    const value = this.config.get('initialCenter');
    if (typeof value === 'string' && value.trim()) return value;
    if (Array.isArray(value) && value.length >= 2) return `${String(value[0])},${String(value[1])}`;
    return undefined;
  }

  private loadConfig(): void {
    this.resetConfigDefaults();

    const explicitProvider = this.getStringConfig('mapProvider') || undefined;
    this.mapProvider = PlacesPlugin.resolveMapProvider(explicitProvider);

    this.mapHeight = this.getHeightConfig('height', this.mapHeight);

    this.trackColorBy = this.getEnumConfig<TrackColorBy>('track.colorBy', ['none', 'elevation', 'grade', 'speed', 'pace']);

    this.trackDirectionArrows = this.getDirectionArrowScaleConfig();

    this.showLabels = this.getBooleanConfig('showLabels', this.showLabels);

    this.trackDefaultVisibility = this.getStringConfig('track.defaultVisibility', this.trackDefaultVisibility);

    this.trackGradeWindow = this.getStringConfig('track.gradeWindow');

    this.trackOutline = this.getOptionalBooleanConfig('track.outline');

    this.markerRenderer = this.getEnumConfig<'native' | 'html'>('markerRenderer', ['native', 'html']) ?? '';

    this.clusterThreshold = this.getOptionalNumberConfig('clusterThreshold');

    this.clusterGeoJsonOverlays = this.getOptionalBooleanConfig('clusterGeoJsonOverlays');

    this.poiDiscovery = this.getBooleanConfig('poiDiscovery', PlacesPlugin.settings.poiDiscovery);

    this.pitch = this.getBooleanConfig('pitch', this.pitch);

    this.terrainProvider = this.getStringConfig('terrain.provider');
    this.terrainExaggeration = this.getStringConfig('terrain.exaggeration');
    this.colorReliefOpacity = this.getStringConfig('terrain.colorRelief.opacity');

    this.mapStyle = this.getStringConfig('style', this.mapStyle);

    this.initialZoom = this.getOptionalNumberConfig('initialZoom');

    this.initialCenter = this.getInitialCenterConfig();

    this.minZoom = this.getOptionalNumberConfig('minZoom');

    this.overlays = this.getStringConfig('overlays', this.overlays);

    this.customCss = this.getStringConfig('css', this.customCss);

    this.iconStyles = this.getStringConfig('iconStyles', this.iconStyles);

    this.labelStyles = this.getStringConfig('labelStyles', this.labelStyles);

    this.labelTemplate = this.getStringConfig('labelTemplate');
    this.iconRotation = this.getStringConfig('iconRotation');

    this.legend = this.getStringConfig('legend', 'hidden');

    this.trackLabelsVisibility = this.getStringConfig('track.labels.visibility');

    this.trackLabelsStart = this.getStringConfig('track.labels.start');

    this.trackLabelsMidpoint = this.getStringConfig('track.labels.midpoint');

    this.trackLabelsEnd = this.getStringConfig('track.labels.end');

    this.debug = this.getBooleanConfig('debug', this.debug);

    this.heatmapLayer = this.getBooleanConfig('heatmapLayer', this.heatmapLayer);

    this.heatmapColorScheme = this.getStringConfig('heatmapColorScheme');

    this.propertyMappings = {
      location: "Location",
      icon: "icon",
      title: "",
      locationId: this.config.getAsPropertyId('locationProperty'),
      iconId: this.config.getAsPropertyId('iconProperty'),
      titleId: this.config.getAsPropertyId('titleProperty')
    };

    this.mapContainerEl.setCssProps({
      '--places-map-height': this.mapHeight
    });
  }

  private resetConfigDefaults(): void {
    this.mapProvider = PlacesPlugin.resolveMapProvider(undefined);
    this.mapHeight = DEFAULT_MAP_HEIGHT;
    this.mapStyle = '';
    this.initialZoom = undefined;
    this.initialCenter = undefined;
    this.minZoom = undefined;
    this.trackColorBy = undefined;
    this.trackDirectionArrows = undefined;
    this.showLabels = true;
    this.trackDefaultVisibility = '';
    this.trackGradeWindow = '';
    this.trackOutline = undefined;
    this.markerRenderer = '';
    this.clusterThreshold = undefined;
    this.clusterGeoJsonOverlays = undefined;
    this.poiDiscovery = PlacesPlugin.settings.poiDiscovery;
    this.pitch = false;
    this.terrainProvider = '';
    this.terrainExaggeration = '';
    this.colorReliefOpacity = '';
    this.overlays = '';
    this.customCss = '';
    this.iconStyles = '';
    this.labelStyles = '';
    this.labelTemplate = '';
    this.iconRotation = '';
    this.legend = 'hidden';
    this.trackLabelsVisibility = '';
    this.trackLabelsStart = '';
    this.trackLabelsMidpoint = '';
    this.trackLabelsEnd = '';
    this.debug = false;
    this.heatmapLayer = false;
    this.heatmapColorScheme = '';
    this.propertyMappings = {
      location: "Location",
      icon: "icon",
      title: "",
      locationId: null,
      iconId: null,
      titleId: null
    };
  }

  private async renderMap(): Promise<void> {
    const myGeneration = this.renderGeneration;

    if (!this.data) {
      logger.warn('No data available for map rendering');
      return;
    }

    const places = BasesDataAdapter.convertToMapPlaces(this.data.data ?? [], this.app, this.propertyMappings);
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

    const labelTemplate = this.labelTemplate || PlacesPlugin.settings.defaultLabelTemplate;
    if (labelTemplate) {
      const labelService = getLabelTemplateService();
      const result = await labelService.processPlaces(places, labelTemplate);
      if (myGeneration !== this.renderGeneration) return;
      if (result.errors.length > 0) {
        logger.warn(`${result.errors.length} label template error(s)`);
      }
    }

    const styleConfig: MarkerStyleConfig = {
      css: this.customCss,
      iconStyles: MarkerStyleService.parseRules(this.getCombinedIconStyles()),
      labelStyles: MarkerStyleService.parseRules(this.getCombinedLabelStyles())
    };
    MarkerStyleService.processPlaces(places, styleConfig);
    const rotation = await applyIconRotation(places, this.iconRotation);
    if (myGeneration !== this.renderGeneration) return;
    if (rotation.errors.length > 0) logger.warn(`${rotation.errors.length} icon rotation error(s)`);

    const provider = PlacesPlugin.getMapProvider(this.mapProvider);
    if (!provider) {
      this.needsProviderRetry = true;
      this.logDebug('full cleanup', { reason: 'provider missing', provider: this.mapProvider });
      this.cleanupMap();
      this.showMapProviderError();
      return;
    }
    this.needsProviderRetry = false;

    const hasAsyncOverlayWork = Boolean(this.overlays);
    const overlayLoadPromise: Promise<OverlayResult> = this.overlays
      ? this.overlayService.loadOverlays(this.overlays)
      : Promise.resolve({ overlays: [], errors: [] as Array<{ path: string; error: string }> });

    const mapSource = { path: this.getViewportStateSourcePath(), lineStart: 0 };

    const rawSettings: Record<string, unknown> = {
      mapProvider: this.mapProvider,
      height: this.mapHeight,
      width: '100%',
      showLabels: this.showLabels,
      poiDiscovery: this.poiDiscovery,
      pitch: this.pitch,
      debug: this.debug,
      heatmapLayer: this.heatmapLayer,
      legend: this.legend,
    };

    if (this.mapStyle) {
      rawSettings.style = this.mapStyle;
    }
    if (this.initialZoom !== undefined) {
      rawSettings.initialZoom = this.initialZoom;
    }
    if (this.initialCenter) {
      rawSettings.initialCenter = this.initialCenter;
    }
    if (this.minZoom !== undefined) {
      rawSettings.minZoom = this.minZoom;
    }
    const track: Record<string, unknown> = {};
    if (this.trackGradeWindow) {
      track.gradeWindow = this.trackGradeWindow;
    }
    if (this.trackColorBy) {
      track.colorBy = this.trackColorBy;
    }
    if (this.trackDirectionArrows !== undefined) {
      track.directionArrows = this.trackDirectionArrows;
    }
    if (this.trackDefaultVisibility) {
      track.defaultVisibility = this.trackDefaultVisibility;
    }
    if (this.trackOutline !== undefined) {
      track.outline = this.trackOutline;
    }
    const terrainSetting = this.buildTerrainSetting();
    if (terrainSetting) {
      rawSettings.terrain = terrainSetting;
    }
    if (this.markerRenderer) {
      rawSettings.markerRenderer = this.markerRenderer;
    }
    if (this.clusterThreshold !== undefined) {
      rawSettings.clusterThreshold = this.clusterThreshold;
    }
    if (this.clusterGeoJsonOverlays !== undefined) {
      rawSettings.clusterGeoJsonOverlays = this.clusterGeoJsonOverlays;
    }
    const badgeCss = MarkerStyleService.buildBadgeCss(places);
    const combinedCss = [this.customCss, badgeCss].filter(Boolean).join('\n');
    if (combinedCss) {
      rawSettings.css = combinedCss;
    }
    if (this.heatmapColorScheme) {
      rawSettings.heatmapColorScheme = this.heatmapColorScheme;
    }
    const trackLabels: Record<string, unknown> = {};
    if (this.trackLabelsVisibility) {
      trackLabels.visibility = this.trackLabelsVisibility;
    }
    if (this.trackLabelsStart) {
      trackLabels.start = this.trackLabelsStart;
    }
    if (this.trackLabelsMidpoint) {
      trackLabels.midpoint = this.trackLabelsMidpoint;
    }
    if (this.trackLabelsEnd) {
      trackLabels.end = this.trackLabelsEnd;
    }
    if (Object.keys(trackLabels).length > 0) {
      track.labels = trackLabels;
    }
    if (Object.keys(track).length > 0) {
      rawSettings.track = track;
    }

    // Unset reads as undefined, not ''. The label cascade tests `blockValue !== undefined`,
    // so an empty string counts as "the view set this to nothing" and stops the fall-through
    // to the global and coded defaults - which is every path label a view would otherwise show.
    const unsetAsUndefined = (value: string): string | undefined => (value.trim() === '' ? undefined : value);
    await injectPathLabels(places, {
      showLabels: this.showLabels,
      trackLabelsVisibility: unsetAsUndefined(this.trackLabelsVisibility),
      trackLabelsStart: unsetAsUndefined(this.trackLabelsStart),
      trackLabelsMidpoint: unsetAsUndefined(this.trackLabelsMidpoint),
      trackLabelsEnd: unsetAsUndefined(this.trackLabelsEnd),
    }, PlacesPlugin.settings);

    const overlayErrors: Array<{ path: string; error: string; type: string }> = [];

    if (myGeneration !== this.renderGeneration) return;

    const asyncOverlayLoad: AsyncOverlayLoad | undefined = hasAsyncOverlayWork
      ? {
        promise: overlayLoadPromise.then(overlayResult => ({
          overlays: overlayResult.overlays,
          errors: overlayResult.errors.map(e => ({ ...e, type: 'Overlay' })),
        }))
      }
      : undefined;

    const overlays: Overlay[] = [];

    this.fillDeclaredConfig(rawSettings);
    const { config, clusteringEnabled } = resolveMapSettings({
      providerName: this.mapProvider,
      rawBlockSettings: rawSettings,
      placeCount: places.length,
    });
    const terrain = PlacesPlugin.resolveTerrainRuntime(config);
    overlayErrors.push(...terrain.errors.map(e => ({ ...e, type: 'Terrain' })));
    const renderPlan = createMapRenderPlan({
      surfaceKind: 'bases-view',
      places,
      overlays,
      config,
      clusteringEnabled,
      source: mapSource,
      camera: resolveCameraIntent(config, mapSource),
      placeNoteHost: PlacesPlugin.placeNoteHost,
      reverseGeocodeHost: PlacesPlugin.reverseGeocodeHost,
      onPlaceAction: this.handleSearchResultAction,
      // Clicking a track shows its distance/elevation/speed, as in a places block.
      inspectTrack: this.createTrackInspector(config.trackSpeedWindow, mapSource.path),
      trackLoader: PlacesPlugin.getTrackDataService(),
      terrainDem: terrain.terrainDem,
      reliefDem: terrain.reliefDem,
      // No contextMenuActions: those come from a block's `queryParameters`, which
      // a Bases view has no equivalent of. mapTools are likewise omitted
      // deliberately.
    });
    const legendPosition = getLegendPosition(renderPlan.config.trackColorBy, renderPlan.config.legend);

    const configSignature = this.computeConfigSignature();
    const controller = this.needsFullRender ? undefined : getMapSurfaceController(this.mapContainerEl);
    if (controller && this.currentMapProcessor === provider) {
      this.logDebug('plan handed to surface controller', {
        reason: this.pendingRenderReason,
        places: renderPlan.places.length,
        configHash: hashString36(configSignature),
        planHash: hashString36(renderPlan.signature),
      });
      controller.setPlan(renderPlan, { source: 'bases-update' });
      await controller.reconcile();
      if (asyncOverlayLoad) {
        this.attachAsyncOverlayLoad(asyncOverlayLoad, { places: renderPlan.places, rawSettings, mapSource, camera: renderPlan.camera });
      }
      return;
    }

    this.logDebug('full render', {
      reason: this.pendingRenderReason,
      provider: this.mapProvider,
      places: renderPlan.places.length,
      clusteringEnabled,
      configHash: hashString36(configSignature),
      planHash: hashString36(renderPlan.signature),
    });

    this.needsFullRender = false;
    this.cleanupMap();
    this.removeErrorPanel();

    this.currentMapProcessor = provider;
    this.currentPlaces = renderPlan.places;

    try {
      if (legendPosition === 'top') {
        this.addMapLegend('top', renderPlan.config.trackColorBy, renderPlan.places);
      }

      const surface = await renderMapSurface({
        host: this.containerEl,
        mapContainer: this.mapContainerEl,
        places: renderPlan.places,
        providerName: this.mapProvider,
        config: renderPlan.config,
        clusteringEnabled,
        focusOnInteraction: false,
        registerCleanup: false,
        renderPlan,
        onRerenderRequested: reason => {
          this.needsFullRender = true;
          this.scheduleMapUpdate({ force: true, reason: `rebuild: ${reason}` });
          return Promise.resolve();
        },
        onPlanApplied: plan => {
          this.currentPlaces = plan.places;
          this.removeErrorPanel();
          this.addFloatingButtons();
        },
      });
      if (!surface.rendered) {
        this.lastUpdateSignature = null;
        return;
      }
      // After renderMapSurface: the factory registered controller-based
      // recovery; the Bases view owns its full-rebuild path instead.
      setMapRecoveryState(this.mapContainerEl, {
        rehydrate: () => {
          this.needsFullRender = true;
          this.scheduleMapUpdate({ force: true, reason: 'recovery' });
        },
        cleanup: () => this.cleanupMapInstance(),
      });
      if (myGeneration !== this.renderGeneration) return;
      this.hasRenderedMap = true;
      this.logDebug('full render complete', {
        provider: this.mapProvider,
        places: renderPlan.places.length,
        configHash: hashString36(configSignature),
        planHash: hashString36(renderPlan.signature),
      });

      this.addFloatingButtons();

      if (legendPosition === 'bottom') {
        this.addMapLegend('bottom', renderPlan.config.trackColorBy, renderPlan.places);
      }

      if (overlayErrors.length > 0) {
        this.showErrorPanel(overlayErrors);
      }

      if (asyncOverlayLoad) {
        this.attachAsyncOverlayLoad(asyncOverlayLoad, {
          places: renderPlan.places,
          rawSettings,
          mapSource,
          camera: renderPlan.camera,
        });
      }
    } catch (error) {
      this.reportRenderError(error);
    }
  }

  private attachAsyncOverlayLoad(
    asyncOverlayLoad: AsyncOverlayLoad,
    options: {
      places: MapPlace[];
      rawSettings: Record<string, unknown>;
      mapSource: { path: string; lineStart: number };
      camera: MapCameraIntent;
    }
  ): void {
    const progress = this.createOverlayLoadProgress();
    void asyncOverlayLoad.promise
      .then(async overlayResult => {
        progress.remove();

        if (overlayResult.overlays.length === 0) {
          if (overlayResult.errors.length > 0) {
            this.showErrorPanel(overlayResult.errors);
          }
          return;
        }

        const { config, clusteringEnabled } = resolveMapSettings({
          providerName: this.mapProvider,
          rawBlockSettings: options.rawSettings,
          placeCount: options.places.length,
        });
        const asyncTerrain = PlacesPlugin.resolveTerrainRuntime(config);
        const nextRenderPlan = createMapRenderPlan({
          surfaceKind: 'bases-view',
          places: options.places,
          overlays: overlayResult.overlays,
          config,
          clusteringEnabled,
          source: options.mapSource,
          camera: options.camera,
          placeNoteHost: PlacesPlugin.placeNoteHost,
      reverseGeocodeHost: PlacesPlugin.reverseGeocodeHost,
          inspectTrack: this.createTrackInspector(config.trackSpeedWindow, options.mapSource.path),
          trackLoader: PlacesPlugin.getTrackDataService(),
          terrainDem: asyncTerrain.terrainDem,
          reliefDem: asyncTerrain.reliefDem,
        });
        const allErrors = [
          ...overlayResult.errors,
          ...nextRenderPlan.errors.map(e => ({ ...e, type: 'Overlay' })),
        ];

        // A stale or disposed controller means the surface was rebuilt, and the
        // rebuild's own overlay load supersedes this one.
        const controller = getMapSurfaceController(this.mapContainerEl);
        if (controller) {
          controller.setPlan(nextRenderPlan, { source: 'async-overlays' });
          await controller.reconcile();
        }
        if (allErrors.length > 0) {
          this.showErrorPanel(allErrors);
        }
      })
      .catch(error => {
        progress.remove();
        logger.error('Async overlay loading failed', error);
        this.showErrorPanel([{
          path: 'overlays',
          error: getErrorMessage(error),
          type: 'Overlay'
        }]);
      });
  }

  private createOverlayLoadProgress(): { remove: () => void } {
    this.containerEl.querySelector('.places-overlay-load-progress')?.remove();
    this.containerEl.addClass('places-refresh-progress-host');
    const bar = this.containerEl.createDiv({ cls: 'places-refresh-progress places-overlay-load-progress' });
    return {
      remove: () => {
        bar.remove();
        if (!this.containerEl.querySelector('.places-refresh-progress')) {
          this.containerEl.removeClass('places-refresh-progress-host');
        }
      }
    };
  }

  private showErrorPanel(errors: Array<{ path: string; error: string; type: string }>): void {
    this.removeErrorPanel();
    const panel = this.containerEl.createDiv({ cls: 'places-error-panel' });

    const header = panel.createDiv({ cls: 'places-error-panel-header' });
    header.createSpan({ cls: 'places-error-panel-title', text: `⚠️ ${errors.length} overlay${errors.length > 1 ? 's' : ''} failed to load` });

    const dismissButton = header.createEl('button', { cls: 'places-error-panel-dismiss', text: '✕' });
    dismissButton.setAttribute('aria-label', 'Dismiss errors');
    dismissButton.addEventListener('click', () => this.removeErrorPanel());

    const list = panel.createEl('ul', { cls: 'places-error-panel-list' });
    for (const err of errors) {
      list.createEl('li', { text: `[${err.type}] ${err.path}: ${err.error}` });
    }
  }

  private removeErrorPanel(): void {
    const existing = this.containerEl.querySelector('.places-error-panel');
    if (existing) existing.remove();
  }

  private removeMapLegends(): void {
    for (const legend of this.containerEl.querySelectorAll('.places-color-legend')) {
      legend.remove();
    }
  }

  private addMapLegend(position: 'top' | 'bottom', colorBy: string | undefined, places: MapPlace[]): void {
    const units = PlacesPlugin.settings.units;
    let legend: HTMLElement | null = null;

    if (colorBy === 'grade') {
      legend = createGradeLegend(this.containerEl);
    } else if (colorBy === 'elevation') {
      const range = this.computeElevationRangeFromPlaces(places);
      if (range) {
        legend = createElevationLegend(this.containerEl, range.min, range.max, units);
      }
    }

    if (legend && position === 'top') {
      this.containerEl.insertBefore(legend, this.mapContainerEl);
    }
  }

  private computeElevationRangeFromPlaces(places: MapPlace[]): { min: Meters; max: Meters } | null {
    const allElevations: (Meters | undefined | null)[] = [];

    for (const place of places) {
      if (place.overlay?.track?.elevation) {
        allElevations.push(...place.overlay.track.elevation);
      }
    }

    return getElevationRange(allElevations);
  }

  private logDebug(message: string, details?: Record<string, unknown>): void {
    logger.debug(`${message}`, {
      viewId: this.viewId,
      activeViews: PlacesBasesView.activeViews.size,
      ...(details ?? {}),
    });
  }

  private readonly handleSearchResultAction = (place: MapPlace, actionId: string): void => {
    if (actionId !== CREATE_NOTE_ACTION_ID) return;
    const searchResult = place.metadata?.geocodingSearchResult as Place | undefined;
    if (searchResult) void this.saveGeocodedPlace(searchResult);
  };

  private async saveGeocodedPlace(place: Place): Promise<void> {
    try {
      const resolved = place.resolvePlace ? await place.resolvePlace() : place;
      await PlacesPlugin.placeNoteHost.createNote({
        kind: 'place',
        name: resolved.name || 'New Place',
        lat: resolved.latitude,
        lng: resolved.longitude,
        address: resolved.address,
        website: resolved.website,
        tags: resolved.tags,
      });
    } catch (error) {
      // Only resolvePlace can reject - the host reports its own failures.
      logger.error('Failed to resolve place for note creation:', error);
      new Notice('Failed to create note');
    }
  }

  private addFloatingButtons(): void {
    const buttonContainer = createFloatingButtonContainer({ host: this.containerEl });

    const controlHandle = this.currentMapProcessor?.getMapControlHandle?.(this.mapContainerEl) ?? null;
    const searchToggle = controlHandle ? createMarkerSearchToggle(this.containerEl, controlHandle, this.currentPlaces) : undefined;
    // The two panels are mutually exclusive, as in a places block.
    let markerSearchButton: HTMLElement | null = null;
    let geocoding: GeocodingSearchButtonHandle | null = null;

    if (searchToggle) {
      markerSearchButton = createMarkerSearchButton({
        buttonContainer,
        searchToggle,
        ariaLabel: 'Search markers',
        onBeforeToggle: () => geocoding?.hide(),
      });
    }

    const getMapBounds = controlHandle?.getBounds;
    const setGeocodingSearchMarkers = controlHandle?.setGeocodingSearchMarkers
      ?? ((places: MapPlace[]) => this.currentMapProcessor?.setGeocodingSearchMarkers?.(places, this.mapContainerEl));
    if (getMapBounds) {
      geocoding = createGeocodingSearchButton({
        buttonContainer,
        container: this.containerEl,
        mapContainer: this.mapContainerEl,
        getMapBounds,
        setGeocodingSearchMarkers,
        searchPlaces: (query, bounds, onPartialResults) => PlacesPlugin.placesService.lookupPlaceInBounds(query, bounds, onPartialResults),
        onCreateNote: (place) => void this.saveGeocodedPlace(place),
        centerOnPlace: controlHandle?.centerOnPlace,
        resolveResultIcon: (place) => PlacesPlugin.placeNoteHost.resolveIcon({
          kind: 'place',
          name: place.name || 'New Place',
          lat: place.latitude,
          lng: place.longitude,
          address: place.address,
          website: place.website,
          tags: place.tags,
        }),
        onBeforeOpen: () => {
          if (!searchToggle?.isVisible()) return;
          searchToggle.toggle();
          markerSearchButton?.removeClass('is-active');
        },
      });
    }

    createFloatingRefreshButton({
      buttonContainer,
      ariaLabel: 'Refresh map',
      onRefresh: async () => {
        await this.updateMapNow('manual refresh');
      },
      onError: error => logger.error('Refresh failed', error)
    });
  }

  private showNoPlacesMessage(): void {
    const messageDiv = this.mapContainerEl.createDiv({ cls: 'places-instructions' });

    messageDiv.createEl('h3', { text: 'No Places found to display' });
     
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

  private showMapProviderError(): void {
    renderMapSurfaceError(this.mapContainerEl, missingMapProviderError(this.mapProvider));

    // Help content appears below the error, not inside it
    const allProviders = PlacesPlugin.getAllMapProviders();
    if (allProviders.length > 0) {
      const providersDiv = this.mapContainerEl.createDiv({ cls: 'places-help-section' });
      providersDiv.createEl('h4', { text: 'Available map providers' });
      const providerList = providersDiv.createEl('ul');
      allProviders.forEach(provider => {
        providerList.createEl('li', { text: provider });
      });

      providersDiv.createEl('p', { text: 'Update the map provider setting to use an available provider.' });
    } else {
      this.mapContainerEl.createEl('p', { text: 'No map providers are currently installed and enabled. Install a map provider plugin (e.g., places-leaflet) to display maps.' });
    }
  }

  private cleanupMap(): void {
    disposeMapSurfaceController(this.mapContainerEl);
    this.cleanupMapInstance();
    clearMapRecoveryState(this.mapContainerEl);
    this.currentMapProcessor = null;
    this.removeErrorPanel();
    this.removeMapLegends();
    this.containerEl.querySelector('.places-floating-buttons')?.remove();
    this.mapContainerEl.empty();
  }

  private cleanupMapInstance(): void {
    suppressMapContextLossDuring(this.mapContainerEl, () => {
      cleanupMapProviderStates(this.mapContainerEl, error => {
        logger.error('Error during map cleanup:', error);
      });
    });
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

  static refreshViewsWaitingForProviders(): void {
    for (const view of PlacesBasesView.activeViews) {
      if (view.needsProviderRetry) {
        view.scheduleMapUpdate({ force: true, reason: 'provider available' });
      }
    }
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
            placeholder: 'heat, traffic, or #ffffcc,#fd8d3c,#e31a1c',
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
            type: 'toggle',
            key: 'track.directionArrows',
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
            placeholder: '100ft, 50m, 10min',
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
            displayName: 'Path labels',
            type: 'text',
            key: 'track.labels.visibility',
            placeholder: 'all, none, start, mid, end',
          },
          {
            displayName: 'Path start label',
            type: 'text',
            key: 'track.labels.start',
            placeholder: '{this.title}',
          },
          {
            displayName: 'Path midpoint label',
            type: 'text',
            key: 'track.labels.midpoint',
            placeholder: "{h.round(this.Distance)}",
          },
          {
            displayName: 'Path end label',
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
