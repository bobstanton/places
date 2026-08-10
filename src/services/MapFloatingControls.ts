import { setIcon } from "obsidian";
import { type MapPlace } from "places-shared/overlay";
import { type MapSearchToggle, setMapContainerState } from "places-shared/map";
import { type Place } from "places-shared/place";
import { type PlacesBoundingBox } from "places-shared/geo";
import { MapGeocodingSearch } from "./MapGeocodingSearch";
import { MapSearchComponent } from "../ui/MapSearchComponent";
import { type MapControlHandle } from "places-shared/services";

export interface FloatingButtonContainerOptions {
  host: HTMLElement;
  className?: string;
  removeExisting?: boolean;
  removeGeocodingSearch?: boolean;
}

export function createFloatingButtonContainer(options: FloatingButtonContainerOptions): HTMLElement {
  const className = options.className ?? 'places-floating-buttons';
  if (options.removeExisting !== false) {
    options.host.querySelector(`.${className}`)?.remove();
  }
  if (options.removeGeocodingSearch !== false) {
    options.host.querySelectorAll('.places-geocoding-search').forEach((el) => el.remove());
  }
  return options.host.createDiv(className);
}

export interface MarkerSearchButtonOptions {
  buttonContainer: HTMLElement;
  searchToggle: MapSearchToggle;
  ariaLabel?: string;
  onBeforeToggle?: () => void;
}

export function createMarkerSearchToggle(container: HTMLElement, controlHandle: MapControlHandle, places: MapPlace[]): MapSearchToggle | undefined {
  if (!controlHandle.centerOnPlace && !controlHandle.highlightPlace) return undefined;

  const searchToggle: MapSearchToggle = {} as MapSearchToggle;
  const searchComponent = new MapSearchComponent(container, {
    centerOnPlace: (place: MapPlace) => controlHandle.centerOnPlace?.(place),
    highlightPlace: (place: MapPlace) => controlHandle.highlightPlace?.(place),
    onClose: () => {
      controlHandle.clearHighlight?.();
      searchToggle.onCloseCallback?.();
    },
    renderIcon: (iconContainer, iconSource) => setIcon(iconContainer, iconSource),
  });
  searchComponent.setPlaces(places);
  searchToggle.toggle = () => searchComponent.toggle();
  searchToggle.isVisible = () => searchComponent.visible;
  return searchToggle;
}

export function createMarkerSearchButton(options: MarkerSearchButtonOptions): HTMLElement {
  const searchButton = options.buttonContainer.createDiv('places-floating-button');
  searchButton.setAttribute('aria-label', options.ariaLabel ?? 'Find marker on map');
  setIcon(searchButton, 'target');

  options.searchToggle.onCloseCallback = () => {
    searchButton.removeClass('is-active');
  };

  searchButton.addEventListener('click', () => {
    options.onBeforeToggle?.();
    options.searchToggle.toggle();
    if (options.searchToggle.isVisible()) {
      searchButton.addClass('is-active');
    } else {
      searchButton.removeClass('is-active');
    }
  });

  return searchButton;
}

// Per-place action id for turning a geocoding search result into a note.
export const CREATE_NOTE_ACTION_ID = 'create-note-from-search';

export interface GeocodingSearchButtonOptions {
  // Row the button is added to.
  buttonContainer: HTMLElement;
  // Host the search panel mounts into.
  container: HTMLElement;
  // Map container carrying the toggle state other surfaces read.
  mapContainer: HTMLElement;
  getMapBounds: NonNullable<MapControlHandle['getBounds']>;
  setGeocodingSearchMarkers: (places: MapPlace[]) => void;
  searchPlaces: (query: string, bounds: PlacesBoundingBox, onPartialResults?: (places: Place[]) => void) => Promise<Place[]>;
  // Create a note for a result - reached only through the explicit create-note affordances.
  onCreateNote: (place: Place) => void;
  // Focus the map on a clicked result's preview marker.
  centerOnPlace?: MapControlHandle['centerOnPlace'];
  // The icon the result's note would get (the host's marker icon rules).
  resolveResultIcon: (place: Place) => string;
  // Close a panel that must not be open alongside this one.
  onBeforeOpen?: () => void;
}

export interface GeocodingSearchButtonHandle {
  readonly button: HTMLElement;
  isVisible(): boolean;
  hide(): void;
}

// The "Search for Places" button and its panel, shared by the places block and the Bases map view.
export function createGeocodingSearchButton(options: GeocodingSearchButtonOptions): GeocodingSearchButtonHandle {
  const button = options.buttonContainer.createDiv('places-floating-button');
  button.setAttribute('aria-label', 'Search for Places');
  setIcon(button, 'search');

  const search = new MapGeocodingSearch(options.container, {
    searchPlaces: options.searchPlaces,
    onCreateNote: options.onCreateNote,
    centerOnPlace: options.centerOnPlace
      ? (place: Place) => options.centerOnPlace?.({ latitude: place.latitude, longitude: place.longitude, name: place.name, icon: '' })
      : undefined,
    resolveResultIcon: options.resolveResultIcon,
    getMapBounds: options.getMapBounds,
    onResultsChanged: (places: Place[]) => {
      // A result whose coordinates are still pending (Mapbox suggest) has no
      // real location yet - mapping its placeholder would drop a marker at 0,0.
      // It stays in the list; clicking it resolves and then places the marker.
      options.setGeocodingSearchMarkers(places.filter(place => !place.coordinatesPending).map((place, index) => ({
        id: `geocoding-search:${index}`,
        latitude: place.latitude,
        longitude: place.longitude,
        name: place.name,
        // Preview markers show the icon the note would get, resolved by the
        // place-note host's marker icon rules, and saving changes nothing visually.
        icon: options.resolveResultIcon(place),
        metadata: { geocodingSearchResult: place },
        actions: [{ id: CREATE_NOTE_ACTION_ID, label: '📝 Create note' }],
      })));
    },
    onClose: () => button.removeClass('is-active'),
    renderIcon: (iconContainer, iconSource) => setIcon(iconContainer, iconSource),
  });

  setMapContainerState(options.mapContainer, {
    geocodingToggle: {
      toggle: () => search.toggle(),
      isVisible: () => search.visible,
      onCloseCallback: () => button.removeClass('is-active'),
    },
  });

  button.addEventListener('click', () => {
    options.onBeforeOpen?.();
    search.toggle();
    button.toggleClass('is-active', search.visible);
  });

  return {
    button,
    isVisible: () => search.visible,
    hide: () => {
      search.hide();
      button.removeClass('is-active');
    },
  };
}
