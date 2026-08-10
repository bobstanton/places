import { MarkdownPostProcessorContext } from "obsidian";
import { MapPlace, Overlay } from "places-shared/overlay";
import { cleanupMapProviderStates, hasActiveMapProviderState, setMapRecoveryState, ensureMapSurfaceLifecycle, mapsAreDisabledForRender, renderSuppressedMapPlaceholder } from "places-shared/map";
import { createMapRenderPlan, resolveCameraIntent, type MapCameraIntent, type MapRenderPlan } from "places-shared/render";
import { type MapContextAction, type MapSourceContext, type MapTrackLoader, type ResolvedMapConfig } from "places-shared/settings";
import { type IMapBlockProcessor } from "places-shared/services";
import { renderMapSurfaceError, getErrorMessage, logger as rootLogger } from "places-shared/utils";
import PlacesPlugin from "../main";
import { missingMapProviderError } from "./MissingPluginError";
import { resolveMapSettings } from "./MapSettingsResolver";
import { MapCleanupRenderChild } from "../code-block-processor/MapCleanupRenderChild";
import { MapSurfaceController, type MapSurfaceControllerOptions } from "./MapSurfaceController";
import { createDomMapSurfaceDriver } from "./MapSurfaceDriverDom";
import { setMapSurfaceController } from "./MapSurfaceControllers";

const logger = rootLogger.scope('MapSurface');

interface MapSurfaceRenderOptionsBase {
  host: HTMLElement;
  places: MapPlace[];
  providerName: string;
  ctx?: MarkdownPostProcessorContext;
  mapContainer?: HTMLElement;
  mapContainerClass?: string;
  mapContainerCssProps?: Record<string, string>;
  height?: string;
  sourcePath?: string;
  rawSettings?: Record<string, unknown>;
  config?: ResolvedMapConfig;
  clusteringEnabled?: boolean;
  source?: MapSourceContext;
  focusOnInteraction?: boolean;
  registerCleanup?: boolean;
  onProviderMissing?: (providerName: string) => void;
  errorTitle?: string;
  // Escalation used when an in-place update declines structurally. Defaults to a surface-level teardown + re-render.
  onRerenderRequested?: (reason: string) => Promise<void>;
  // UI side effects to run when a later plan lands on the surface.
  onPlanApplied?: MapSurfaceControllerOptions['onPlanApplied'];
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
  rendered: boolean;
  provider: IMapBlockProcessor | null;
  mapContainer: HTMLElement;
  config: ResolvedMapConfig | null;
  clusteringEnabled: boolean;
  controller: MapSurfaceController | null;
}

// Fill in the host-owned runtime capabilities a caller-built plan cannot carry.
//
// Provider-authored surfaces (the tide-station map, the classify preview) build
// their plans in provider bundles, where `PlacesPlugin` is unreachable, and
// without this their context menus silently lose "Search for place here" and
// "Create note at location". The host owns the surface either way; a capability
// the plan already carries is never overridden.
export function withHostCapabilities(plan: MapRenderPlan): MapRenderPlan {
  const runtime = plan.runtime;
  if (runtime.placeNoteHost && runtime.reverseGeocodeHost) return plan;
  return {
    ...plan,
    runtime: {
      ...runtime,
      placeNoteHost: runtime.placeNoteHost ?? PlacesPlugin.placeNoteHost,
      reverseGeocodeHost: runtime.reverseGeocodeHost ?? PlacesPlugin.reverseGeocodeHost,
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
    if (options.onProviderMissing) {
      renderMapSurfaceError(mapContainer, {
        title: options.errorTitle ?? "Map Provider Not Found",
      });
      mapContainer.remove();
      options.onProviderMissing(options.providerName);
    } else {
      renderMapSurfaceError(mapContainer, {
        ...missingMapProviderError(options.providerName),
        ...(options.errorTitle ? { title: options.errorTitle } : {}),
      });
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
  const initialPlan = options.renderPlan ? withHostCapabilities(options.renderPlan) : createMapRenderPlan({
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
    trackLoader: options.trackLoader ?? PlacesPlugin.getTrackDataService(),
    camera: options.camera ?? resolveCameraIntent(built.config, planSource),
  });

  try {
    await provider.processPlaceCodeBlock(initialPlan.places, mapContainer, { config: initialPlan.config, runtime: initialPlan.runtime });
  } catch (error) {
    logger.error('Error rendering map surface', error);
    cleanupMapProviderStates(mapContainer, cleanupError => logger.error('Error cleaning up failed map surface:', cleanupError));
    renderMapSurfaceError(mapContainer, {
      icon: "⚠️",
      title: "Map Render Error",
      message: getErrorMessage(error),
      helpSections: []
    });
    return {
      rendered: false,
      provider,
      mapContainer,
      config: initialPlan.config,
      clusteringEnabled: built.clusteringEnabled,
      controller: null,
    };
  }

  const controller = createMapSurfaceController(options, mapContainer, initialPlan);

  // Default recovery for every surface: WebGL context loss re-renders the
  // newest plan through the controller. Block/Bases overwrite rehydrate with
  // their own full-rebuild paths right after this call.
  setMapRecoveryState(mapContainer, {
    rehydrate: () => controller.restartSurface('webgl-context-lost'),
    cleanup: () => cleanupMapProviderStates(mapContainer, error => logger.error('Error during map cleanup:', error)),
    hasActiveInstance: () => hasActiveMapProviderState(mapContainer),
    contextLost: false,
  });

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

// Every rendered surface gets a reconciler seeded with the plan that just
// landed. The construction-time camera only saw real layout if the container
// had size - a zero-size (detached/below-fold) map fit garbage bounds, and the
// controller re-fits it once the provider ResizeObserver reports real size.
function createMapSurfaceController(options: MapSurfaceRenderOptions, mapContainer: HTMLElement, plan: MapRenderPlan): MapSurfaceController {
  const driver = createDomMapSurfaceDriver({
    container: () => mapContainer,
    provider: () => PlacesPlugin.getMapProvider(options.providerName) ?? null,
    providerName: () => options.providerName,
    render: async nextPlan => {
      if (hasActiveMapProviderState(mapContainer)) {
        cleanupMapProviderStates(mapContainer, error => logger.error('Error during map cleanup:', error));
      }
      const renderProvider = PlacesPlugin.getMapProvider(options.providerName);
      if (!renderProvider) {
        return { rendered: false, reason: 'no map provider' };
      }
      try {
        await renderProvider.processPlaceCodeBlock(nextPlan.places, mapContainer, { config: nextPlan.config, runtime: nextPlan.runtime });
        return { rendered: true };
      } catch (error) {
        logger.error('Error rendering map surface', error);
        const reason = getErrorMessage(error);
        renderMapSurfaceError(mapContainer, {
          icon: '⚠️',
          title: 'Map Render Error',
          message: reason,
        });
        return { rendered: false, reason };
      }
    },
    rerender: options.onRerenderRequested ?? (reason => {
      logger.warn('map surface rebuild requested but surface has no rerender handler', { reason, provider: options.providerName });
      return Promise.resolve();
    }),
  });

  const controller = new MapSurfaceController(driver, { onPlanApplied: options.onPlanApplied });
  setMapSurfaceController(mapContainer, controller);

  // Prime the lifecycle with the container's live layout in case the provider's
  // ResizeObserver has not fired yet. Only report a real size - reporting a
  // stale zero here would clobber a size the RO already reported and, because
  // the RO only fires on change, leave the surface permanently unsized.
  // cameraSatisfied then reflects the lifecycle's true state, not a re-read that
  // could race layout.
  const lifecycle = ensureMapSurfaceLifecycle(mapContainer);
  if (mapContainer.clientWidth > 0 && mapContainer.clientHeight > 0) {
    lifecycle.reportSize(mapContainer.clientWidth, mapContainer.clientHeight);
  }
  controller.seedApplied(plan, { cameraSatisfied: lifecycle.getState().sized });
  return controller;
}

export function configureMapSurfaceContainer(mapContainer: HTMLElement, options: Pick<MapSurfaceRenderOptions, 'mapContainerClass' | 'mapContainerCssProps' | 'height' | 'sourcePath' | 'focusOnInteraction'>): void {
  if (mapContainer.classList.contains('places-map-surface-error')) {
    mapContainer.removeClass('places-map-surface-error');
    mapContainer.style.removeProperty('height');
    mapContainer.style.removeProperty('min-height');
  }

  if (options.mapContainerClass) {
    mapContainer.addClass(options.mapContainerClass);
  }

  if (options.mapContainerCssProps) {
    mapContainer.setCssProps(options.mapContainerCssProps);
  }

  // A custom property rather than an attribute: the stylesheet cannot enumerate
  // every height a block might ask for, and setCssProps is the API Obsidian
  // sanctions in place of writing to style directly.
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
  return options.host.createDiv({ cls: options.mapContainerClass ?? "places-map-container" });
}
