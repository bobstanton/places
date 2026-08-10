import { logger, createPerformanceMonitor } from "places-shared/utils";
import { MarkdownPostProcessorContext, MarkdownRenderChild, App, Component, Notice } from "obsidian";
import { Place, hasTrackData } from "places-shared/place";
import { Meters } from "places-shared/units";
import { Coordinate, parseNamedCoordinate } from "places-shared/geo";
import { getLegendPosition, createGradeLegend, createElevationLegend, getElevationRange } from "../ui/ColorLegend";
import { MapPlace, Overlay } from "places-shared/overlay";
import { setMapRecoveryState, cleanupMapProviderStates, hasActiveMapProviderState, dispatchMapTrackSelection, onMapTrackSelection, TRACK_INSPECTION_REQUEST_EVENT, TRACK_PLAYBACK_POSITION_EVENT, TRACK_POSITION_REQUEST_EVENT } from "places-shared/map";
import { createMapRenderPlan, resolveCameraIntent } from "places-shared/render";
import { MapContextAction, MapBlockSettings, buildSettingsTrace, parseBooleanOptional, type MapPrepareTimings, type TrackBuilderConfig } from "places-shared/settings";
import { IMapBlockProcessor, IPlacesService, type PlaceProviderExport } from "places-shared/services";
import { ServiceRegistry } from "../services/ServiceRegistry";
import { parseQueryParameterDefinitions, resolveOptionsQueries } from "../services/QueryParameters";
import { normalizeQueryParameterLayout, normalizeQueryParameterPosition } from "../ui/QueryParameterControls";
import { applyExternalParameterValue, renderParameterStrip } from "../ui/ParameterStrip";
import { Utilities, renderError, renderErrorWithHelp, getErrorMessage, roundTo } from "places-shared/utils";
import PlacesPlugin from "../main";
import { PlaceDataService } from "../services/PlaceDataService";
import { PlacesHelpCodeBlockProcessor } from "./PlacesHelpCodeBlockProcessor";
import { OverlayService } from "../services/OverlayService";
import { MapRefreshService } from "../services/MapRefreshService";
import { createMapRefreshInputResolver } from "./MapRefreshInputs";
import { MapCleanupRenderChild } from "./MapCleanupRenderChild";
import { RenderStalenessGuard } from "places-shared/ui";
import { renderVaultQueryWaitingState } from "./VaultQueryWaitingState";
import { VaultQueryPreparingError, VaultQueryService, VaultQueryValidationError } from "../services/VaultQueryService";
import { getMapSurfaceController } from "../services/MapSurfaceControllers";
import { RouteOverlayGenerator } from "../services/RouteOverlayGenerator";
import { type ResolvedMapSettings } from "../services/MapSettingsResolver";
import { createFloatingButtonContainer, createGeocodingSearchButton, createMarkerSearchButton, createMarkerSearchToggle, CREATE_NOTE_ACTION_ID, type GeocodingSearchButtonHandle } from "../services/MapFloatingControls";
import { createFloatingRefreshButton, createLoadingIndicator, renderSettingsTraceView } from "places-shared/ui";
import { cleanupMapContainer } from "../services/MapSurfaceCleanup";
import { renderMapSurface } from "../services/MapSurfaceRenderer";
import { AsyncOverlayLoad, PlacesRenderPreparer, TemplateNotFoundError, parseDebugModes, type PreparePhase, type PreparedPlacesRender } from "../services/PlacesRenderPreparer";
import { removeParameterDebugPanel, renderParameterDebugPanel } from "../ui/ParameterDebugView";
import type { TemplateNoteService } from "../services/TemplateNoteService";
import { TrackInspectionService } from "../services/TrackInspectionService";
import { parseLinkedPlaceReferences } from "../services/LinkedPlaces";
import { BlockSyntaxError, ParsedCodeBlock } from "../services/CodeBlockParser";
import { CodeBlockRegistry } from "../services/CodeBlockRegistry";
import { NoteParameterRegistry, QueryParameterState, createBlockParameterTransform } from "../services/QueryParameterState";
import { readNoteProperties } from "../services/NoteProperties";
import { TrackDataService } from "../services/TrackDataService";
import { shouldShowEmptyMapHelp } from "./EmptyMapHelp";
import { missingQueryPluginError } from "../services/MissingPluginError";

function omitMapOverlaySettings(settings: Record<string, unknown>): Record<string, unknown> {
  const settingsWithoutOverlays = { ...settings };
  delete settingsWithoutOverlays.overlays;
  delete settingsWithoutOverlays.heatmapLayer;
  delete settingsWithoutOverlays.heatmapColorScheme;
  return settingsWithoutOverlays;
}

// Per-place action id for storing the place under the block's selectionParameter.
const SET_SELECTION_ACTION_ID = 'set-selection-parameter';

// What the loading indicator says during each wait.
const PREPARE_PHASE_TEXT: Record<PreparePhase, string> = {
  'waiting-for-index': 'Waiting for VaultQuery to finish starting...',
  querying: 'Running query...',
  building: 'Building markers...',
};

export class PlacesCodeBlockProcessor {
  private helpProcessor: PlacesHelpCodeBlockProcessor;
  private overlayService: OverlayService;
  private renderPreparer: PlacesRenderPreparer;

  public static cleanupMapContainer(mapContainer: HTMLElement): void {
    cleanupMapContainer(mapContainer);
  }

  private async rerenderMapBlock(
    source: string,
    container: HTMLElement,
    ctx: MarkdownPostProcessorContext,
    trackBuilder?: TrackBuilderConfig,
  ): Promise<void> {
    const oldMapContainer = container.querySelector<HTMLElement>('.places-map-container');
    if (oldMapContainer) {
      PlacesCodeBlockProcessor.cleanupMapContainer(oldMapContainer);
    }

    container.empty();
    await this.processMarkdownCodeBlock(source, container, ctx, trackBuilder);
  }

  private clearEmptyMapHelp(container: HTMLElement): void {
    for (const element of container.querySelectorAll('.places-no-places-error, .places-method, .places-help-reference')) {
      element.remove();
    }

    for (const paragraph of container.querySelectorAll('p')) {
      if (paragraph.textContent === 'To display Places on the map, use any of these methods:') {
        paragraph.remove();
      }
    }
  }

  private renderRefreshableError(
    el: HTMLElement,
    source: string,
    ctx: MarkdownPostProcessorContext,
    options: Parameters<typeof renderErrorWithHelp>[1],
    trackBuilder?: TrackBuilderConfig,
  ): HTMLElement {
    const errorElement = renderErrorWithHelp(el, options);
    const resolveRefreshInputs = createMapRefreshInputResolver(el, source, ctx);

    createFloatingRefreshButton({
      buttonContainer: errorElement.createDiv('places-floating-buttons'),
      ariaLabel: 'Refresh Places block',
      progressHost: errorElement,
      onRefresh: async () => {
        const inputs = resolveRefreshInputs(ctx.sourcePath);
        await this.rerenderMapBlock(inputs.source, el, inputs.ctx, trackBuilder);
      },
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
    private placesService: IPlacesService | null,
    getProviders: () => readonly PlaceProviderExport[],
    private vaultQueryService: VaultQueryService,
    private trackDataService: TrackDataService,
    routeOverlayGenerator?: RouteOverlayGenerator,
    templateNotes?: TemplateNoteService
  ) {
    this.helpProcessor = new PlacesHelpCodeBlockProcessor(this.app, this.component, mapBlockProcessors, getProviders);
    this.overlayService = new OverlayService(app);
    this.renderPreparer = new PlacesRenderPreparer(placeDataService, this.overlayService, routeOverlayGenerator, templateNotes);
    // Any signal that would refresh a live map also makes a settled prepare stale.
    this.component.register(MapRefreshService.getInstance().onDataChanged(() => this.renderPreparer.invalidateCompleted()));
  }

  async processMarkdownCodeBlock(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext, trackBuilder?: TrackBuilderConfig): Promise<void> {
    if (ctx?.sourcePath && this.isRecursiveRender(el, ctx.sourcePath)) {
      el.createDiv({
        cls: 'places-popover-placeholder',
        text: '🗺️ Map preview not available (self-reference)'
      });
      return;
    }

    const loading = createLoadingIndicator(el, "Loading places data...");
    const stalenessGuard = new RenderStalenessGuard(el);
    ctx.addChild(stalenessGuard);

    try {
      const reportPhase = (phase: PreparePhase): void => loading.setText(PREPARE_PHASE_TEXT[phase]);
      const parameterStateKey = QueryParameterState.getStateKey(ctx.sourcePath, ctx.getSectionInfo(el)?.lineStart, source);
      const prepared = await this.renderPreparer.prepare({
        source,
        ctx,
        mode: 'initial',
        transformBlock: this.createBlockTransform(parameterStateKey, ctx.sourcePath),
        mapConfigOverrides: trackBuilder ? { trackBuilder } : undefined,
        supportsLiveVisibility: name => PlacesPlugin.getMapProvider(name)?.supportsLiveMarkerVisibility === true,
        onPhase: reportPhase,
        vaultQueryReadiness: () => this.vaultQueryService.pendingReadiness(),
      });
      if (stalenessGuard.superseded) {
        // A newer render replaced this section while data was being prepared;
        // creating a map here would leak a WebGL context into a dead element.
        loading.remove();
        return;
      }
      const { blockSettings, places, asyncOverlayLoad } = prepared;
      const overlays = prepared.initialOverlays;
      const resolvedConfig = prepared.resolvedSettings!.config;
      const mapTools = PlacesPlugin.getMapTools();
      const toolTrackLoader = {
        loadTrackFromPath: (pathSetting: string, sourcePath: string, options?: { skipCache?: boolean }) =>
          this.trackDataService.loadTrackFromPath(pathSetting, sourcePath, options),
        loadTrackPlaceFromPath: (pathSetting: string, sourcePath: string) =>
          Promise.resolve(this.placeDataService.loadTrackPlaceFromPath(pathSetting, sourcePath)),
      };
      const toolErrors: Array<{ path: string; error: string; type: string }> = [];
      for (const factory of mapTools) {
        const toolConfig = resolvedConfig.tools[factory.id];
        if (toolConfig === undefined || toolConfig === false) continue;
        if (factory.validateToolConfig) {
          try {
            factory.validateToolConfig(toolConfig);
          } catch (error) {
            // Report the bad mapping here rather than letting attach() throw
            // inside the map-load chain, where it surfaces only as an unhandled
            // rejection and the tool quietly never appears.
            toolErrors.push({
              path: `tools.${factory.id}`,
              error: getErrorMessage(error),
              type: 'Tool',
            });
            continue;
          }
        }
        if (!factory.contributePlaces) continue;
        try {
          const contributed = await factory.contributePlaces({
            source: { path: ctx.sourcePath },
            config: resolvedConfig,
            toolConfig,
            trackLoader: toolTrackLoader,
          });
          const existingPaths = new Set(places.map(place => place.filePath).filter((path): path is string => !!path));
          for (const place of contributed) {
            if (place.filePath && existingPaths.has(place.filePath)) continue;
            places.push(place);
            if (place.filePath) existingPaths.add(place.filePath);
          }
        } catch (error) {
          toolErrors.push({
            path: `tools.${factory.id}`,
            error: getErrorMessage(error),
            type: 'Tool',
          });
        }
      }

      loading.remove();

      const allOverlayErrors: Array<{ path: string; error: string; type: string }> = [
        ...(prepared.labelTemplateResult?.errors || []).map(e => ({
          path: e.filePath || e.placeName,
          error: e.message,
          type: 'Label Template'
        })),
        ...(prepared.resolvedSettings?.warnings || []).map(w => ({ path: w.path, error: w.message, type: 'Unknown Key' })),
        ...(prepared.parameterErrors ?? []).map(error => ({ path: 'queryParameters', error, type: 'Query Parameter' })),
        ...this.collectStoredOverlayErrors(places),
        ...toolErrors,
      ];

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
        await this.renderMap(emptyMapPlaces, [], el, blockSettings, prepared.rawBlockSettings, prepared.resolvedSettings!, source, ctx, [], undefined, undefined, trackBuilder, undefined, prepared.prepareTimings, prepared.popupDebug);
      this.renderParameterDebugTrace(el, source, ctx, prepared);
        const showHelp = shouldShowEmptyMapHelp(
          blockSettings.showHelpWithEmptyMap,
          PlacesPlugin.settings.showHelpWithEmptyMap,
          mapTools.some(factory =>
              factory.suppressEmptyMapHelp === true
              && resolvedConfig.tools[factory.id] !== undefined
              && resolvedConfig.tools[factory.id] !== false)
        );
        if (showHelp) {
          this.helpProcessor.renderPlaceMethods(el);
        }
        return;
      }

      const renderPlaces = places.length === 0 && asyncOverlayLoad ? this.createDefaultViewportMarkers() : places;
      if (stalenessGuard.superseded) return;
      await this.renderMap(renderPlaces, overlays, el, blockSettings, prepared.rawBlockSettings, prepared.resolvedSettings!, source, ctx, allOverlayErrors, asyncOverlayLoad, prepared.dataFingerprint, trackBuilder, prepared.liveVisibility, prepared.prepareTimings, prepared.popupDebug);
      this.renderParameterDebugTrace(el, source, ctx, prepared);
    } catch (error) {
      loading.remove();

      if (Utilities.isDataviewUnavailableError(error)) {
        this.renderRefreshableError(el, source, ctx, missingQueryPluginError('dataview'), trackBuilder);
        return;
      }

      if (Utilities.isVaultQueryUnavailableError(error)) {
        this.renderRefreshableError(el, source, ctx, missingQueryPluginError('vaultquery'), trackBuilder);
        return;
      }

      if (error instanceof VaultQueryPreparingError) {
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
        this.renderRefreshableError(el, source, ctx, { icon: "⚠️", title: "Query Error", message: error.message, helpSections: error.helpSections }, trackBuilder);
        return;
      }

      if (error instanceof TemplateNotFoundError) {
        // A template is a note, not a settings entry: the useful guidance is
        // what to check about the note the reference names - there is no list of
        // defined templates to offer, and no settings page to send anyone to.
        this.renderRefreshableError(el, source, ctx, {
          icon: "⚠️",
          title: "Unknown Template",
          message: error.message,
          helpSections: [{
            type: "text",
            title: "A template is a places-template block in any note. Check that:",
            items: [
              "the name resolves to a note, exactly as a [[link]] to it would",
              "that note contains a places-template block",
              "a #heading reference names the heading the block sits under",
            ],
          }],
        }, trackBuilder);
        return;
      }

      this.renderRefreshableError(el, source, ctx, { icon: "⚠️", title: "Error", message: getErrorMessage(error) }, trackBuilder);
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

  // The block parameter transform with optionsQuery resolution bound to
  // VaultQuery, for parameters that have no usable default or stored value.
  private createBlockTransform(stateKey: string | null, sourcePath: string, onErrors?: (errors: string[]) => void): (parsedBlock: ParsedCodeBlock) => Promise<{ parameterSignature: string }> {
    return createBlockParameterTransform(
      stateKey,
      onErrors,
      definitions => resolveOptionsQueries(definitions, sql => this.vaultQueryService.executeQuery(sql, sourcePath), QueryParameterState.peek(stateKey)),
      sourcePath,
      () => readNoteProperties(this.app, sourcePath),
    );
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

  private async renderMap(
    places: MapPlace[],
    overlays: Overlay[],
    container: HTMLElement,
    blockSettings: MapBlockSettings,
    rawBlockSettings: Record<string, unknown>,
    builtPreviewSettings: ResolvedMapSettings,
    source: string,
    ctx: MarkdownPostProcessorContext,
    overlayErrors: Array<{ path: string; error: string; type: string }> = [],
    asyncOverlayLoad?: AsyncOverlayLoad,
    initialDataFingerprint?: string,
    trackBuilder?: TrackBuilderConfig,
    liveVisibility?: { hiddenIds: string[] },
    prepareTimings?: MapPrepareTimings,
    popupDebug?: PreparedPlacesRender['popupDebug'],
  ): Promise<void> {
    // Baseline for refresh short-circuiting: a refresh that collects data with
    // this same fingerprint skips post-processing and the provider round-trip.
    let lastDataFingerprint = initialDataFingerprint;
    const providerName = PlacesPlugin.resolveMapProvider(blockSettings.mapProvider);

    // Also filter out heatmapLayer/heatmapColorScheme - these are only valid in places-heatmap blocks.
    const settingsWithoutOverlays = omitMapOverlaySettings(rawBlockSettings);

    // These allow map providers to save/restore state when switching tabs
    const sectionInfo = ctx.getSectionInfo(container);
    const mapSource = { path: ctx.sourcePath, lineStart: sectionInfo?.lineStart };
    const blockStateKey = QueryParameterState.getStateKey(ctx.sourcePath, sectionInfo?.lineStart, source);
    const terrain = PlacesPlugin.resolveTerrainRuntime(builtPreviewSettings.config);
    overlayErrors.push(...terrain.errors.map(e => ({ ...e, type: 'Terrain' })));
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
    const onPlaceAction = this.createPlaceActionHandler({ selectionParameter, rawBlockSettings, sourcePath: ctx.sourcePath, blockStateKey, container });
    const inspectionService = new TrackInspectionService(this.trackDataService, () => PlacesPlugin.settings, blockSettings.trackSpeedWindow);
    const inspectTrack = (place: MapPlace, coordinate: Coordinate) => inspectionService.inspect(place, coordinate, ctx.sourcePath);
    this.applySelectionActions(places, blockSettings.selectionParameter);
    const parameterContextActions = this.createLocationParameterActions(rawBlockSettings, ctx.sourcePath, blockStateKey, container);

    const renderPlan = createMapRenderPlan({
      surfaceKind: 'places-block',
      places,
      overlays,
      config: builtPreviewSettings.config,
      clusteringEnabled: builtPreviewSettings.clusteringEnabled,
      source: mapSource,
      camera: resolveCameraIntent(builtPreviewSettings.config, mapSource),
      onPlaceAction,
      placeNoteHost: PlacesPlugin.placeNoteHost,
      reverseGeocodeHost: PlacesPlugin.reverseGeocodeHost,
      inspectTrack,
      contextMenuActions: parameterContextActions,
      trackLoader: {
        loadTrackFromPath: (pathSetting, sourcePath, options) =>
          this.trackDataService.loadTrackFromPath(pathSetting, sourcePath, options),
        loadTrackPlaceFromPath: (pathSetting, sourcePath) =>
          Promise.resolve(this.placeDataService.loadTrackPlaceFromPath(pathSetting, sourcePath)),
      },
      mapTools: PlacesPlugin.getMapTools(),
      terrainDem: terrain.terrainDem,
      reliefDem: terrain.reliefDem,
      markerVisibilityHiddenIds: liveVisibility?.hiddenIds,
      popupDebug,
      prepareTimings,
    });
    overlayErrors.push(...renderPlan.errors.map(e => ({ ...e, type: 'Overlay' })));

    const legendPosition = getLegendPosition(renderPlan.config.trackColorBy, renderPlan.config.legend);

    if (legendPosition === 'top') {
      this.addMapLegend(container, renderPlan.config.trackColorBy, renderPlan.places);
    }

    const rerenderMap = async (): Promise<void> => {
      await this.rerenderMapBlock(source, container, ctx, trackBuilder);
    };

    const surface = await renderMapSurface({
      host: container,
      places: renderPlan.places,
      providerName,
      ctx,
      config: renderPlan.config,
      clusteringEnabled: renderPlan.clusteringEnabled,
      height: blockSettings.height ?? '',
      sourcePath: ctx.sourcePath,
      registerCleanup: false,
      onProviderMissing: () => this.helpProcessor.createMapProviderErrorDiv(container, blockSettings.mapProvider ?? ''),
      renderPlan,
      onRerenderRequested: rerenderMap,
      onPlanApplied: plan => {
        if (plan.places.length > 0 || plan.overlays.length > 0) {
          this.clearEmptyMapHelp(container);
        }
      },
    });

    if (!surface.rendered || !surface.provider || !surface.config || !surface.controller) {
      return;
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
    const resolvedConfig = surface.config;
    const controller = surface.controller;

    setMapRecoveryState(mapContainer, {
      rehydrate: rerenderMap,
      cleanup: () => cleanupMapProviderStates(mapContainer, error => logger.error('Error during map cleanup:', error)),
      hasActiveInstance: () => hasActiveMapProviderState(mapContainer),
      contextLost: false
    });

    ctx.addChild(new MapCleanupRenderChild(container));

    if (asyncOverlayLoad) {
      const progress = this.createOverlayLoadProgress(container);
      void asyncOverlayLoad.promise
        .then(overlayResult => {
          progress.remove();
          this.renderOverlayErrors(container, overlayResult.errors, 'places-async-overlay-error');
          if (overlayResult.overlays.length === 0) {
            return;
          }

          const nextRenderPlan = createMapRenderPlan({
            surfaceKind: 'places-block',
            places,
            overlays: overlayResult.overlays,
            config: builtPreviewSettings.config,
            clusteringEnabled: builtPreviewSettings.clusteringEnabled,
            source: mapSource,
            camera: renderPlan.camera,
            onPlaceAction,
            placeNoteHost: PlacesPlugin.placeNoteHost,
      reverseGeocodeHost: PlacesPlugin.reverseGeocodeHost,
            inspectTrack,
            trackLoader: this.trackDataService,
            mapTools: PlacesPlugin.getMapTools(),
            terrainDem: terrain.terrainDem,
            reliefDem: terrain.reliefDem,
            markerVisibilityHiddenIds: liveVisibility?.hiddenIds,
            popupDebug,
          });
          const planErrors = nextRenderPlan.errors.map(e => ({ ...e, type: 'Overlay' }));
          this.renderOverlayErrors(container, planErrors, 'places-async-overlay-plan-error');

          controller.setPlan(nextRenderPlan, { source: 'async-overlays' });
        })
        .catch(error => {
          progress.remove();
          logger.error('Async overlay loading failed', error);
          this.renderOverlayErrors(container, [{
            path: 'overlays',
            error: getErrorMessage(error),
            type: 'Overlay'
          }], 'places-async-overlay-error');
        });
    }

    const usesVaultQuery = !!blockSettings.query;
    const usesDataview = !!blockSettings.dataview;
    // These depend on the current file's metadata and need to refresh when the current file changes
    const usesSelfReferencingPlaceholders = !!blockSettings.query && /\{this\./i.test(blockSettings.query || '');
    const linkedPlaceDependencies = this.resolveLinkedPlaceDependencyPaths(blockSettings.linkedPlaces, ctx.sourcePath);

    const refreshService = MapRefreshService.getInstance();
    const resolveRefreshInputs = createMapRefreshInputResolver(container, source, ctx, sectionInfo?.lineStart);
    const refreshTransformBlock = this.createBlockTransform(blockStateKey, ctx.sourcePath, errors => logger.warn('Query parameter errors during refresh', errors));
    refreshService.registerMap(container, {
      sourcePath: ctx.sourcePath,
      usesVaultQuery,
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
        const prepared = await refreshPerf.measureAsync('prepare', () => this.renderPreparer.prepare({
          source: src,
          ctx: context,
          mode: 'refresh',
          bypassOverlayCache: refreshOptions?.manual,
          transformBlock: refreshTransformBlock,
          previousDataFingerprint: lastDataFingerprint,
          mapConfigOverrides: trackBuilder ? { trackBuilder } : undefined,
          supportsLiveVisibility: name => PlacesPlugin.getMapProvider(name)?.supportsLiveMarkerVisibility === true,
        }));
        this.renderParameterDebugTrace(el, src, context, prepared);
        if (prepared.unchangedData) {
          refreshPerf.mark('data-unchanged-skip', { places: prepared.places.length });
          logger.debug('map refresh skipped - collected data unchanged', { sourcePath: context.sourcePath, places: prepared.places.length });
          return;
        }
        const refreshToolErrors: Array<{ path: string; error: string; type: string }> = [];
        const refreshConfig = prepared.resolvedSettings!.config;
        for (const factory of PlacesPlugin.getMapTools()) {
          const toolConfig = refreshConfig.tools[factory.id];
          if (toolConfig === undefined || toolConfig === false || !factory.contributePlaces) continue;
          try {
            const contributed = await factory.contributePlaces({
              source: { path: context.sourcePath },
              config: refreshConfig,
              toolConfig,
              trackLoader: {
                loadTrackFromPath: (pathSetting: string, sourcePath: string, options?: { skipCache?: boolean }) =>
                  this.trackDataService.loadTrackFromPath(pathSetting, sourcePath, options),
                loadTrackPlaceFromPath: (pathSetting: string, sourcePath: string) =>
                  Promise.resolve(this.placeDataService.loadTrackPlaceFromPath(pathSetting, sourcePath)),
              },
            });
            const existingPaths = new Set(prepared.places.map(place => place.filePath).filter((path): path is string => !!path));
            for (const place of contributed) {
              if (place.filePath && existingPaths.has(place.filePath)) continue;
              prepared.places.push(place);
              if (place.filePath) existingPaths.add(place.filePath);
            }
          } catch (error) {
            refreshToolErrors.push({
              path: `tools.${factory.id}`,
              error: getErrorMessage(error),
              type: 'Tool',
            });
          }
        }
        lastDataFingerprint = prepared.dataFingerprint;
        const newBlockSettings = prepared.blockSettings;
        refreshService.updateMapDependencies(el, this.resolveLinkedPlaceDependencyPaths(newBlockSettings.linkedPlaces, context.sourcePath));
        const newPlaces = prepared.places;
        const nextProviderName = PlacesPlugin.resolveMapProvider(newBlockSettings.mapProvider);
        logger.debug('map refresh callback started', {
          sourcePath: context.sourcePath,
          hasQuery: Boolean(newBlockSettings.query),
          hasDataview: Boolean(newBlockSettings.dataview),
          hasOverlays: Boolean(prepared.rawBlockSettings.overlays),
          hasDirections: Boolean(newBlockSettings.directions),
          hasIsochrones: Boolean(newBlockSettings.isochrones),
          hasEmbeddedPlaces: Boolean(newBlockSettings.embeddedPlaces),
          hasLinkedPlaces: Boolean(newBlockSettings.linkedPlaces),
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

        // A missing map container or controller means the surface never
        // rendered; rebuild the block directly.
        const mapContainerEl = el.querySelector<HTMLElement>('.places-map-container');
        const mapController = mapContainerEl ? getMapSurfaceController(mapContainerEl) : undefined;
        if (!mapController) {
          await this.rerenderMapBlock(src, el, context, trackBuilder);
          return;
        }

        const { clusteringEnabled: refreshClusteringEnabled } = prepared.resolvedSettings!;
        const refreshTerrain = PlacesPlugin.resolveTerrainRuntime(refreshConfig);
        this.applySelectionActions(newPlaces, newBlockSettings.selectionParameter);
        const nextRenderPlan = refreshPerf.measure('build-plan', () => createMapRenderPlan({
          surfaceKind: 'places-block',
          places: newPlaces,
          overlays: refreshOverlays,
          config: refreshConfig,
          clusteringEnabled: refreshClusteringEnabled,
          source: mapSource,
          camera: { kind: 'preserve' },
          onPlaceAction,
          placeNoteHost: PlacesPlugin.placeNoteHost,
      reverseGeocodeHost: PlacesPlugin.reverseGeocodeHost,
          inspectTrack,
          contextMenuActions: parameterContextActions,
          trackLoader: this.trackDataService,
          mapTools: PlacesPlugin.getMapTools(),
          terrainDem: refreshTerrain.terrainDem,
          reliefDem: refreshTerrain.reliefDem,
          markerVisibilityHiddenIds: prepared.liveVisibility?.hiddenIds,
          popupDebug: prepared.popupDebug,
        }), { places: newPlaces.length });

        // The initial-render error containers are superseded by the refreshed
        // set: a run that recovers clears the stale error box, a run that fails
        // replaces it.
        const refreshErrors = [
          ...(prepared.labelTemplateResult?.errors || []).map(e => ({ path: e.filePath || e.placeName, error: e.message, type: 'Label Template' })),
          ...(prepared.parameterErrors ?? []).map(error => ({ path: 'queryParameters', error, type: 'Query Parameter' })),
          ...refreshToolErrors,
          ...(prepared.overlayErrors ?? []),
          ...this.collectStoredOverlayErrors(newPlaces),
          ...nextRenderPlan.errors.map(e => ({ ...e, type: 'Overlay' })),
        ];
        for (const className of ['places-initial-overlay-error', 'places-async-overlay-plan-error']) {
          for (const existing of el.querySelectorAll(`.${className}`)) {
            existing.remove();
          }
        }
        this.renderOverlayErrors(el, refreshErrors, 'places-async-overlay-error');

        mapController.setPlan(nextRenderPlan, { source: 'refresh' });
        await refreshPerf.measureAsync('provider-update', () => mapController.reconcile(), { places: nextRenderPlan.places.length });
      },
    });

    this.createFloatingButtons(container, mapContainer, mapProvider, places);
    await this.renderQueryParameterStrip(container, mapContainer, rawBlockSettings, source, ctx);

    if (legendPosition === 'bottom') {
      this.addMapLegend(container, resolvedConfig.trackColorBy, renderPlan.places);
    }

    if (parseDebugModes(settingsWithoutOverlays.debug).settings) {
      const trace = buildSettingsTrace(
        [...builtPreviewSettings.layers],
        { ...resolvedConfig },
        { notes: builtPreviewSettings.traceNotes },
      );
      renderSettingsTraceView(container, trace, 'Settings resolution (places block)');
    }

    this.renderOverlayErrors(container, overlayErrors, 'places-initial-overlay-error');
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
      if (actionId === CREATE_NOTE_ACTION_ID) {
        const searchResult = place.metadata?.geocodingSearchResult as Place | undefined;
        if (searchResult && parameterContext) {
          void this.createNoteFromPlace(searchResult);
        }
      }
      if (actionId === SET_SELECTION_ACTION_ID && parameterContext) {
        dispatchMapTrackSelection(parameterContext.container, { place, intent: 'commit', source: 'popup-action' });
      }
    };
  }

  private resolveLinkedPlaceDependencyPaths(linkedPlaces: unknown, sourcePath: string): string[] {
    const paths: string[] = [];
    const seen = new Set<string>();
    for (const reference of parseLinkedPlaceReferences(linkedPlaces)) {
      const file = this.app.metadataCache.getFirstLinkpathDest(reference.linkpath, sourcePath);
      if (!file || seen.has(file.path)) {
        continue;
      }
      seen.add(file.path);
      paths.push(file.path);
    }
    return paths;
  }

  private createOverlayLoadProgress(container: HTMLElement): { remove: () => void } {
    container.addClass('places-refresh-progress-host');
    const bar = container.createDiv({ cls: 'places-refresh-progress places-overlay-load-progress' });
    return {
      remove: () => {
        bar.remove();
        if (!container.querySelector('.places-refresh-progress')) {
          container.removeClass('places-refresh-progress-host');
        }
      }
    };
  }

  private renderOverlayErrors(container: HTMLElement, errors: Array<{ path: string; error: string; type: string }>, className: string): void {
    for (const existing of container.querySelectorAll(`.${className}`)) {
      existing.remove();
    }
    if (errors.length === 0) {
      return;
    }

    const errorContainer = renderError(container, {
      icon: "⚠️",
      title: "Some map content failed to load",
      className: `overlay-error places-error-below-map ${className}`
    });
    const errorList = errorContainer.createEl("ul");
    for (const err of errors) {
      errorList.createEl("li", { text: `[${err.type}] ${err.path}: ${err.error}` });
    }
  }

  private addMapLegend(container: HTMLElement, colorBy: string | undefined, places: MapPlace[]): void {
    const units = PlacesPlugin.settings.units;

    if (colorBy === 'grade') {
      createGradeLegend(container);
    } else if (colorBy === 'elevation') {
      const range = this.computeElevationRangeFromPlaces(places);
      if (range) {
        createElevationLegend(container, range.min, range.max, units);
      }
    }
  }

  // Runs on the initial render and on every refresh, including the
  // unchanged-data skip.
  private renderParameterDebugTrace(container: HTMLElement, source: string, ctx: MarkdownPostProcessorContext, prepared: PreparedPlacesRender): void {
    if (!prepared.parameterDebug) {
      removeParameterDebugPanel(container);
      return;
    }
    // prepared.rawBlockSettings, not a fresh parse of the source: the block
    // transform has already substituted {note.*} into the declarations, and the
    // panel should show the definitions the controls actually ran with.
    const { definitions } = parseQueryParameterDefinitions(prepared.rawBlockSettings.queryParameters);
    const stateKey = QueryParameterState.getStateKey(ctx.sourcePath, ctx.getSectionInfo(container)?.lineStart, source);
    const values = QueryParameterState.reconcile(stateKey, definitions);
    renderParameterDebugPanel(container, { definitions, values, trace: prepared.parameterDebug });
  }

  // `rawBlockSettings` is the transformed block: a control's `label`,
  // `default` or `options` that references `{note.*}` reaches the strip
  // substituted. Re-parsing the source here would render the placeholder text.
  private async renderQueryParameterStrip(container: HTMLElement, mapContainer: HTMLElement, rawBlockSettings: Record<string, unknown>, source: string, ctx: MarkdownPostProcessorContext): Promise<void> {
    const { definitions } = parseQueryParameterDefinitions(rawBlockSettings.queryParameters);
    if (definitions.length === 0) {
      return;
    }

    // Render the strip regardless of attachment: reading view may detach the
    // section while the optionsQuery runs and reattach the same elements on
    // scroll; dropping it here would leave reattached blocks without controls.
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
      onValuesApplied: () => { void MapRefreshService.getInstance().refreshContainerNow(container, {}); },
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

  // Write a parameter value from a map interaction (selection action, context
  // menu location pick). Block-local declarations use the block store and
  // refresh this block; note-scoped ones use the note store and refresh every
  // consumer in the note. Rendered controls update their display either way.
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

  // A context menu entry per location parameter (block-local and note-scoped): right-click the map to set it.
  private createLocationParameterActions(rawBlockSettings: Record<string, unknown>, sourcePath: string, blockStateKey: string | null, container: HTMLElement): MapContextAction[] {
    const local = parseQueryParameterDefinitions(rawBlockSettings.queryParameters).definitions;
    const localNames = new Set(local.map(definition => definition.name));
    const note = NoteParameterRegistry.definitionsFor(sourcePath).filter(definition => !localNames.has(definition.name));

    return [...local, ...note]
      .filter(definition => definition.type === 'location')
      .map(definition => ({
        text: `Set ${definition.label} here`,
        icon: '📍',
        onClick: (coordinate?: Coordinate) => {
          if (!coordinate) return;
          const value = `${roundTo(coordinate.latitude, 5)}, ${roundTo(coordinate.longitude, 5)}`;
          this.setParameterFromMap(definition.name, value, rawBlockSettings, sourcePath, blockStateKey, container);
        },
      }));
  }

  private createFloatingButtons(container: HTMLElement, mapContainer: HTMLElement, mapProvider: IMapBlockProcessor, places: MapPlace[]): void {
    const buttonContainer = createFloatingButtonContainer({ host: container });
    const actionStatus = this.getMapActionStatus(container);

    const controlHandle = mapProvider.getMapControlHandle?.(mapContainer) ?? null;
    const searchToggle = controlHandle ? createMarkerSearchToggle(container, controlHandle, places) : undefined;
    const getMapBounds = controlHandle?.getBounds;
    const setGeocodingSearchMarkers = controlHandle?.setGeocodingSearchMarkers
      ?? ((places: MapPlace[]) => mapProvider.setGeocodingSearchMarkers?.(places, mapContainer));

    // The two search panels are mutually exclusive: opening either closes the
    // other, and each needs a handle on its neighbour.
    let markerSearchButton: HTMLElement | null = null;
    let geocoding: GeocodingSearchButtonHandle | null = null;

    if (searchToggle) {
      markerSearchButton = createMarkerSearchButton({
        buttonContainer,
        searchToggle,
        onBeforeToggle: () => geocoding?.hide(),
      });
    }

    if (getMapBounds) {
      geocoding = createGeocodingSearchButton({
        buttonContainer,
        container,
        mapContainer,
        getMapBounds,
        setGeocodingSearchMarkers,
        searchPlaces: (query, bounds, onPartialResults) => {
          if (!this.placesService) {
            this.renderMapActionError(actionStatus, "Search unavailable", "No Places services are configured.");
            return Promise.resolve([]);
          }
          return this.placesService.lookupPlaceInBounds!(query, bounds, onPartialResults);
        },
        onCreateNote: (place) => void this.createNoteFromPlace(place),
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
      onRefresh: () => MapRefreshService.getInstance().refreshContainerNow(container),
      onError: error => logger.error('Refresh failed:', error),
    });
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

  private renderMapActionError(status: HTMLElement, title: string, message: string): void {
    status.empty();
    renderError(status, { icon: "⚠️", title, message });
  }

  private getMapActionStatus(container: HTMLElement): HTMLElement {
    return container.querySelector<HTMLElement>(":scope > .places-map-action-status")
      ?? container.createDiv({ cls: "places-map-action-status" });
  }

  // Only the provider-API resolution happens here; everything about the note
  // is the host's decision, identical to the POI and context-menu paths.
  private async createNoteFromPlace(place: Place): Promise<void> {
    try {
      // Some APIs (Mapbox) need an additional call for full details.
      const resolvedPlace = place.resolvePlace ? await place.resolvePlace() : place;
      await PlacesPlugin.placeNoteHost.createNote({
        kind: 'place',
        name: resolvedPlace.name || 'New Place',
        lat: resolvedPlace.latitude,
        lng: resolvedPlace.longitude,
        address: resolvedPlace.address,
        website: resolvedPlace.website,
        tags: resolvedPlace.tags,
      });
    } catch (error) {
      // Only resolvePlace can reject - the host reports its own failures.
      logger.error('Failed to resolve place for note creation:', error);
      new Notice('Failed to create note');
    }
  }

}
