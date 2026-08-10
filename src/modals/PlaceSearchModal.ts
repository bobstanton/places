import { logger } from "places-shared/utils";
import { App, SuggestModal, setIcon, debounce, Debouncer, prepareFuzzySearch } from "obsidian";
import { Place } from "places-shared/place";
import { renderSearchResult } from "places-shared/map";
import { IPlacesService, parseNearQuery } from "places-shared/services";
import { AggregatorApiService } from "../places-services/AggregatorApiService";
import { refreshSuggestModal, renderPlaceAttributions, useTextInputHomeEndKeys } from "./SuggestModalKeymap";

// A "near"/"in" query scores by its POI name only.
function calculateResultScore(place: Place, query: string): number {
  const parsed = parseNearQuery(query);
  const searchTerm = parsed ? parsed.poi : query;
  const fuzzySearch = prepareFuzzySearch(searchTerm);

  const nameMatch = place.name ? fuzzySearch(place.name) : null;
  if (nameMatch) {
    return 1000 + nameMatch.score;
  }

  const addressMatch = place.address ? fuzzySearch(place.address) : null;
  if (addressMatch) {
    return 500 + addressMatch.score;
  }

  return 0;
}

export class PlaceSearchModal extends SuggestModal<Place> {
  callback: (place: Place) => void;
  service: IPlacesService;
  private results: Place[] = [];
  private query: string = "";
  private searchVersion: number = 0;  // Incremented per search; results from a superseded search are discarded
  private debouncedSearch: Debouncer<[query: string], void>;

  constructor(app: App, service: IPlacesService, initialQuery: string, callback: (place: Place) => void) {
    super(app);
    this.debouncedSearch = debounce(this.executeSearch.bind(this), 500, true);
    this.callback = callback;
    this.service = service;

    this.setPlaceholder("Search for Places by name, address, or category...");
    if (this.service instanceof AggregatorApiService && !this.service.hasAvailableServices()) {
      this.emptyStateText = "No place lookup services are configured, install and enable at least one service.";
      refreshSuggestModal(this);
    }
    else {
      this.emptyStateText = "No results found.";
    }

    if (initialQuery) {
      this.query = initialQuery;
      void this.executeSearch(initialQuery);
    }
  }

  onOpen() {
    this.inputEl.value = this.query;
    useTextInputHomeEndKeys(this);
  }

  getSuggestions(query: string): Place[] {
    if (this.service instanceof AggregatorApiService && !this.service.hasAvailableServices()) {
      return [];
    }

    if (query !== this.query) {
      this.query = query;
      this.debouncedSearch(query);
    }

    // Re-sort cached results while the debounced API call is pending.
    if (this.results.length > 0 && query.length > 0) {
      const scored = this.results.map(place => ({
        place,
        score: calculateResultScore(place, query)
      }));
      scored.sort((a, b) => b.score - a.score);
      return scored.map(s => s.place);
    }

    return this.results;
  }

  private async executeSearch(query: string): Promise<void> {
    const version = ++this.searchVersion;

    const updateIfCurrent = (results: Place[]) => {
      if (version !== this.searchVersion) return;
      this.results = results;
      refreshSuggestModal(this);
      this.updateAttributions();
    };

    try {
      const results = this.service instanceof AggregatorApiService
        ? await this.service.lookupPlace(query, updateIfCurrent)
        : await this.service.lookupPlace(query);

      updateIfCurrent(results);
    } catch (error) {
      logger.error(`Search v${version} failed:`, error);
    }
  }

  private updateAttributions(): void {
    renderPlaceAttributions(this.resultContainerEl.parentElement, this.results);
  }

  renderSuggestion(place: Place, el: HTMLElement) {
    el.addClass("place-suggestion-item");

    renderSearchResult(el, place, {
      renderIcon: (iconContainer, source) => setIcon(iconContainer, source),
      showWebsite: true,
      showTags: true
    });
  }

  onChooseSuggestion(place: Place, _evt: MouseEvent | KeyboardEvent): void {
    // Mapbox requires an extra call to get lat/lon.
    void (async () => {
      const resolvedPlace = place.resolvePlace ? await place.resolvePlace() : place;
      this.callback(resolvedPlace);
    })();
  }
}
