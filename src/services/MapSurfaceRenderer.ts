import { MarkdownPostProcessorContext } from "obsidian";
import { MapPlace, Overlay } from "places-shared/overlay";
import { clearMapRecoveryState, setMapRecoveryState } from "places-shared/obsidian/map";
import { ensureMapSurfaceLifecycle, mapsAreDisabledForRender, renderSuppressedMapPlaceholder } from "places-shared/map";
import { createMapRenderPlan, resolveCameraIntent, type MapCameraIntent, type MapRenderPlan } from "places-shared/render";
import { type MapContextAction, type MapSourceContext, type MapTrackLoader, type ResolvedMapConfig } from "places-shared/settings";
import { type IMapBlockProcessor } from "places-shared/services";
import { logger as rootLogger } from "places-shared/utils";
import { RenderStalenessGuard } from "places-shared/obsidian/ui";
import PlacesPlugin from "../main";
import { renderMissingMapProvider } from "./MissingPluginError";
import { resolveMapSettings } from "./MapSettingsResolver";
import { MapCleanupRenderChild } from "../code-block-processor/MapCleanupRenderChild";
import { MapSurfaceController, type MapSurfaceControllerOptions } from "./MapSurfaceController";
import { createDomMapSurfaceDriver } from "./MapSurfaceDriverDom";
import { disposeMapSurfaceController, setMapSurfaceController, setMapSurfaceProviderWaiter } from "./MapSurfaceControllers";
import { attachMapSurfaceChrome } from "./MapSurfaceChrome";

const logger = rootLogger.scope('MapSurface');

interface MapSurfaceRenderOptionsBase {
  host: HTMLElement;
  places: MapPlace[];
  providerName: string;
  ctx?: MarkdownPostProcessorContext;
  mapContainer?: HTMLElement;
  mapContainerClass?: string;
  height?: string;
  sourcePath?: string;
  rawSettings?: Record<string, unknown>;
  config?: ResolvedMapConfig;
  clusteringEnabled?: boolean;
  source?: MapSourceContext;
  focusOnInteraction?: boolean;
  registerCleanup?: boolean;
  onRerenderRequested?: (reason: string) => Promise<void>;
  onPlanApplied?: MapSurfaceControllerOptions['onPlanApplied'];
  chrome?: { onRefresh: () => Promise<unknown> };
  isStale?: () => boolean;
}

// Inputs used ONLY to derive a plan for render-only surfaces that have none.
// A supplied plan owns the entire runtime (CLAUDE.md contract #5), and these are
// dead alongside one: the union below turns passing both into a compile error
// rather than a silently ignored handler.
interface MapSurfacePlanInputs {
  overlays?: Overlay[];
  contextMenuActions?: readonly MapContextAction[];
  onPlaceAction?: (place: MapPlace, actionId: string, state: { checked?: boolean }) => void;
  trackLoader?: MapTrackLoader;
  camera?: MapCameraIntent;
}

export type MapSurfaceRenderOptions =
  | (MapSurfaceRenderOptionsBase & MapSurfacePlanInputs & { renderPlan?: undefined })
  | (MapSurfaceRenderOptionsBase & { [K in keyof MapSurfacePlanInputs]?: never } & {
    // Full render plan for this surface; a minimal plan is derived when absent (render-only surfaces).
    renderPlan: MapRenderPlan;
  });

export interface MapSurfaceRenderResult {
  // Includes a retained plan waiting for layout before engine creation.
  rendered: boolean;
  provider: IMapBlockProcessor | null;
  mapContainer: HTMLElement;
  config: ResolvedMapConfig | null;
  clusteringEnabled: boolean;
  controller: MapSurfaceController | null;
}

export function withHostCapabilities(plan: MapRenderPlan): MapRenderPlan {
  const runtime = plan.runtime;
  const popupRenderers = PlacesPlugin.getPopupRenderers();

  if (runtime.placeNoteHost && runtime.reverseGeocodeHost && runtime.popupRenderers === popupRenderers) return plan;

  return {
    ...plan,
    runtime: {
      ...runtime,
      placeNoteHost: runtime.placeNoteHost ?? PlacesPlugin.placeNoteHost,
      reverseGeocodeHost: runtime.reverseGeocodeHost ?? PlacesPlugin.reverseGeocodeHost,
      popupRenderers,
    },
  };
}

export async function renderMapSurface(options: MapSurfaceRenderOptions): Promise<MapSurfaceRenderResult> {
  const mapContainer = options.mapContainer ?? createMapSurfaceContainer(options);

  configureMapSurfaceContainer(mapContainer, options);

  if (mapsAreDisabledForRender(mapContainer)) {
    renderSuppressedMapPlaceholder(mapContainer);

    return {
      rendered: true,
      provider: null,
      mapContainer,
      config: options.renderPlan?.config ?? options.config ?? null,
      clusteringEnabled: options.renderPlan?.clusteringEnabled ?? options.clusteringEnabled ?? false,
      controller: null,
    };
  }

  const provider = PlacesPlugin.getMapProvider(options.providerName);

  if (!provider) {
    renderMissingMapProvider(mapContainer, options.providerName);

    if (options.onRerenderRequested) {
      setMapSurfaceProviderWaiter(mapContainer, { providerName: options.providerName, rerender: options.onRerenderRequested });
    }

    return { rendered: false, provider: null, mapContainer, config: null, clusteringEnabled: false, controller: null };
  }

  const built = options.config
    ? {
      config: options.config,
      clusteringEnabled: options.clusteringEnabled ?? false,
    }
    : resolveMapSettings({
      providerName: options.providerName,
      rawBlockSettings: options.rawSettings ?? {},
      placeCount: options.places.length,
    });

  const planSource = options.source ?? { path: options.sourcePath };
  const isStale = options.isStale ?? options.renderPlan?.runtime.isStale ?? createStalenessCheck(options);
  const suppliedPlan = options.renderPlan ? withHostCapabilities(options.renderPlan) : undefined;
  const initialPlan = suppliedPlan
    ? (suppliedPlan.runtime.isStale ? suppliedPlan : { ...suppliedPlan, runtime: { ...suppliedPlan.runtime, isStale } })
    : createMapRenderPlan({
    surfaceKind: 'other',
    places: options.places,
    overlays: options.overlays,
    config: built.config,
    clusteringEnabled: built.clusteringEnabled,
    source: planSource,
    contextMenuActions: options.contextMenuActions,
    onPlaceAction: options.onPlaceAction,
    placeNoteHost: PlacesPlugin.placeNoteHost,
    reverseGeocodeHost: PlacesPlugin.reverseGeocodeHost,
    popupRenderers: PlacesPlugin.getPopupRenderers(),
    trackLoader: options.trackLoader ?? PlacesPlugin.getTrackDataService(),
    camera: options.camera ?? resolveCameraIntent(built.config, planSource),
    isStale,
  });

  if (initialPlan.runtime.isStale?.()) {
    logger.debug('map surface render abandoned - caller superseded', { source: planSource.path });

    return { rendered: false, provider, mapContainer, config: initialPlan.config, clusteringEnabled: built.clusteringEnabled, controller: null };
  }

  const controller = createMapSurfaceController(options, mapContainer);

  setMapRecoveryState(mapContainer, {
    rehydrate: () => controller.restartSurface('webgl-context-lost'),
  });

  controller.setPlan(initialPlan, { source: 'initial' });
  await controller.reconcile();
  const state = controller.getState();

  if (state.appliedPlanSignature !== initialPlan.signature && state.pending?.reason !== 'awaiting-size') {
    logger.debug('map surface render discarded - initial plan never applied', {
      source: planSource.path,
      desired: state.desiredPlanSignature,
      applied: state.appliedPlanSignature,
      pending: state.pending?.reason ?? null,
      stale: Boolean(initialPlan.runtime.isStale?.()),
    });
    disposeMapSurfaceController(mapContainer);
    clearMapRecoveryState(mapContainer);

    return {
      rendered: false,
      provider,
      mapContainer,
      config: initialPlan.config,
      clusteringEnabled: built.clusteringEnabled,
      controller: null,
    };
  }

  if (options.registerCleanup !== false && options.ctx) {
    options.ctx.addChild(new MapCleanupRenderChild(options.host));
  }

  return {
    rendered: true,
    provider,
    mapContainer,
    config: initialPlan.config,
    clusteringEnabled: built.clusteringEnabled,
    controller,
  };
}

function createMapSurfaceController(options: MapSurfaceRenderOptions, mapContainer: HTMLElement): MapSurfaceController {
  const getProvider = () => PlacesPlugin.getMapProvider(options.providerName) ?? null;
  const driver = createDomMapSurfaceDriver({
    container: () => mapContainer,
    provider: getProvider,
    providerName: () => options.providerName,
    rerender: options.onRerenderRequested ?? (reason => {
      logger.warn('map surface rebuild requested but surface has no rerender handler', { reason, provider: options.providerName });

      return Promise.resolve();
    }),
  });

  const chrome = options.chrome
    ? attachMapSurfaceChrome({ host: options.host, mapContainer, getProvider, ctx: options.ctx, onRefresh: options.chrome.onRefresh })
    : undefined;
  const controller = new MapSurfaceController(driver, {
    onPlanApplied: plan => {
      chrome?.update(plan);
      options.onPlanApplied?.(plan);
    },
  });

  setMapSurfaceController(mapContainer, controller, chrome);

  const lifecycle = ensureMapSurfaceLifecycle(mapContainer);

  if (mapContainer.clientWidth > 0 && mapContainer.clientHeight > 0) {
    lifecycle.reportSize(mapContainer.clientWidth, mapContainer.clientHeight);
  }

  return controller;
}

function createStalenessCheck(options: MapSurfaceRenderOptions): (() => boolean) | undefined {
  if (!options.ctx) return undefined;
  const guard = new RenderStalenessGuard(options.host, options.sourcePath ?? options.ctx?.sourcePath);

  options.ctx.addChild(guard);

  return () => guard.superseded;
}

export function configureMapSurfaceContainer(mapContainer: HTMLElement, options: Pick<MapSurfaceRenderOptions, 'mapContainerClass' | 'height' | 'sourcePath' | 'focusOnInteraction'>): void {
  if (mapContainer.classList.contains('places-map-surface-error')) {
    mapContainer.removeClass('places-map-surface-error');
    mapContainer.style.removeProperty('height');
    mapContainer.style.removeProperty('min-height');
  }

  if (options.mapContainerClass) {
    mapContainer.addClass(options.mapContainerClass);
  }

  if (options.height) {
    mapContainer.setCssProps({ '--places-map-height': options.height });
  }

  mapContainer.setAttribute("tabindex", "0");

  if (options.sourcePath) {
    mapContainer.setAttribute("data-source-path", options.sourcePath);
  }

  if (options.focusOnInteraction !== false && !mapContainer.dataset.placesSurfaceFocusHandler) {
    mapContainer.dataset.placesSurfaceFocusHandler = '1';

    const handleInteractionStart = (event: Event) => {
      event.stopPropagation();
      mapContainer.focus();
    };

    mapContainer.addEventListener("mousedown", handleInteractionStart);
    mapContainer.addEventListener("touchstart", handleInteractionStart, { passive: true });
  }
}

function createMapSurfaceContainer(options: MapSurfaceRenderOptions): HTMLElement {
  return options.host.createDiv({ cls: "places-map-container" });
}
