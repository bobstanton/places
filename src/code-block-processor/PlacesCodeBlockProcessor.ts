import { logger, createPerformanceMonitor } from "places-shared/utils";
import { MarkdownPostProcessorContext, MarkdownRenderChild, App, Component, normalizePath } from "obsidian";
import { hasTrackData } from "places-shared/place";
import { collectViewportTrackCandidates, selectViewportTracks } from "places-shared/track";
import { Coordinate, parseNamedCoordinate } from "places-shared/geo";
import { MapPlace, Overlay } from "places-shared/overlay";
import { dispatchMapTrackSelection, isNonInteractivePlace, onMapTrackSelection, TRACK_INSPECTION_REQUEST_EVENT, TRACK_PLAYBACK_POSITION_EVENT, TRACK_POSITION_REQUEST_EVENT } from "places-shared/map";
import { createMapRenderPlan, resolveCameraIntent, type MapCameraIntent } from "places-shared/render";
import { MapContextAction, MapBlockSettings, buildSettingsTrace, parseBooleanOptional, type MapPrepareTimings, type MapTrackLoader, type ResolvedMapConfig, type TrackBuilderConfig } from "places-shared/settings";
import { IMapBlockProcessor } from "places-shared/services";
import { type PlaceProviderExport } from "places-shared/obsidian/services";
import { ServiceRegistry } from "../services/ServiceRegistry";
import { parseQueryParameterDefinitions, resolveOptionsQueries } from "places/core";
import { normalizeQueryParameterLayout, normalizeQueryParameterPosition } from "../ui/QueryParameterControls";
import { applyExternalParameterValue, renderParameterStrip } from "../ui/ParameterStrip";
import { Utilities, renderErrorWithHelp, getErrorMessage, roundTo } from "places-shared/utils";
import PlacesPlugin from "../main";
import { PlaceDataService } from "../services/PlaceDataService";
import { PlacesHelpCodeBlockProcessor } from "./PlacesHelpCodeBlockProcessor";
import { OverlayService } from "../services/OverlayService";
import { MapRefreshService } from "../services/MapRefreshService";
import { createMapRefreshInputResolver } from "./MapRefreshInputs";
import { MapCleanupRenderChild } from "./MapCleanupRenderChild";
import { RenderStalenessGuard } from "places-shared/obsidian/ui";
import { renderVaultQueryWaitingState } from "./VaultQueryWaitingState";
import { QueryPreparationCanceled, VaultQueryPreparingError, VaultQueryService, VaultQueryValidationError } from "../services/VaultQueryService";
import { getMapSurfaceController } from "../services/MapSurfaceControllers";
import { RouteOverlayGenerator } from "../services/RouteOverlayGenerator";
import { type ResolvedMapSettings } from "../services/MapSettingsResolver";
import { createOverlayLoadProgress, handleSearchResultAction, renderMapContentErrors, type MapContentError } from "../services/MapSurfaceChrome";
import { applyBlockWidth, createFloatingRefreshButton, createLoadingIndicator, renderSettingsTraceView } from "places-shared/obsidian/ui";
import { cleanupMapContainer } from "../services/MapSurfaceCleanup";
import { renderMapSurface, type MapSurfaceRenderResult } from "../services/MapSurfaceRenderer";
import { MapLoadingProgress } from '../ui/MapLoadingProgress';
import { collectedPlacesOf, type CollectedPlaces, AsyncOverlayLoad, PlacesRenderPreparer, TemplateNotFoundError, parseDebugModes, type PreparePhase, type PreparedPlacesRender } from "../services/PlacesRenderPreparer";
import { removeParameterDebugPanel, renderParameterDebugPanel } from "../ui/ParameterDebugView";
import type { TemplateNoteService } from "../services/TemplateNoteService";
import { TrackInspectionService } from "../services/TrackInspectionService";
import { placeSourcePaths, type PlaceSource } from "places-shared/settings";
import { BlockSyntaxError } from "places-shared/settings";
import { ParsedCodeBlock } from 'places/core';
import { CodeBlockRegistry } from "../services/CodeBlockRegistry";
import { NoteParameterRegistry, QueryParameterState, createBlockParameterTransform, type BlockParameterTransformResult } from "../services/QueryParameterState";
import { readNoteProperties } from "../services/NoteProperties";
import { createLiveCodeBlockContext, resolveCurrentSourcePath } from '../services/SourcePathRenames';
import { TrackDataService } from "../services/TrackDataService";
import { clearEmptyMapHelp, renderEmptyMapHelp, shouldShowEmptyMapHelp } from "./EmptyMapHelp";
import { missingQueryPluginError } from "../services/MissingPluginError";
import { queryUsesMapViewport, readMapViewport, resolveMapViewportQuery, subscribeMapViewportQuery, viewportParameterDeclarations, viewportParameterNames, viewportParameterValues, type MapViewportQueryContext } from "../services/MapViewportQuery";

// Per-place action id for storing the place under the block's selectionParameter.
const SET_SELECTION_ACTION_ID = 'set-selection-parameter';
const REFRESH_WARNING_THRESHOLD_MS = 500;

const PREPARE_CANCELLATION_ATTEMPTS = 10;

const PREPARE_PHASE_TEXT: Record<PreparePhase, string> = {
  'waiting-for-index': 'Indexing notes...',
  querying: 'Loading places...',
  building: 'Loading places...',
};

export class PlacesCodeBlockProcessor {
  private helpProcessor: PlacesHelpCodeBlockProcessor;
  private overlayService: OverlayService;
  private renderPreparer: PlacesRenderPreparer;

  private async rerenderMapBlock(source: string, container: HTMLElement, ctx: MarkdownPostProcessorContext, trackBuilder?: TrackBuilderConfig): Promise<void> {
    const oldMapContainer = container.querySelector<HTMLElement>('.places-map-container');

    if (oldMapContainer) {
      cleanupMapContainer(oldMapContainer);
    }

    container.empty();

    await this.processMarkdownCodeBlock(source, container, ctx, trackBuilder);
  }

  private async prepareThroughDataChanges(run: () => Promise<PreparedPlacesRender>, guard: RenderStalenessGuard, surface: () => MapSurfaceRenderResult | undefined): Promise<PreparedPlacesRender> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await run();
      } catch (error) {
        const controller = surface()?.controller;

        if (!(error instanceof QueryPreparationCanceled) || guard.superseded || !controller || controller.getState().disposed || attempt >= PREPARE_CANCELLATION_ATTEMPTS) {
          throw error;
        }

        logger.debug('preparation canceled by a data change; preparing again on the same surface', { attempt });
      }
    }
  }

  private renderRefreshableError(el: HTMLElement, source: string, ctx: MarkdownPostProcessorContext, options: Parameters<typeof renderErrorWithHelp>[1], trackBuilder?: TrackBuilderConfig, query?: string): HTMLElement {
    const mapContainer = el.querySelector<HTMLElement>('.places-map-container');

    if (mapContainer) cleanupMapContainer(mapContainer);
    el.empty();
    const errorElement = renderErrorWithHelp(el, options);
    const resolveRefreshInputs = createMapRefreshInputResolver(el, source, ctx);
    const refreshService = MapRefreshService.getInstance();
    const refresh = async (currentSourcePath = ctx.sourcePath): Promise<void> => {
      refreshService.unregisterMap(errorElement);
      const inputs = resolveRefreshInputs(currentSourcePath);

      await this.rerenderMapBlock(inputs.source, el, inputs.ctx, trackBuilder);
    };

    if (query) {
      refreshService.registerMap(errorElement, {
        sourcePath: ctx.sourcePath, query, usesVaultQuery: true, usesDataview: false, refresh,
      });
      ctx.addChild(new class extends MarkdownRenderChild {
        onunload(): void { refreshService.unregisterMap(errorElement); }
      }(errorElement));
    }

    createFloatingRefreshButton({
      ctx,
      buttonContainer: errorElement.createDiv('places-floating-buttons'),
      ariaLabel: 'Refresh Places block',
      progressHost: errorElement,
      onRefresh: () => refresh(),
      onError: error => logger.warn('Places error refresh failed', error),
    });

    return errorElement;
  }

  // Maps render in hover previews for other files while preventing
  // infinite recursion when a map links to its own note.
  private isRecursiveRender(el: HTMLElement, sourcePath: string): boolean {
    const popover = el.closest('.popover.hover-popover');

    if (!popover) return false;

    const escapedPath = CSS.escape(sourcePath);
    const ownerDocument = popover.ownerDocument ?? activeDocument;

    return ownerDocument.querySelector(`.places-map-container[data-source-path="${escapedPath}"]`) !== null;
  }

  constructor(
    private app: App,
    private component: Component,
    private placeDataService: PlaceDataService,
    mapBlockProcessors: ServiceRegistry<IMapBlockProcessor>,
    getProviders: () => readonly PlaceProviderExport[],
    private vaultQueryService: VaultQueryService,
    private trackDataService: TrackDataService,
    routeOverlayGenerator?: RouteOverlayGenerator,
    templateNotes?: TemplateNoteService,
    defaultTemplate?: () => string
  ) {
    this.helpProcessor = new PlacesHelpCodeBlockProcessor(this.app, this.component, mapBlockProcessors, getProviders);
    this.overlayService = new OverlayService(app, id => PlacesPlugin.getOverlayPreset(id));
    this.renderPreparer = new PlacesRenderPreparer(placeDataService, this.overlayService, routeOverlayGenerator, templateNotes, defaultTemplate);
    this.component.register(MapRefreshService.getInstance().onDataChanged(change => this.renderPreparer.invalidateCompleted(change)));
  }

  private readonly awaitedNoteIndex = new WeakSet<HTMLElement>();

  private renderWhenNoteIndexed(el: HTMLElement, source: string, ctx: MarkdownPostProcessorContext, guard: RenderStalenessGuard, trackBuilder?: TrackBuilderConfig): void {
    const { metadataCache, vault, workspace } = this.app;
    const sourcePath = (): string => normalizePath(ctx.sourcePath);
    const noteIndexed = (): boolean => {
      const path = sourcePath();
      const file = vault.getFileByPath(path);

      return (file ? metadataCache.getFileCache(file) : metadataCache.getCache(path)) != null;
    };
    let settled = false;
    const stop = (rerender: boolean): void => {
      if (settled) return;
      settled = true;
      metadataCache.offref(changedRef);
      metadataCache.offref(resolvedRef);
      vault.offref(createRef);
      if (!rerender || guard.superseded) return;
      el.empty();
      void this.processMarkdownCodeBlock(source, el, ctx, trackBuilder);
    };
    const settleWhenIndexed = (): void => {
      if (noteIndexed()) stop(true);
    };
    const changedRef = metadataCache.on('changed', file => {
      if (file.path === sourcePath()) settleWhenIndexed();
    });
    const createRef = vault.on('create', file => {
      if (file.path === sourcePath()) settleWhenIndexed();
    });
    const resolvedRef = metadataCache.on('resolved', () => {
      if (noteIndexed() || workspace.layoutReady) stop(true);
    });

    workspace.onLayoutReady(settleWhenIndexed);
    guard.register(() => stop(false));
  }

  async processMarkdownCodeBlock(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext, trackBuilder?: TrackBuilderConfig): Promise<void> {
    if (ctx?.sourcePath && this.isRecursiveRender(el, ctx.sourcePath)) {
      el.createDiv({
        cls: 'places-popover-placeholder',
        text: '🗺️ Map preview not available (self-reference)'
      });

      return;
    }

    const loading = createLoadingIndicator(el, "Loading places...", { className: "places-map-loading" });
    const stalenessGuard = new RenderStalenessGuard(el, ctx.sourcePath);

    ctx.addChild(stalenessGuard);
    let loadingSurface: MapSurfaceRenderResult | undefined;
    let previewRender: Promise<void> | undefined;
    let loadingProgress: MapLoadingProgress | undefined;
    let phaseText = 'Loading places...';
    let currentPhase: PreparePhase = 'querying';
    let hasInitialView = false;
    let readyPlaces = 0;
    let query: string | undefined;

    try {
      const reportPhase = (phase: PreparePhase): void => {
        currentPhase = phase;
        phaseText = phase !== 'waiting-for-index' && readyPlaces > 0
          ? `Loading places (${readyPlaces.toLocaleString()} ready)...`
          : PREPARE_PHASE_TEXT[phase];
        loading.setText(phaseText);
        loadingProgress?.setPhase(phaseText, phase === 'waiting-for-index');
      };
      const parameterStateKey = QueryParameterState.getStateKey(ctx.sourcePath, ctx.getSectionInfo(el)?.lineStart, source);
      const prepared = await this.prepareThroughDataChanges(() => this.renderPreparer.prepare({
        source,
        ctx,
        mode: 'initial',
        transformBlock: this.createBlockTransform(parameterStateKey, ctx),
        mapConfigOverrides: trackBuilder ? { trackBuilder } : undefined,
        supportsLiveVisibility: name => PlacesPlugin.getMapProvider(name)?.supportsLiveMarkerVisibility === true,
        onPhase: reportPhase,
        vaultQueryReadiness: () => this.vaultQueryService.pendingReadiness(),
        isCanceled: () => stalenessGuard.superseded || loadingSurface?.controller?.getState().disposed === true,
        isPriorityPlace: place => {
          if (!hasInitialView || !loadingSurface) return false;
          const bounds = loadingSurface.provider?.getMapControlHandle?.(loadingSurface.mapContainer)?.getBounds?.();

          return Boolean(bounds?.isValid() && selectViewportTracks(collectViewportTrackCandidates([place]), bounds, {
            worldCopies: loadingSurface.config?.mapProvider !== 'leaflet', isActive: () => false,
          }).desired.length);
        },
        onBatch: async partial => {
          await previewRender;
          const controller = loadingSurface?.controller;

          if (!controller || stalenessGuard.superseded || controller.getState().disposed) return;

          if (controller.storesPlansOnly()) {
            readyPlaces = partial.places.length;
            reportPhase('querying');

            return;
          }

          this.applySelectionActions(partial.places, partial.blockSettings.selectionParameter);
          const runtime = this.createPlanRuntime(partial.resolvedSettings!.config, partial.rawBlockSettings, el, ctx, source, () => stalenessGuard.superseded);
          const terrain = PlacesPlugin.resolveTerrainRuntime(partial.resolvedSettings!.config);
          const plan = createMapRenderPlan({
            ...runtime, dataState: 'loading', places: partial.places, overlays: [],
            config: partial.resolvedSettings!.config, clusteringEnabled: partial.resolvedSettings!.clusteringEnabled,
            camera: resolveCameraIntent(partial.resolvedSettings!.config, runtime.source, { rememberedFit: 'ignore' }),
            terrainDem: terrain.terrainDem, reliefDem: terrain.reliefDem,
            markerVisibilityHiddenIds: partial.liveVisibility?.hiddenIds, popupDebug: partial.popupDebug,
          });

          controller.setPlan(plan, { source: 'places-batch' });
          await controller.reconcile();
          readyPlaces = partial.places.length;
          reportPhase('querying');
        },
        onSettingsReady: settings => {
          query = settings.blockSettings.query;
          if (previewRender || stalenessGuard.superseded || !PlacesPlugin.getMapProvider(settings.providerName)) return;
          const planRuntime = this.createPlanRuntime(settings.resolvedSettings.config, settings.rawBlockSettings, el, ctx, source, () => stalenessGuard.superseded);
          const mapSource = planRuntime.source;
          const terrain = PlacesPlugin.resolveTerrainRuntime(settings.resolvedSettings.config);
          const previewPlan = createMapRenderPlan({
            perf: createPerformanceMonitor('places-preview-plan', { sourcePath: ctx.sourcePath }, { enabled: PlacesPlugin.settings.developerMode }),
            ...planRuntime, dataState: 'loading', places: this.createDefaultViewportMarkers(), overlays: [],
            config: settings.resolvedSettings.config, clusteringEnabled: settings.resolvedSettings.clusteringEnabled,
            camera: resolveCameraIntent(settings.resolvedSettings.config, mapSource),
            terrainDem: terrain.terrainDem, reliefDem: terrain.reliefDem,
          });

          hasInitialView = previewPlan.camera.kind === 'explicit';
          applyBlockWidth(el, settings.resolvedSettings.config.width);
          loading.remove();
          previewRender = renderMapSurface({
            host: el, ctx, places: previewPlan.places, providerName: settings.providerName,
            config: previewPlan.config, renderPlan: previewPlan,
            height: settings.blockSettings.height ?? '', sourcePath: ctx.sourcePath,
            registerCleanup: false,
            onRerenderRequested: () => this.rerenderMapBlock(source, el, ctx, trackBuilder),
            onPlanApplied: plan => {
              if (plan.places.length > 0 || plan.overlays.length > 0) {
                clearEmptyMapHelp(el);
              }
            },
            chrome: { onRefresh: async () => {
              if (!await MapRefreshService.getInstance().refreshContainerNow(el)) {
                const inputs = createMapRefreshInputResolver(el, source, ctx)(ctx.sourcePath);

                await this.rerenderMapBlock(inputs.source, el, inputs.ctx, trackBuilder);
              }
            } },
          }).then(surface => {
            if (stalenessGuard.superseded || !surface.rendered || !surface.controller) {
              cleanupMapContainer(surface.mapContainer);
              surface.mapContainer.remove();

              return;
            }

            loadingSurface = surface;
            ctx.addChild(new MapCleanupRenderChild(el));
            loadingProgress = new MapLoadingProgress(surface.mapContainer, () => settings.blockSettings.query ? this.vaultQueryService.getLoadingProgress() : undefined);
            loadingProgress.setPhase(phaseText, currentPhase === 'waiting-for-index');
            ctx.addChild(loadingProgress);
          }).catch(error => logger.debug('Base map preview unavailable; continuing normal render', error));
        },
      }), stalenessGuard, () => loadingSurface);

      await previewRender;

      if (stalenessGuard.superseded) {
        loading.remove();

        return;
      }

      const { blockSettings, places, asyncOverlayLoad } = prepared;
      const overlays = prepared.initialOverlays;

      if (places.length === 0 && overlays.length === 0 && prepared.sourcesUnreadable === true && !this.awaitedNoteIndex.has(el)) {
        this.awaitedNoteIndex.add(el);
        this.renderWhenNoteIndexed(el, source, ctx, stalenessGuard, trackBuilder);

        return;
      }

      const resolvedConfig = prepared.resolvedSettings!.config;
      const mapTools = PlacesPlugin.getMapTools();
      const collection = collectedPlacesOf(prepared);
      const toolErrors = await this.contributeToolPlaces(resolvedConfig, places, ctx.sourcePath, { validate: true });

      loading.remove();

      const allOverlayErrors = this.collectPreparedErrors(prepared, places, toolErrors);

      if (places.length === 0 && overlays.length === 0 && !asyncOverlayLoad) {
        if (allOverlayErrors.length > 0) {
          const errorContainer = this.renderRefreshableError(el, source, ctx, {
            icon: "⚠️",
            title: "Failed to load map content",
            className: "overlay-error"
          }, trackBuilder);
          const errorList = errorContainer.createEl("ul");

          for (const err of allOverlayErrors) {
            errorList.createEl("li", { text: `[${err.type}] ${err.path}: ${err.error}` });
          }

          return;
        }

        const emptyMapPlaces = this.createDefaultViewportMarkers();

        if (stalenessGuard.superseded) return;
        await this.renderMap(emptyMapPlaces, [], el, blockSettings, prepared.rawBlockSettings, prepared.resolvedSettings!, source, ctx, [], undefined, undefined, trackBuilder, undefined, prepared.prepareTimings, prepared.popupDebug, () => stalenessGuard.superseded, loadingSurface, collection, prepared.isDataStale);
        this.renderDebugTraces(el, source, ctx, prepared);
        const showHelp = shouldShowEmptyMapHelp(
          blockSettings.showHelpWithEmptyMap,
          PlacesPlugin.settings.showHelpWithEmptyMap,
          mapTools.some(factory =>
              factory.suppressEmptyMapHelp === true
              && resolvedConfig.tools[factory.id] !== undefined
              && resolvedConfig.tools[factory.id] !== false)
        );

        if (showHelp) {
          renderEmptyMapHelp(el, host => this.helpProcessor.renderPlaceMethods(host));
        }

        return;
      }

      const renderPlaces = places.length === 0 && asyncOverlayLoad ? this.createDefaultViewportMarkers() : places;

      if (stalenessGuard.superseded) return;

      await this.renderMap(renderPlaces, overlays, el, blockSettings, prepared.rawBlockSettings, prepared.resolvedSettings!, source, ctx, allOverlayErrors, asyncOverlayLoad, prepared.dataFingerprint, trackBuilder, prepared.liveVisibility, prepared.prepareTimings, prepared.popupDebug, () => stalenessGuard.superseded, loadingSurface, collection, prepared.isDataStale);
      this.renderDebugTraces(el, source, ctx, prepared);
    } catch (error) {
      await previewRender;
      loading.remove();
      if (stalenessGuard.superseded) return;

      if (error instanceof QueryPreparationCanceled) {
        if (!loadingSurface?.controller?.getState().disposed) await this.rerenderMapBlock(source, el, ctx, trackBuilder);

        return;
      }

      if (Utilities.isDataviewUnavailableError(error)) {
        this.renderRefreshableError(el, source, ctx, missingQueryPluginError('dataview'), trackBuilder);

        return;
      }

      if (Utilities.isVaultQueryUnavailableError(error)) {
        this.renderRefreshableError(el, source, ctx, missingQueryPluginError('vaultquery'), trackBuilder);

        return;
      }

      if (error instanceof VaultQueryPreparingError) {
        if (loadingSurface) cleanupMapContainer(loadingSurface.mapContainer);
        logger.debug('VaultQuery database preparing; rendering waiting state', {
          sourcePath: ctx.sourcePath,
          message: error.message,
        });
        renderVaultQueryWaitingState(el, source, ctx, (src, container, context) => this.processMarkdownCodeBlock(src, container, context));

        return;
      }

      logger.error('Error processing places code block:', error);

      if (error instanceof BlockSyntaxError) {
        const validKeys = CodeBlockRegistry.instance.getValidKeys('places');
        const unknownKeyNote = error.key && validKeys && !validKeys.has(error.key)
          ? ` "${error.key}" is not a places setting.`
          : '';

        this.renderRefreshableError(el, source, ctx, { icon: "⚠️", title: "Block Syntax Error", message: `${error.message}${unknownKeyNote}` }, trackBuilder);

        return;
      }

      if (error instanceof VaultQueryValidationError) {
        this.renderRefreshableError(el, source, ctx, { icon: "⚠️", title: "Query Error", message: error.message, helpSections: error.helpSections }, trackBuilder, query);

        return;
      }

      if (error instanceof TemplateNotFoundError) {
        this.renderRefreshableError(el, source, ctx, {
          icon: "⚠️",
          title: "Unknown Template",
          message: error.message,
          helpSections: [{
            type: "text",
            title: "A template is a places-template code block. Check that:",
            items: [
              "the name resolves to a note, exactly as a [[link]] to it would",
              "that note contains a places-template block",
              "a #heading reference names the heading the block sits under",
            ],
          }],
        }, trackBuilder);

        return;
      }

      this.renderRefreshableError(el, source, ctx, { icon: "⚠️", title: "Error", message: getErrorMessage(error) }, trackBuilder, query);
    } finally {
      loadingProgress?.remove();
    }
  }

  // Two markers at opposite corners of the NYC metro area produce a bounding box
  // that providers will fitBounds to, giving a city-level view (~zoom 10).
  private createDefaultViewportMarkers(): MapPlace[] {
    return [
      this.createHiddenCenterMarker(40.49, -74.26),  // SW corner (Staten Island)
      this.createHiddenCenterMarker(40.92, -73.70),   // NE corner (Bronx)
    ];
  }

  private createBlockTransform(stateKey: string | null, ctx: MarkdownPostProcessorContext, onErrors?: (errors: string[]) => void, getViewport?: () => MapViewportQueryContext | undefined): (parsedBlock: ParsedCodeBlock) => Promise<BlockParameterTransformResult> {
    const context = createLiveCodeBlockContext(this.app, ctx);

    return parsedBlock => {
      const sourcePath = context.sourcePath;
      const viewport = getViewport?.();
      const transform = createBlockParameterTransform(
        stateKey,
        onErrors,
        definitions => resolveOptionsQueries(definitions, sql => this.vaultQueryService.executeQuery(sql, sourcePath), QueryParameterState.peek(stateKey), sql => resolveMapViewportQuery(sql, viewport)),
        sourcePath,
        () => readNoteProperties(this.app, sourcePath),
      );

      if (typeof parsedBlock.settings.query === 'string') {
        parsedBlock.settings.query = resolveMapViewportQuery(parsedBlock.settings.query, viewport);
      }

      return transform(parsedBlock);
    };
  }

  private createHiddenCenterMarker(lat: number, lng: number): MapPlace {
    return {
      latitude: lat,
      longitude: lng,
      name: '',
      icon: '',
      metadata: { boundsAnchor: true },
      iconStyle: { inlineCss: 'display: none', classes: [], opacity: 0 }
    };
  }

  private async contributeToolPlaces(config: ResolvedMapConfig, places: MapPlace[], sourcePath: string, options: { validate?: boolean } = {}): Promise<MapContentError[]> {
    const errors: MapContentError[] = [];
    const trackLoader = this.createToolTrackLoader();

    for (const factory of PlacesPlugin.getMapTools()) {
      const toolConfig = config.tools[factory.id];

      if (toolConfig === undefined || toolConfig === false) continue;

      if (options.validate && factory.validateToolConfig) {
        try {
          factory.validateToolConfig(toolConfig);
        } catch (error) {
          errors.push({ path: `tools.${factory.id}`, error: getErrorMessage(error), type: 'Tool' });
          continue;
        }
      }

      if (!factory.contributePlaces) continue;

      try {
        const contributed = await factory.contributePlaces({ source: { path: sourcePath }, config, toolConfig, trackLoader });
        const existingPaths = new Set(places.map(place => place.filePath).filter((path): path is string => !!path));

        for (const place of contributed) {
          if (place.filePath && existingPaths.has(place.filePath)) continue;
          places.push(place);
          if (place.filePath) existingPaths.add(place.filePath);
        }
      } catch (error) {
        errors.push({ path: `tools.${factory.id}`, error: getErrorMessage(error), type: 'Tool' });
      }
    }

    return errors;
  }

  private createToolTrackLoader(): MapTrackLoader {
    return {
      loadTrackFromPath: (pathSetting, sourcePath, options) => this.trackDataService.loadTrackFromPath(pathSetting, sourcePath, options),
      loadTrackPlaceFromPath: (pathSetting, sourcePath) => Promise.resolve(this.placeDataService.loadTrackPlaceFromPath(pathSetting, sourcePath)),
    };
  }

  private createPlanRuntime(blockSettings: ResolvedMapConfig, rawBlockSettings: Record<string, unknown>, container: HTMLElement, ctx: MarkdownPostProcessorContext, source: string, isStale?: () => boolean) {
    const lineStart = ctx.getSectionInfo(container)?.lineStart;
    const blockStateKey = QueryParameterState.getStateKey(ctx.sourcePath, lineStart, source);
    const inspectionService = new TrackInspectionService(() => PlacesPlugin.settings, blockSettings.trackSpeedWindow);

    return {
      surfaceKind: 'places-block' as const,
      source: { get path() { return ctx.sourcePath; }, lineStart },
      onPlaceAction: this.createPlaceActionHandler({ selectionParameter: blockSettings.selectionParameter?.trim(), rawBlockSettings, get sourcePath() { return ctx.sourcePath; }, blockStateKey, container }),
      placeNoteHost: PlacesPlugin.placeNoteHost,
      reverseGeocodeHost: PlacesPlugin.reverseGeocodeHost,
      inspectTrack: (place: MapPlace, coordinate: Coordinate, signal?: AbortSignal) => inspectionService.inspect(place, coordinate, ctx.sourcePath, signal),
      contextMenuActions: this.createLocationParameterActions(rawBlockSettings, ctx, blockStateKey, container),
      trackLoader: this.createToolTrackLoader(),
      mapTools: PlacesPlugin.getMapTools(),
      popupRenderers: PlacesPlugin.getPopupRenderers(),
      isStale,
    };
  }

  private collectPreparedErrors(prepared: PreparedPlacesRender, places: readonly MapPlace[], extra: readonly MapContentError[]): MapContentError[] {
    return [
      ...(prepared.labelTemplateResult?.errors || []).map(e => ({ path: e.filePath || e.placeName, error: e.message, type: 'Label Template' })),
      ...(prepared.resolvedSettings?.warnings || []).map(w => ({ path: w.path, error: w.message, type: 'Configuration' })),
      ...(prepared.parameterErrors ?? []).map(error => ({ path: 'queryParameters', error, type: 'Query Parameter' })),
      ...(prepared.queryErrors ?? []).map(error => ({ ...error, type: 'Query' })),
      ...(prepared.overlayErrors ?? []),
      ...this.collectStoredOverlayErrors(places),
      ...extra,
    ];
  }

  private async renderMap(
    places: MapPlace[],
    overlays: Overlay[],
    container: HTMLElement,
    blockSettings: MapBlockSettings,
    rawBlockSettings: Record<string, unknown>,
    builtPreviewSettings: ResolvedMapSettings,
    source: string,
    ctx: MarkdownPostProcessorContext,
    overlayErrors: MapContentError[] = [],
    asyncOverlayLoad?: AsyncOverlayLoad,
    initialDataFingerprint?: string,
    trackBuilder?: TrackBuilderConfig,
    liveVisibility?: { hiddenIds: string[] },
    prepareTimings?: MapPrepareTimings,
    popupDebug?: PreparedPlacesRender['popupDebug'],
    isStale?: () => boolean,
    loadingSurface?: MapSurfaceRenderResult,
    initialCollection?: CollectedPlaces,
    isDataStale?: () => boolean,
  ): Promise<void> {
    let lastDataFingerprint = initialDataFingerprint;
    let lastCollection = initialCollection;
    let awaitingInitialData = places.every(isNonInteractivePlace) && overlays.length === 0;
    const providerName = PlacesPlugin.resolveMapProvider(blockSettings.mapProvider);

    applyBlockWidth(container, builtPreviewSettings.config.width);

    const sectionInfo = ctx.getSectionInfo(container);
    const mapSource = { get path() { return ctx.sourcePath; }, lineStart: sectionInfo?.lineStart };
    const blockStateKey = QueryParameterState.getStateKey(ctx.sourcePath, sectionInfo?.lineStart, source);
    const registeredToolIds = new Set(PlacesPlugin.getMapTools().map(tool => tool.id));

    for (const toolId of Object.keys(builtPreviewSettings.config.tools)) {
      if (!registeredToolIds.has(toolId)) {
        overlayErrors.push({ path: `tools.${toolId}`, error: `No installed extension registered the "${toolId}" map tool.`, type: 'Tool' });
      }
    }

    const selectionParameter = blockSettings.selectionParameter?.trim();
    const selectionPointParameter = blockSettings.selectionPointParameter?.trim();
    const selectionChannel = blockSettings.selectionChannel?.trim() || 'primary';

    {
      const selectionLifecycle = new MarkdownRenderChild(container);

      selectionLifecycle.register(onMapTrackSelection(container, selection => {
        PlacesPlugin.publishSelection(ctx.sourcePath, {
          kind: selection.coordinate ? 'track-point' : (hasTrackData(selection.place) ? 'track' : 'place'),
          id: selection.place.filePath ?? selection.place.name,
          label: selection.place.name,
          path: selection.place.filePath,
          coordinate: selection.coordinate ? { ...selection.coordinate } : undefined,
          data: { origin: blockStateKey ?? 'map' },
        }, selectionChannel);

        if (selectionParameter && selection.intent === 'commit') {
          this.setParameterFromMap(selectionParameter, selection.place.filePath ?? selection.place.name, rawBlockSettings, ctx.sourcePath, blockStateKey, container);
        }

        if (selectionPointParameter && selection.coordinate) {
          container.dispatchEvent(new CustomEvent(TRACK_PLAYBACK_POSITION_EVENT, {
            detail: {
              trackPath: selection.place.filePath,
              latitude: selection.coordinate.latitude,
              longitude: selection.coordinate.longitude,
            },
            bubbles: true,
          }));
        }
      }));

      if (selectionPointParameter) {
        const onTrackPosition = (event: Event): void => {
          const detail = (event as CustomEvent<{ latitude?: number; longitude?: number }>).detail;

          if (!detail || detail.latitude === undefined || detail.longitude === undefined) return;
          this.setParameterFromMap(
            selectionPointParameter,
            `${detail.latitude}, ${detail.longitude}`,
            rawBlockSettings,
            ctx.sourcePath,
            blockStateKey,
            container,
            false,
          );
        };

        container.addEventListener(TRACK_PLAYBACK_POSITION_EVENT, onTrackPosition);
        selectionLifecycle.register(() => container.removeEventListener(TRACK_PLAYBACK_POSITION_EVENT, onTrackPosition));
      }

      selectionLifecycle.register(PlacesPlugin.subscribeSelection(ctx.sourcePath, selection => {
        if (selection?.kind !== 'track-point' || !selection.coordinate || selection.data?.origin === (blockStateKey ?? 'map')) return;
        const place = places.find(candidate => candidate.filePath === selection.path)
          ?? (places.length === 1 ? places[0] : undefined);

        if (!place) return;
        const mapContainer = container.querySelector<HTMLElement>('.places-map-container');

        mapContainer?.dispatchEvent(new CustomEvent(TRACK_POSITION_REQUEST_EVENT, {
          detail: {
            trackPath: place.filePath,
            latitude: selection.coordinate.latitude,
            longitude: selection.coordinate.longitude,
          },
        }));
        mapContainer?.dispatchEvent(new CustomEvent(TRACK_INSPECTION_REQUEST_EVENT, {
          detail: {
            trackPath: place.filePath,
            latitude: selection.coordinate.latitude,
            longitude: selection.coordinate.longitude,
          },
        }));
      }, selectionChannel));
      ctx.addChild(selectionLifecycle);
    }

    this.applySelectionActions(places, blockSettings.selectionParameter);

    const buildPlan = (input: {
      places: MapPlace[];
      overlays: Overlay[];
      resolvedSettings: ResolvedMapSettings;
      camera: MapCameraIntent;
      liveVisibility?: { hiddenIds: string[] };
      popupDebug?: PreparedPlacesRender['popupDebug'];
      prepareTimings?: MapPrepareTimings;
    }) => {
      const terrain = PlacesPlugin.resolveTerrainRuntime(input.resolvedSettings.config);
      const plan = createMapRenderPlan({
        perf: createPerformanceMonitor('places-plan', { sourcePath: ctx.sourcePath, places: input.places.length }, { enabled: PlacesPlugin.settings.developerMode }),
        ...this.createPlanRuntime(input.resolvedSettings.config, rawBlockSettings, container, ctx, source, isStale),
        places: input.places,
        overlays: input.overlays,
        config: input.resolvedSettings.config,
        clusteringEnabled: input.resolvedSettings.clusteringEnabled,
        camera: input.camera,
        terrainDem: terrain.terrainDem,
        reliefDem: terrain.reliefDem,
        markerVisibilityHiddenIds: input.liveVisibility?.hiddenIds,
        popupDebug: input.popupDebug,
        prepareTimings: input.prepareTimings,
      });

      return {
        plan,
        errors: [
          ...terrain.errors.map(e => ({ ...e, type: 'Terrain' })),
          ...plan.errors.map(e => ({ ...e, type: 'Overlay' })),
        ],
      };
    };

    const planPerf = createPerformanceMonitor('places-block-plan', { sourcePath: ctx.sourcePath, places: places.length }, { enabled: PlacesPlugin.settings.developerMode });
    const built = planPerf.measure('build-plan', () => buildPlan({
      places, overlays, resolvedSettings: builtPreviewSettings,
      camera: resolveCameraIntent(builtPreviewSettings.config, mapSource, { rememberedFit: 'ignore' }),
      liveVisibility, popupDebug, prepareTimings,
    }));
    const renderPlan = built.plan;

    overlayErrors.push(...built.errors);

    const rerenderMap = async (): Promise<void> => {
      await this.rerenderMapBlock(source, container, ctx, trackBuilder);
    };

    const surface = loadingSurface ?? await renderMapSurface({
      host: container,
      places: renderPlan.places,
      providerName,
      ctx,
      config: renderPlan.config,
      clusteringEnabled: renderPlan.clusteringEnabled,
      height: blockSettings.height ?? '',
      sourcePath: ctx.sourcePath,
      registerCleanup: false,
      renderPlan,
      onRerenderRequested: rerenderMap,
      onPlanApplied: plan => {
        if (plan.places.length > 0 || plan.overlays.length > 0) {
          clearEmptyMapHelp(container);
        }
      },
      chrome: { onRefresh: () => MapRefreshService.getInstance().refreshContainerNow(container) },
    });

    if (!surface.rendered || !surface.provider || !surface.config || !surface.controller) {
      return;
    }

    if (loadingSurface) {
      surface.controller.setPlan(renderPlan, { source: 'places-ready' });
      await surface.controller.reconcile();
      if (surface.controller.getState().disposed) return;
      surface.config = renderPlan.config;
      surface.clusteringEnabled = renderPlan.clusteringEnabled;
    }

    if (selectionPointParameter) {
      const value = this.getParameterValue(selectionPointParameter, rawBlockSettings, ctx.sourcePath, blockStateKey);
      const coordinate = typeof value === 'string' ? parseNamedCoordinate(value) : undefined;

      if (coordinate) {
        surface.mapContainer.dispatchEvent(new CustomEvent(TRACK_POSITION_REQUEST_EVENT, {
          detail: { latitude: coordinate.latitude, longitude: coordinate.longitude },
        }));
        const selectedTrack = renderPlan.places.find(place => place.filePath) ?? renderPlan.places[0];

        if (selectedTrack) {
          surface.mapContainer.dispatchEvent(new CustomEvent(TRACK_INSPECTION_REQUEST_EVENT, {
            detail: {
              trackPath: selectedTrack.filePath,
              latitude: coordinate.latitude,
              longitude: coordinate.longitude,
            },
          }));
        }
      }
    }

    const mapContainer = surface.mapContainer;
    const mapProvider = surface.provider;
    const controller = surface.controller;

    if (!loadingSurface) ctx.addChild(new MapCleanupRenderChild(container));

    if (asyncOverlayLoad) {
      const progress = createOverlayLoadProgress(container);

      void asyncOverlayLoad.promise
        .then(async overlayResult => {
          progress.remove();
          renderMapContentErrors(container, overlayResult.errors, 'places-async-overlay-error');

          if (overlayResult.overlays.length === 0) {
            return;
          }

          const next = buildPlan({
            places, overlays: overlayResult.overlays, resolvedSettings: builtPreviewSettings,
            camera: renderPlan.camera, liveVisibility, popupDebug,
          });

          renderMapContentErrors(container, next.errors, 'places-async-overlay-plan-error');
          controller.setPlan(next.plan, { source: 'async-overlays' });
          await controller.reconcile();
          if (controller.getState().fittedBoundsSignature === next.plan.boundsSignature) awaitingInitialData = false;
        })
        .catch(error => {
          progress.remove();
          logger.error('Async overlay loading failed', error);
          renderMapContentErrors(container, [{
            path: 'overlays',
            error: getErrorMessage(error),
            type: 'Overlay'
          }], 'places-async-overlay-error');
        });
    }

    const usesVaultQuery = !!blockSettings.query;
    const usesDataview = !!blockSettings.dataview;
    const usesSelfReferencingPlaceholders = !!blockSettings.query && /\{this\./i.test(blockSettings.query || '');
    const linkedPlaceDependencies = this.resolveLinkedPlaceDependencyPaths(blockSettings.places, ctx.sourcePath);

    const refreshService = MapRefreshService.getInstance();
    const resolveRefreshInputs = createMapRefreshInputResolver(container, source, ctx, sectionInfo?.lineStart);
    const refreshTransformBlock = this.createBlockTransform(blockStateKey, ctx,
      errors => logger.warn('Query parameter errors during refresh', errors),
      () => readMapViewport(mapProvider.getMapControlHandle?.(mapContainer)));

    refreshService.registerMap(container, {
      sourcePath: ctx.sourcePath,
      usesVaultQuery,
      query: blockSettings.query,
      usesDataview,
      usesSelfReferencingPlaceholders,
      dependencyPaths: linkedPlaceDependencies,
      refresh: async (currentSourcePath, refreshOptions) => {
        const el = container;
        const { source: src, ctx: context } = resolveRefreshInputs(currentSourcePath);
        const refreshPerf = createPerformanceMonitor('places-block-refresh', { manual: Boolean(refreshOptions?.manual) }, { enabled: PlacesPlugin.settings.developerMode });

        if (refreshOptions?.manual) {
          this.placeDataService.invalidateQueryCache();
        }

        const prepared = await refreshPerf.measureAsync(
          'prepare',
          () => this.renderPreparer.prepare({
            source: src,
            ctx: context,
            mode: 'refresh',
            bypassOverlayCache: refreshOptions?.manual,
            transformBlock: refreshTransformBlock,
            previousDataFingerprint: lastDataFingerprint,
            collectionReuse: refreshOptions?.parameters ? lastCollection : undefined,
            mapConfigOverrides: trackBuilder ? { trackBuilder } : undefined,
            supportsLiveVisibility: name => PlacesPlugin.getMapProvider(name)?.supportsLiveMarkerVisibility === true,
          }),
          undefined,
          { thresholdMs: REFRESH_WARNING_THRESHOLD_MS, warnOnSlow: true },
        );

        this.renderDebugTraces(el, src, context, prepared);

        if (prepared.unchangedData) {
          if (prepared.liveVisibility) {
            liveVisibility = prepared.liveVisibility;
            controller.setMarkerVisibility(prepared.liveVisibility.hiddenIds);

            await controller.reconcile();
          }

          refreshPerf.mark('data-unchanged-skip', { places: prepared.places.length });
          logger.debug('map refresh skipped - collected data unchanged', { sourcePath: context.sourcePath, places: prepared.places.length });

          return;
        }

        lastCollection = collectedPlacesOf(prepared);
        const refreshToolErrors = await this.contributeToolPlaces(prepared.resolvedSettings!.config, prepared.places, context.sourcePath);

        lastDataFingerprint = prepared.dataFingerprint;
        const newBlockSettings = prepared.blockSettings;

        refreshService.updateMapDependencies(el, this.resolveLinkedPlaceDependencyPaths(newBlockSettings.places, context.sourcePath));
        const newPlaces = prepared.places;
        const nextProviderName = PlacesPlugin.resolveMapProvider(newBlockSettings.mapProvider);

        logger.debug('map refresh callback started', {
          sourcePath: context.sourcePath,
          hasQuery: Boolean(newBlockSettings.query),
          hasDataview: Boolean(newBlockSettings.dataview),
          hasOverlays: Boolean(prepared.rawBlockSettings.overlays),
          hasDirections: Boolean(newBlockSettings.directions),
          hasIsochrones: Boolean(newBlockSettings.isochrones),
          hasPlaces: newBlockSettings.places !== undefined,
        });

        if (nextProviderName !== providerName) {
          logger.debug('map refresh requires full render', {
            reason: 'provider changed',
            previousProvider: providerName,
            nextProvider: nextProviderName
          });
          await this.rerenderMapBlock(src, el, context, trackBuilder);

          return;
        }

        const refreshOverlays = prepared.initialOverlays;

        logger.debug('map refresh state prepared', {
          sourcePath: context.sourcePath,
          places: newPlaces.length,
          overlays: refreshOverlays.length,
        });

        const mapContainerEl = el.querySelector<HTMLElement>('.places-map-container');
        const mapController = mapContainerEl ? getMapSurfaceController(mapContainerEl) : undefined;

        if (!mapController) {
          await this.rerenderMapBlock(src, el, context, trackBuilder);

          return;
        }

        this.applySelectionActions(newPlaces, newBlockSettings.selectionParameter);
        const next = refreshPerf.measure('build-plan', () => buildPlan({
          places: newPlaces, overlays: refreshOverlays, resolvedSettings: prepared.resolvedSettings!,
          camera: awaitingInitialData
            ? resolveCameraIntent(prepared.resolvedSettings!.config, mapSource, { rememberedFit: 'ignore' })
            : { kind: 'preserve' },
          liveVisibility: prepared.liveVisibility, popupDebug: prepared.popupDebug,
        }), { places: newPlaces.length });

        for (const className of ['places-initial-overlay-error', 'places-async-overlay-plan-error']) {
          renderMapContentErrors(el, [], className);
        }

        renderMapContentErrors(el, this.collectPreparedErrors(prepared, newPlaces, [...refreshToolErrors, ...next.errors]), 'places-async-overlay-error');

        mapController.setPlan(next.plan, { source: 'refresh' });
        await refreshPerf.measureAsync(
          'provider-update',
          () => mapController.reconcile(),
          { places: next.plan.places.length },
          { thresholdMs: REFRESH_WARNING_THRESHOLD_MS, warnOnSlow: true },
        );

        if (mapController.getState().appliedPlanSignature === next.plan.signature
          && (next.plan.camera.kind !== 'fit-data' || mapController.getState().fittedBoundsSignature === next.plan.boundsSignature)
          && (newPlaces.some(place => !isNonInteractivePlace(place)) || refreshOverlays.length > 0)) {
          awaitingInitialData = false;
        }
      },
    });

    this.publishViewportParameters(blockSettings.viewportParameter?.trim(), mapProvider, mapContainer, ctx, container);
    await this.renderQueryParameterStrip(container, mapContainer, mapProvider, rawBlockSettings, source, ctx);

    renderMapContentErrors(container, overlayErrors, 'places-initial-overlay-error');

    if (!isStale?.() && isDataStale?.()) {
      logger.debug('map snapshot completed with newer data available; queuing refresh', { sourcePath: ctx.sourcePath });
      refreshService.queueContainerRefresh(container);
    }
  }

  private collectStoredOverlayErrors(places: readonly MapPlace[]): Array<{ path: string; error: string; type: string }> {
    return places.flatMap(place => {
      const errors = place.metadata?._overlayLoadErrors;

      return Array.isArray(errors)
        ? errors.map(error => ({ path: place.filePath ?? place.name, error: String(error), type: 'Stored Overlay' }))
        : [];
    });
  }

  private createPlaceActionHandler(parameterContext?: { selectionParameter?: string; rawBlockSettings: Record<string, unknown>; sourcePath: string; blockStateKey: string | null; container: HTMLElement }): (place: MapPlace, actionId: string) => void {
    return (place, actionId) => {
      handleSearchResultAction(place, actionId, parameterContext?.sourcePath);

      if (actionId === SET_SELECTION_ACTION_ID && parameterContext) {
        dispatchMapTrackSelection(parameterContext.container, { place, intent: 'commit', source: 'popup-action' });
      }
    };
  }

  private resolveLinkedPlaceDependencyPaths(places: readonly PlaceSource[] | undefined, sourcePath: string): string[] {
    const paths: string[] = [];
    const seen = new Set<string>();

    for (const path of placeSourcePaths(places)) {
      const file = this.app.metadataCache.getFirstLinkpathDest(resolveCurrentSourcePath(path), resolveCurrentSourcePath(sourcePath));

      if (!file || seen.has(file.path)) {
        continue;
      }

      seen.add(file.path);
      paths.push(file.path);
    }

    return paths;
  }

  private renderDebugTraces(container: HTMLElement, source: string, ctx: MarkdownPostProcessorContext, prepared: PreparedPlacesRender): void {
    const resolved = prepared.resolvedSettings;
    const debugSettings = parseDebugModes(prepared.rawBlockSettings.debug).settings;

    if (resolved || !debugSettings) container.querySelector('.places-settings-trace')?.remove();

    if (resolved && debugSettings) {
      const trace = buildSettingsTrace([...resolved.layers], { ...resolved.config }, {
        notes: { ...resolved.traceNotes },
        ignored: CodeBlockRegistry.instance.getIgnoredSettings('places', prepared.rawBlockSettings),
      });

      renderSettingsTraceView(container, trace, 'Settings resolution (places block)');
    }

    if (!prepared.parameterDebug) {
      removeParameterDebugPanel(container);

      return;
    }

    const { definitions } = parseQueryParameterDefinitions(prepared.rawBlockSettings.queryParameters);
    const stateKey = QueryParameterState.getStateKey(ctx.sourcePath, ctx.getSectionInfo(container)?.lineStart, source);
    const values = QueryParameterState.reconcile(stateKey, definitions);

    renderParameterDebugPanel(container, { definitions, values, trace: prepared.parameterDebug });
  }

  private async renderQueryParameterStrip(container: HTMLElement, mapContainer: HTMLElement, mapProvider: IMapBlockProcessor, rawBlockSettings: Record<string, unknown>, source: string, ctx: MarkdownPostProcessorContext): Promise<void> {
    const { definitions } = parseQueryParameterDefinitions(rawBlockSettings.queryParameters);
    const usesViewport = queryUsesMapViewport(source);

    if (definitions.length === 0 && !usesViewport) {
      return;
    }

    const handle = mapProvider.getMapControlHandle?.(mapContainer);

    await renderParameterStrip({
      app: this.app,
      container,
      anchor: mapContainer,
      definitions,
      stateKey: QueryParameterState.getStateKey(ctx.sourcePath, ctx.getSectionInfo(container)?.lineStart, source),
      position: normalizeQueryParameterPosition(rawBlockSettings.queryParametersPosition),
      layout: normalizeQueryParameterLayout(rawBlockSettings.queryParametersLayout),
      collapsed: parseBooleanOptional(rawBlockSettings.queryParametersCollapsed),
      runQuery: sql => this.vaultQueryService.executeQuery(sql, ctx.sourcePath),
      prepareQuery: sql => resolveMapViewportQuery(sql, readMapViewport(handle)),
      subscribeQueryContext: usesViewport && handle?.onBoundsChanged
        ? listener => subscribeMapViewportQuery(source, handle, listener)
        : undefined,
      onValuesApplied: () => { void MapRefreshService.getInstance().refreshContainerNow(container, { parameters: true }); },
      applyDebounceMs: 40,
      addChild: child => ctx.addChild(child),
    });
  }

  // A `track.selection.trackParameter` block turns every place popup into a parameter
  // source: the Select action stores the place's path (name for embedded
  // places) under the named parameter and re-renders whatever consumes it.
  private applySelectionActions(places: MapPlace[], selectionParameter: string | undefined): void {
    if (!selectionParameter?.trim()) return;

    for (const place of places) {
      if (place.actions?.some(action => action.id === SET_SELECTION_ACTION_ID)) continue;
      place.actions = [...(place.actions ?? []), { id: SET_SELECTION_ACTION_ID, label: hasTrackData(place) ? '📌 Select this track' : '📌 Select this place' }];
    }
  }

  private publishViewportParameters(baseName: string | undefined, mapProvider: IMapBlockProcessor, mapContainer: HTMLElement, ctx: MarkdownPostProcessorContext, container: HTMLElement): void {
    if (!baseName || !ctx.sourcePath) return;
    const handle = mapProvider.getMapControlHandle?.(mapContainer);

    if (!handle) return;

    const sourcePath = ctx.sourcePath;
    const lineStart = ctx.getSectionInfo(container)?.lineStart ?? 0;
    const names = viewportParameterNames(baseName);
    const noteKey = NoteParameterRegistry.noteStateKey(sourcePath);
    let published: string | null = null;

    const publish = (): void => {
      const view = readMapViewport(handle);
      const values = viewportParameterValues(names, view);

      if (!values) return;
      const signature = JSON.stringify(values);

      if (signature === published) return;
      published = signature;
      for (const [name, value] of Object.entries(values)) applyExternalParameterValue(noteKey, name, value);
      MapRefreshService.getInstance().refreshParameterConsumers(sourcePath);
    };

    const token = NoteParameterRegistry.register(sourcePath, lineStart, viewportParameterDeclarations(names));
    const lifecycle = new MarkdownRenderChild(container);

    lifecycle.register(() => NoteParameterRegistry.unregister(sourcePath, lineStart, token));
    if (handle.onBoundsChanged) lifecycle.register(handle.onBoundsChanged(publish));
    ctx.addChild(lifecycle);
    publish();
  }

  private setParameterFromMap(name: string, value: string, rawBlockSettings: Record<string, unknown>, sourcePath: string, blockStateKey: string | null, container: HTMLElement, refresh = true): void {
    const local = parseQueryParameterDefinitions(rawBlockSettings.queryParameters).definitions.some(definition => definition.name === name);

    if (!local && NoteParameterRegistry.definitionsFor(sourcePath).some(definition => definition.name === name)) {
      applyExternalParameterValue(NoteParameterRegistry.noteStateKey(sourcePath), name, value);
      if (refresh) MapRefreshService.getInstance().refreshParameterConsumers(sourcePath);

      return;
    }

    applyExternalParameterValue(blockStateKey, name, value);
    if (refresh) void MapRefreshService.getInstance().refreshContainerNow(container, {});
  }

  private getParameterValue(name: string, rawBlockSettings: Record<string, unknown>, sourcePath: string, blockStateKey: string | null): unknown {
    const local = parseQueryParameterDefinitions(rawBlockSettings.queryParameters).definitions.some(definition => definition.name === name);
    const stateKey = local ? blockStateKey : NoteParameterRegistry.noteStateKey(sourcePath);

    return QueryParameterState.peek(stateKey)?.[name];
  }

  private createLocationParameterActions(rawBlockSettings: Record<string, unknown>, ctx: MarkdownPostProcessorContext, blockStateKey: string | null, container: HTMLElement): MapContextAction[] {
    const local = parseQueryParameterDefinitions(rawBlockSettings.queryParameters).definitions;
    const localNames = new Set(local.map(definition => definition.name));
    const note = NoteParameterRegistry.definitionsFor(ctx.sourcePath).filter(definition => !localNames.has(definition.name));

    return [...local, ...note]
      .filter(definition => definition.type === 'location')
      .map(definition => ({
        text: `Set ${definition.label} here`,
        icon: '📍',
        onClick: (coordinate?: Coordinate) => {
          if (!coordinate) return;
          const value = `${roundTo(coordinate.latitude, 5)}, ${roundTo(coordinate.longitude, 5)}`;

          this.setParameterFromMap(definition.name, value, rawBlockSettings, ctx.sourcePath, blockStateKey, container);
        },
      }));
  }
}
