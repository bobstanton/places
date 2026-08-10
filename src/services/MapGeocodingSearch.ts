import { logger } from "places-shared/utils";
import { Place } from "places-shared/place";
import { PlacesBoundingBox } from "places-shared/geo";
import { renderSearchResult } from "places-shared/map";
import type { PartialPlacesResultsCallback } from "places-shared/services";

export interface GeocodingSearchCallbacks {
  searchPlaces: (query: string, bounds: PlacesBoundingBox, onPartialResults?: PartialPlacesResultsCallback) => Promise<Place[]>;
  // Called when a result's create-note button is pressed
  onCreateNote: (place: Place) => void;
  // Called when a result row is clicked - focuses the map on that result's marker
  centerOnPlace?: (place: Place) => void;
  getMapBounds: () => PlacesBoundingBox;
  // Called when search bar is closed
  onClose?: () => void;
  renderIcon?: (iconContainer: HTMLElement, source: string) => void;
  // The marker-rule icon a result would get as a note, shown in the list
  resolveResultIcon?: (place: Place) => string;
  // Called whenever the result list changes (new results or cleared)
  onResultsChanged?: (places: Place[]) => void;
}

const GeocodingSearchClasses = {
  container: 'places-geocoding-search',
  input: 'places-geocoding-input',
  results: 'places-geocoding-results',
  resultItem: 'places-geocoding-result-item',
  closeButton: 'places-geocoding-close',
  refreshButton: 'places-geocoding-refresh',
  loading: 'places-geocoding-loading',
  hidden: 'places-search-hidden',
} as const;

// Searches within the current map bounding box using configured geocoding services.
export class MapGeocodingSearch {
  private container: HTMLElement;
  private input!: HTMLInputElement;
  private resultsEl!: HTMLElement;
  private loadingEl!: HTMLElement;

  private callbacks: GeocodingSearchCallbacks;
  private isVisible = false;
  private searchTimeout: number | null = null;
  private currentResults: Place[] = [];
  private lastSearchedQuery = '';
  private activeInputQuery = '';
  private abortController: AbortController | null = null;

  constructor(parentContainer: HTMLElement, callbacks: GeocodingSearchCallbacks) {
    this.callbacks = callbacks;
    this.container = this.createSearchBar(parentContainer);
  }

  show(): void {
    this.container.removeClass(GeocodingSearchClasses.hidden);
    this.isVisible = true;
    this.input.focus();
  }

  hide(): void {
    this.cancelPendingSearch();

    this.container.addClass(GeocodingSearchClasses.hidden);
    this.isVisible = false;
    this.input.value = '';
    this.currentResults = [];
    this.lastSearchedQuery = '';
    this.activeInputQuery = '';
    this.resultsEl.empty();
    this.callbacks.onResultsChanged?.([]);
    this.callbacks.onClose?.();
  }

  toggle(): void {
    if (this.isVisible) {
      this.hide();
    } else {
      this.show();
    }
  }

  get visible(): boolean {
    return this.isVisible;
  }

  private createSearchBar(parent: HTMLElement): HTMLElement {
    const container = parent.createDiv();
    container.className = `${GeocodingSearchClasses.container} ${GeocodingSearchClasses.hidden}`;
    parent.insertBefore(container, parent.firstChild);

    this.input = container.createEl('input', {
      cls: GeocodingSearchClasses.input,
      attr: {
        type: 'text',
        placeholder: 'Search for places',
        spellcheck: 'false'
      }
    });

    const refreshBtn = container.createDiv({ cls: GeocodingSearchClasses.refreshButton });
    refreshBtn.createSpan({ text: '↻' });
    refreshBtn.setAttribute('aria-label', 'Refresh search in current area');
    refreshBtn.setAttribute('title', 'Search in current map area');

    const closeBtn = container.createDiv({ cls: GeocodingSearchClasses.closeButton, text: '×' });
    closeBtn.setAttribute('aria-label', 'Close search');

    this.loadingEl = container.createDiv({ cls: GeocodingSearchClasses.loading });
    this.loadingEl.addClass('places-hidden');
    this.loadingEl.textContent = 'Searching...';

    this.resultsEl = container.createDiv({ cls: GeocodingSearchClasses.results });

    // Prevent wheel events on results from bubbling to map (which causes zoom)
    this.resultsEl.addEventListener('wheel', (e) => {
      const canScrollUp = this.resultsEl.scrollTop > 0;
      const canScrollDown = this.resultsEl.scrollTop < this.resultsEl.scrollHeight - this.resultsEl.clientHeight;

      if ((e.deltaY < 0 && canScrollUp) || (e.deltaY > 0 && canScrollDown)) {
        e.stopPropagation();
      }
    }, { passive: true });

    // Also prevent touch scroll from affecting map
    this.resultsEl.addEventListener('touchmove', (e) => {
      e.stopPropagation();
    }, { passive: true });

    const stopEvent = (e: Event) => {
      e.stopPropagation();
      e.stopImmediatePropagation();
    };

    this.input.addEventListener('input', (e) => {
      stopEvent(e);
      this.debouncedSearch(this.input.value);
    });

    this.input.addEventListener('focus', () => {
      this.expandResults();
    });

    this.input.addEventListener('keydown', (e) => {
      stopEvent(e);
      if (e.key === 'Escape') {
        this.hide();
        e.preventDefault();
      }
    });

    // Stop all keyboard events from reaching Obsidian
    this.input.addEventListener('keyup', stopEvent);
    this.input.addEventListener('keypress', stopEvent);

    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      stopEvent(e);
      this.hide();
    });

    refreshBtn.addEventListener('click', (e) => {
      e.preventDefault();
      stopEvent(e);
      this.refreshSearch();
    });

    container.addEventListener('keydown', stopEvent);
    container.addEventListener('keyup', stopEvent);
    container.addEventListener('keypress', stopEvent);
    container.addEventListener('focusout', () => {
      window.setTimeout(() => {
        if (!container.contains(activeDocument.activeElement)) {
          this.collapseResults();
        }
      }, 150);
    });
    container.addEventListener('focusin', () => {
      this.expandResults();
    });

    return container;
  }

  private collapseResults(): void {
    this.resultsEl.addClass('places-hidden');
  }

  private expandResults(): void {
    this.resultsEl.removeClass('places-hidden');
  }

  private debouncedSearch(query: string): void {
    this.cancelPendingSearch();

    const trimmedQuery = query.trim();
    this.activeInputQuery = trimmedQuery;
    this.currentResults = [];
    this.resultsEl.empty();
    this.expandResults();
    this.callbacks.onResultsChanged?.([]);

    if (trimmedQuery.length < 3) {
      this.lastSearchedQuery = '';
      return;
    }

    this.searchTimeout = window.setTimeout(() => {
      this.searchTimeout = null;
      void this.performSearch(trimmedQuery);
    }, 500);
  }

  // Refresh search with current query in current map bounds.
  private refreshSearch(): void {
    const query = this.input.value.trim();
    this.activeInputQuery = query;
    if (query.length >= 3) {
      this.cancelPendingSearch();
      void this.performSearch(query);
    }
  }

  private async performSearch(query: string): Promise<void> {
    this.lastSearchedQuery = query;

    const searchAbortController = new AbortController();
    this.abortController = searchAbortController;

    this.loadingEl.removeClass('places-hidden');
    this.resultsEl.empty();

    try {
      const bounds = this.callbacks.getMapBounds();
      const updateResultsIfCurrent = (results: Place[]) => {
        if (query !== this.lastSearchedQuery || query !== this.activeInputQuery || !this.isVisible) {
          return;
        }

        this.currentResults = results;
        this.renderResults();
        this.expandResults();
        this.callbacks.onResultsChanged?.(this.currentResults);
      };

      this.currentResults = await this.callbacks.searchPlaces(query, bounds, updateResultsIfCurrent);

      // Check if this search was superseded by a newer one (race condition guard)
      if (query !== this.lastSearchedQuery || query !== this.activeInputQuery || !this.isVisible) {
        return;
      }

      updateResultsIfCurrent(this.currentResults);
    } catch (error) {
      // Ignore abort errors - they're intentional
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }

      if (query !== this.lastSearchedQuery || query !== this.activeInputQuery || !this.isVisible) {
        return;
      }

      logger.error('Geocoding search error:', error);
      this.resultsEl.empty();
      this.resultsEl.createDiv({ text: 'Search failed.' });
      this.currentResults = [];
      this.callbacks.onResultsChanged?.([]);
    } finally {
      if (query === this.lastSearchedQuery && query === this.activeInputQuery) {
        this.loadingEl.addClass('places-hidden');
      }
      if (this.abortController === searchAbortController) {
        this.abortController = null;
      }
    }
  }

  private renderResults(): void {
    this.resultsEl.empty();

    if (this.currentResults.length === 0) {
      this.resultsEl.createDiv({ cls: 'places-geocoding-no-results', text: 'No results found in this area.' });
      return;
    }

    this.currentResults.forEach((place, index) => {
      const item = this.resultsEl.createDiv({ cls: GeocodingSearchClasses.resultItem });
      item.setAttribute('data-index', String(index));

      // Show the marker-rule icon the result's note would get: the row, the
      // preview marker, and the eventual note all agree.
      const ruleIcon = this.callbacks.resolveResultIcon?.(place);
      renderSearchResult(item, place, {
        renderIcon: ruleIcon
          ? (iconEl) => { iconEl.textContent = ruleIcon; }
          : this.callbacks.renderIcon,
        showWebsite: false,
        renderActions: (actionsEl) => {
          const createButton = actionsEl.createEl('button', { cls: 'places-button mod-cta places-geocoding-create-note', text: 'Create note' });
          createButton.setAttribute('aria-label', `Create note for ${place.name || 'this place'}`);
          createButton.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            void this.createNote(place);
          });
        },
      });

      // A row click only focuses the map on the result's preview marker;
      // creating a note takes the explicit button.
      item.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void this.focusResult(place);
      });
    });
  }

  private async focusResult(place: Place): Promise<void> {
    const resolved = await this.ensureCoordinates(place);
    // Still pending after a resolve attempt (the retrieve failed): centering
    // would fly to the placeholder 0,0.
    if (resolved.coordinatesPending) return;
    this.callbacks.centerOnPlace?.(resolved);
  }

  // Resolve a result whose coordinates are still pending (Mapbox suggest),
  // replacing it in the list: the resolution happens at most once and the
  // map gains its preview marker.
  private async ensureCoordinates(place: Place): Promise<Place> {
    if (!place.coordinatesPending || !place.resolvePlace) return place;
    const resolved = await place.resolvePlace();
    const index = this.currentResults.indexOf(place);
    if (index >= 0 && this.currentResults[index] === place) {
      this.currentResults[index] = resolved;
      this.callbacks.onResultsChanged?.(this.currentResults);
    }
    return resolved;
  }

  private async createNote(place: Place): Promise<void> {
    const withCoordinates = await this.ensureCoordinates(place);
    // Resolve place if needed (some APIs need additional calls)
    const resolvedPlace = withCoordinates.resolvePlace ? await withCoordinates.resolvePlace() : withCoordinates;
    this.callbacks.onCreateNote(resolvedPlace);
    this.hide();
  }

  destroy(): void {
    this.cancelPendingSearch();

    this.currentResults = [];
    this.lastSearchedQuery = '';
    this.activeInputQuery = '';
    this.callbacks.onResultsChanged?.([]);

    this.container.remove();
  }

  private cancelPendingSearch(): void {
    if (this.searchTimeout) {
      window.clearTimeout(this.searchTimeout);
      this.searchTimeout = null;
    }

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }
}
