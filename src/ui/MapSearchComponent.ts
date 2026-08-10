import { MapPlace } from "places-shared/place";
import { renderSearchResult } from "places-shared/map";

export interface SearchResult {
  place: MapPlace;
  index: number;
}

export interface MapSearchCallbacks {
  centerOnPlace: (place: MapPlace) => void;
  highlightPlace: (place: MapPlace) => void;
  onClose?: () => void;
  renderIcon?: (iconContainer: HTMLElement, iconName: string) => void;
}

export const SearchClasses = {
  container: 'places-geocoding-search',
  input: 'places-geocoding-input',
  results: 'places-geocoding-results',
  resultItem: 'places-geocoding-result-item',
  closeButton: 'places-geocoding-close',
  hidden: 'places-search-hidden',
  selectedResult: 'places-marker-search-selected',
} as const;

export class MapSearchComponent {
  private container: HTMLElement;
  private input!: HTMLInputElement;
  private resultsEl!: HTMLElement;

  private places: MapPlace[] = [];
  private results: SearchResult[] = [];
  private currentIndex = 0;
  private callbacks: MapSearchCallbacks;
  private isVisible = false;

  constructor(parentContainer: HTMLElement, callbacks: MapSearchCallbacks) {
    this.callbacks = callbacks;
    this.container = this.createSearchBar(parentContainer);
  }

  setPlaces(places: MapPlace[]): void {
    this.places = places;
    if (this.input.value) {
      this.performSearch(this.input.value);
    }
  }

  show(): void {
    this.container.removeClass(SearchClasses.hidden);
    this.isVisible = true;
    this.input.focus();
  }

  hide(): void {
    this.container.addClass(SearchClasses.hidden);
    this.isVisible = false;
    this.input.value = '';
    this.results = [];
    this.currentIndex = 0;
    this.resultsEl.empty();
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
    container.className = `${SearchClasses.container} ${SearchClasses.hidden}`;
    parent.insertBefore(container, parent.firstChild);

    this.input = container.createEl('input', {
      cls: SearchClasses.input,
      attr: {
        type: 'text',
        placeholder: 'Search markers...',
        spellcheck: 'false'
      }
    });

    const closeBtn = container.createDiv({ cls: SearchClasses.closeButton, text: '×' });
    closeBtn.setAttribute('aria-label', 'Close search');

    this.resultsEl = container.createDiv({ cls: SearchClasses.results });

    this.resultsEl.addEventListener('wheel', (e) => {
      const canScrollUp = this.resultsEl.scrollTop > 0;
      const canScrollDown = this.resultsEl.scrollTop < this.resultsEl.scrollHeight - this.resultsEl.clientHeight;
      if ((e.deltaY < 0 && canScrollUp) || (e.deltaY > 0 && canScrollDown)) {
        e.stopPropagation();
      } else if (this.resultsEl.scrollHeight > this.resultsEl.clientHeight) {
        e.stopPropagation();
      }
    }, { passive: true });

    this.resultsEl.addEventListener('touchmove', (e) => {
      e.stopPropagation();
    }, { passive: true });

    const stopEvent = (e: Event) => {
      e.stopPropagation();
      e.stopImmediatePropagation();
    };

    this.input.dataset.placesSearchInput = 'true';

    this.input.addEventListener('input', (e) => {
      stopEvent(e);
      this.performSearch(this.input.value);
    });

    this.input.addEventListener('keydown', (e) => {
      stopEvent(e);

      if (e.key === 'Enter') {
        if (this.results.length > 0) {
          this.navigateToResult(this.currentIndex);
        }
        e.preventDefault();
      } else if (e.key === 'Escape') {
        this.hide();
        e.preventDefault();
      } else if (e.key === 'ArrowUp') {
        this.selectPrev();
        e.preventDefault();
      } else if (e.key === 'ArrowDown') {
        this.selectNext();
        e.preventDefault();
      }
    });

    this.input.addEventListener('keyup', stopEvent);
    this.input.addEventListener('keypress', stopEvent);

    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      stopEvent(e);
      this.hide();
    });

    container.addEventListener('keydown', stopEvent);
    container.addEventListener('keyup', stopEvent);
    container.addEventListener('keypress', stopEvent);

    const documentKeyHandler = (e: KeyboardEvent) => {
      if (e.target === this.input) {
        e.stopPropagation();
        e.stopImmediatePropagation();
      }
    };
    activeDocument.addEventListener('keydown', documentKeyHandler, true);
    activeDocument.addEventListener('keyup', documentKeyHandler, true);
    activeDocument.addEventListener('keypress', documentKeyHandler, true);

    (this.input as unknown as Record<string, unknown>)._documentKeyHandler = documentKeyHandler;

    return container;
  }

  private performSearch(query: string): void {
    const normalizedQuery = query.toLowerCase().trim();

    if (!normalizedQuery) {
      this.results = [];
      this.currentIndex = 0;
      this.resultsEl.empty();
      return;
    }

    this.results = this.places
      .map((place, index) => ({ place, index }))
      .filter(({ place }) =>
        place.name.toLowerCase().includes(normalizedQuery)
      )
      .sort((a, b) => {
        const aStarts = a.place.name.toLowerCase().startsWith(normalizedQuery);
        const bStarts = b.place.name.toLowerCase().startsWith(normalizedQuery);
        if (aStarts !== bStarts) return aStarts ? -1 : 1;
        return 0;
      });

    this.currentIndex = 0;
    this.renderResults();

    if (this.results.length > 0) {
      this.navigateToResult(0);
    }
  }

  private renderResults(): void {
    this.resultsEl.empty();

    if (this.results.length === 0) {
      if (this.input.value.trim()) {
        this.resultsEl.createDiv({ cls: 'places-geocoding-no-results', text: 'No markers found' });
      }
      return;
    }

    this.results.forEach((result, displayIndex) => {
      const item = this.resultsEl.createDiv({ cls: SearchClasses.resultItem });
      item.setAttribute('data-index', String(displayIndex));

      if (displayIndex === this.currentIndex) {
        item.addClass(SearchClasses.selectedResult);
      }

      const placeForRenderer = {
        name: result.place.name,
        latitude: result.place.latitude,
        longitude: result.place.longitude,
        address: '',
        city: '',
        state: '',
        postalCode: '',
        country: '',
        website: '',
        tags: [],
        source: 'marker',
        attribution: ''
      };

      renderSearchResult(item, placeForRenderer, {
        renderIcon: this.callbacks.renderIcon ? (iconEl) => {
          if (result.place.icon) {
            iconEl.textContent = result.place.icon;
          } else if (this.callbacks.renderIcon) {
            this.callbacks.renderIcon(iconEl, 'target');
          }
        } : undefined,
        showWebsite: false,
        showTags: false
      });

      item.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.currentIndex = displayIndex;
        this.updateSelectedResult();
        this.navigateToResult(displayIndex);
      });
    });
  }

  private updateSelectedResult(): void {
    this.resultsEl.querySelectorAll(`.${SearchClasses.resultItem}`).forEach(item => {
      item.removeClass(SearchClasses.selectedResult);
    });

    const currentItem = this.resultsEl.querySelector(`[data-index="${this.currentIndex}"]`);
    if (currentItem) {
      currentItem.addClass(SearchClasses.selectedResult);
      currentItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  private selectNext(): void {
    if (this.results.length === 0) return;
    this.currentIndex = (this.currentIndex + 1) % this.results.length;
    this.updateSelectedResult();
    this.navigateToResult(this.currentIndex);
  }

  private selectPrev(): void {
    if (this.results.length === 0) return;
    this.currentIndex = (this.currentIndex - 1 + this.results.length) % this.results.length;
    this.updateSelectedResult();
    this.navigateToResult(this.currentIndex);
  }

  private navigateToResult(index: number): void {
    if (this.results.length === 0 || index < 0 || index >= this.results.length) return;

    const result = this.results[index];
    this.callbacks.centerOnPlace(result.place);
    this.callbacks.highlightPlace(result.place);

    this.input.focus();
  }

  destroy(): void {
    const handler = (this.input as unknown as Record<string, unknown>)._documentKeyHandler;
    if (handler) {
      activeDocument.removeEventListener('keydown', handler as EventListener, true);
      activeDocument.removeEventListener('keyup', handler as EventListener, true);
      activeDocument.removeEventListener('keypress', handler as EventListener, true);
    }
    this.container.remove();
  }
}
