import { resolveOverlayTrackData } from "places-shared/track";
import { Notice, Platform, type MarkdownPostProcessorContext } from "obsidian";
import { createElevationLegend, createGradeLegend, getElevationRange, getLegendPosition } from 'places/core/charts';
import type { MapPlace } from "places-shared/overlay";
import type { Place } from "places-shared/place";
import type { Meters } from "places-shared/units";
import type { MapRenderPlan } from "places-shared/render";
import type { IMapBlockProcessor, MapControlHandle } from "places-shared/services";
import { createFloatingRefreshButton } from "places-shared/obsidian/ui";
import { logger, renderError, createPerformanceMonitor } from "places-shared/utils";
import PlacesPlugin from "../main";
import { createDevicePositionButton, createFloatingButtonContainer, createGeocodingSearchButton, createMarkerSearchButton, createMarkerSearchToggle, CREATE_NOTE_ACTION_ID, type GeocodingSearchButtonHandle, type MarkerSearchHandle } from "./MapFloatingControls";

export interface MapSurfaceChromeOptions {
  host: HTMLElement;
  mapContainer: HTMLElement;
  getProvider: () => IMapBlockProcessor | null;
  ctx?: MarkdownPostProcessorContext;
  onRefresh: () => Promise<unknown>;
}

export interface MapSurfaceChrome {
  update(plan: MapRenderPlan): void;
  dispose(): void;
}

export function attachMapSurfaceChrome(options: MapSurfaceChromeOptions): MapSurfaceChrome {
  const { host, mapContainer } = options;
  let buttons: HTMLElement | null = null;
  let controls: MapControlHandle | null = null;
  let controlProvider: IMapBlockProcessor | null = null;
  let showDevicePosition = false;
  let disposed = false;
  let source: MapRenderPlan['runtime']['source'] | undefined;
  let markerSearch: MarkerSearchHandle | undefined;
  let geocoding: GeocodingSearchButtonHandle | null = null;

  const disposeButtons = (): void => {
    markerSearch?.destroy();
    markerSearch = undefined;
    geocoding?.destroy();
    geocoding = null;
    controls?.setDevicePositionControl?.(null);
    controls = null;
    controlProvider = null;
    buttons?.remove();
    buttons = null;
  };

  const removeLegends = (): void => {
    for (const legend of host.querySelectorAll(':scope > .places-color-legend')) legend.remove();
  };

  const renderLegend = (plan: MapRenderPlan): void => {
    removeLegends();
    const position = getLegendPosition(plan.config.trackColorBy, plan.config.legend);

    if (position === null) return;
    const legend = createLegend(host, plan.config.trackColorBy, plan.places);

    if (legend) {
      if (position === 'top') mapContainer.before(legend);
      else mapContainer.after(legend);
    }
  };

  const renderButtons = (plan: MapRenderPlan): void => {
    source = plan.runtime.source;
    const places = plan.places.filter(place => !place.metadata?.boundsAnchor && place.markerEnabled !== false);
    const provider = options.getProvider();
    const controlHandle = provider?.getMapControlHandle?.(mapContainer) ?? null;
    const nextDevicePosition = Boolean(plan.config.showCurrentDevicePosition && Platform.isMobileApp && controlHandle?.setDevicePositionControl);

    if (buttons?.parentElement === host && controlProvider === provider && controls === controlHandle && showDevicePosition === nextDevicePosition) {
      markerSearch?.setPlaces(places);

      return;
    }

    disposeButtons();
    controls = controlHandle;
    controlProvider = provider;
    showDevicePosition = nextDevicePosition;
    const buttonContainer = createFloatingButtonContainer({ host });

    buttons = buttonContainer;
    const getCurrentControls = (): MapControlHandle | null => !disposed && buttons === buttonContainer
      && options.getProvider() === provider && provider?.getMapControlHandle?.(mapContainer) === controlHandle
      ? controlHandle : null;
    const searchToggle = createMarkerSearchToggle(host, getCurrentControls, places);

    markerSearch = searchToggle;

    const setGeocodingSearchMarkers = (markers: MapPlace[]): void => {
      const current = getCurrentControls();

      if (!current) return;

      if (current.setGeocodingSearchMarkers) current.setGeocodingSearchMarkers(markers);
      else provider?.setGeocodingSearchMarkers?.(markers, mapContainer);
    };

    let markerSearchButton: HTMLElement | null = null;

    if (showDevicePosition && controlHandle?.setDevicePositionControl) {
      createDevicePositionButton({ buttonContainer, setControl: controlHandle.setDevicePositionControl });
    } else {
      controlHandle?.setDevicePositionControl?.(null);
    }

    if (searchToggle) {
      markerSearchButton = createMarkerSearchButton({
        buttonContainer,
        searchToggle,
        onBeforeToggle: () => geocoding?.hide(),
      });
    }

    const getMapBounds = controlHandle?.getBounds;

    if (getMapBounds) {
      geocoding = createGeocodingSearchButton({
        buttonContainer,
        container: host,
        mapContainer,
        getMapBounds: () => {
          if (!getCurrentControls()) throw new DOMException('Map replaced', 'AbortError');

          return getMapBounds();
        },
        setGeocodingSearchMarkers,
        searchPlaces: (query, bounds, onPartialResults) => PlacesPlugin.placesServiceFor({ ...(source?.path ? { sourcePath: source.path } : {}), blockType: 'places' }).lookupPlaceInBounds(query, bounds, onPartialResults),
        onCreateNote: place => void createNoteFromSearchResult(place, source?.path),
        centerOnPlace: place => getCurrentControls()?.centerOnPlace?.(place),
        resolveResultIcon: place => PlacesPlugin.placeNoteHost.resolveIcon(searchResultNoteRequest(place, source?.path)),
        onBeforeOpen: () => {
          if (!searchToggle?.isVisible()) return;
          searchToggle.toggle();
          markerSearchButton?.removeClass('is-active');
        },
      });
    }

    createFloatingRefreshButton({
      buttonContainer,
      ctx: options.ctx,
      ariaLabel: 'Refresh map',
      onRefresh: options.onRefresh,
      onError: error => logger.error('Refresh failed:', error),
    });
  };

  return {
    update: plan => {
      if (disposed) return;
      const perf = createPerformanceMonitor('map-chrome', { sourcePath: plan.runtime.source.path, places: plan.places.length }, { enabled: PlacesPlugin.settings.developerMode });

      perf.measure('legend', () => renderLegend(plan));
      perf.measure('controls', () => renderButtons(plan));
    },
    dispose: () => {
      if (disposed) return;
      disposeButtons();
      disposed = true;
      removeLegends();
    },
  };
}

function createLegend(host: HTMLElement, colorBy: string | undefined, places: readonly MapPlace[]): HTMLElement | undefined {
  if (colorBy === 'grade') {
    return createGradeLegend(host);
  }

  if (colorBy === 'elevation') {
    const range = getElevationRange(trackElevations(places));

    if (range) return createElevationLegend(host, range.min, range.max, PlacesPlugin.settings.units);
  }

  return undefined;
}

function* trackElevations(places: readonly MapPlace[]): Iterable<Meters> {
  for (const place of places) {
    const elevations = place.overlay ? resolveOverlayTrackData(place.overlay)?.elevation : undefined;

    if (elevations) yield* elevations;
  }
}

export interface MapContentError {
  path: string;
  error: string;
  type: string;
}

export function renderMapContentErrors(host: HTMLElement, errors: readonly MapContentError[], className: string): void {
  for (const existing of host.querySelectorAll(`.${className}`)) existing.remove();
  if (errors.length === 0) return;

  const errorContainer = renderError(host, {
    icon: "⚠️",
    title: "Some map content failed to load",
    className: `overlay-error places-error-below-map ${className}`,
  });
  const errorList = errorContainer.createEl("ul");

  for (const err of errors) {
    errorList.createEl("li", { text: `[${err.type}] ${err.path}: ${err.error}` });
  }
}

export function createOverlayLoadProgress(host: HTMLElement): { remove: () => void } {
  host.querySelector(':scope > .places-overlay-load-progress')?.remove();
  host.addClass('places-refresh-progress-host');
  const bar = host.createDiv({ cls: 'places-refresh-progress places-overlay-load-progress' });

  return {
    remove: () => {
      bar.remove();

      if (!host.querySelector('.places-refresh-progress')) {
        host.removeClass('places-refresh-progress-host');
      }
    },
  };
}

function searchResultNoteRequest(place: Place, sourcePath?: string) {
  return {
    ...place,
    sourcePath,
    kind: 'place' as const,
    name: place.name || 'New Place',
    lat: place.latitude,
    lng: place.longitude,
    address: place.address,
    website: place.website,
    tags: place.tags,
  };
}

export async function createNoteFromSearchResult(place: Place, sourcePath?: string): Promise<void> {
  try {
    const resolved = place.resolvePlace ? await place.resolvePlace() : place;

    await PlacesPlugin.placeNoteHost.createNote(searchResultNoteRequest(resolved, sourcePath));
  } catch (error) {
    logger.error('Failed to resolve place for note creation:', error);
    new Notice('Failed to create note');
  }
}

export function handleSearchResultAction(place: MapPlace, actionId: string, sourcePath?: string): void {
  if (actionId !== CREATE_NOTE_ACTION_ID) return;
  const searchResult = place.metadata?.geocodingSearchResult as Place | undefined;

  if (searchResult) void createNoteFromSearchResult(searchResult, sourcePath);
}
