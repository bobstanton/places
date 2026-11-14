import { logger } from "places-shared/utils";
import { App, SuggestModal, setIcon, debounce, Debouncer } from "obsidian";
import { Place } from "places-shared/place";
import { UnitsSystem, km, formatKmInSystem } from "places-shared/units";
import { Coordinate, DistanceCalculator, parseCoordinate } from "places-shared/geo";
import { renderSearchResult, SearchResultClasses } from "places-shared/map";
import { IPlacesService } from "places-shared/services";
import { AggregatorApiService } from "../places-services/AggregatorApiService";
import { refreshSuggestModal, renderPlaceAttributions, useTextInputHomeEndKeys } from "./SuggestModalKeymap";

export class ReverseGeocodeModal extends SuggestModal<Place> {
  callback: (place: Place) => void;
  service: IPlacesService;
  private results: Place[] = [];
  private coordinate: Coordinate | null = null;
  private initialCoordinate: Coordinate | undefined;
  private readonly debouncedSearch: Debouncer<[input: string], void>;
  private isSearching = false;
  private lastQuery = "";
  private isClosed = false;
  private units: UnitsSystem;

  constructor(app: App, service: IPlacesService, units: UnitsSystem, callback: (place: Place) => void, initialCoordinate?: Coordinate) {
    super(app);
    this.debouncedSearch = debounce(this.updateSearchResults.bind(this), 500);
    this.callback = callback;
    this.service = service;
    this.units = units;
    this.initialCoordinate = initialCoordinate;

    this.setPlaceholder("Enter coordinates: latitude, longitude (e.g., 40.7589, -73.9851)");
    
    if (this.service instanceof AggregatorApiService && !this.service.hasAvailableServices()) {
      this.emptyStateText = "No place lookup services are configured, install and enable at least one service.";
      refreshSuggestModal(this);
    } else {
      this.emptyStateText = "Enter valid coordinates to search for places.";
    }
  }

  onOpen() {
    useTextInputHomeEndKeys(this);

    if (this.initialCoordinate) {
      const coordString = `${this.initialCoordinate.latitude}, ${this.initialCoordinate.longitude}`;

      this.inputEl.value = coordString;
      this.lastQuery = coordString;
      void this.updateSearchResults(coordString);
    }
  }

  getSuggestions(query: string): Place[] {
    if (this.service instanceof AggregatorApiService && !this.service.hasAvailableServices()) {
      return [];
    }
    
    if (query !== this.lastQuery && !this.isSearching) {
      this.lastQuery = query;
      this.debouncedSearch(query);
    }

    return this.results;
  }

  renderSuggestion(place: Place, el: HTMLElement) {
    el.addClass("place-suggestion-item");

    renderSearchResult(el, place, {
      renderIcon: (iconContainer, source) => setIcon(iconContainer, source),
      showWebsite: true,
      showTags: true,
      renderCustomDetails: (contentContainer, p) => {
        if (this.coordinate) {
          const distance = DistanceCalculator.calculateDistanceBetween(this.coordinate, p);

          if (distance < 1000) { // km
            const distanceEl = contentContainer.createDiv({ cls: SearchResultClasses.website });
            const formattedDistance = formatKmInSystem(km(distance), this.units, distance < 1 ? 0 : 1);

            distanceEl.appendText(`${formattedDistance} away`);
          }
        }
      }
    });
  }

  onChooseSuggestion(place: Place, _evt: MouseEvent | KeyboardEvent) {
    this.callback(place);
  }

  onClose() {
    this.isClosed = true;
    this.isSearching = false;

    this.results = [];
  }

  private async updateSearchResults(input: string) {
    if (this.isSearching || this.isClosed) {
      return;
    }

    const coordinate = this.parseCoordinates(input.trim());
    
    if (!coordinate) {
      this.results = [];
      this.coordinate = null;
      refreshSuggestModal(this);

      return;
    }

    if (coordinate.latitude < -90 || coordinate.latitude > 90 || 
        coordinate.longitude < -180 || coordinate.longitude > 180) {
      this.results = [];
      this.coordinate = null;
      refreshSuggestModal(this);

      return;
    }

    this.coordinate = coordinate;
    this.isSearching = true;

    try {
      const results = await this.service.lookupPlaceByCoordinates(coordinate);
      
      if (this.isClosed) {
        return;
      }
      
      this.results = results;
    } catch (error) {
      logger.error("Reverse geocoding error:", error);

      if (!this.isClosed) {
        this.results = [];
      }
    } finally {
      this.isSearching = false;
    }

    if (!this.isClosed) {
      refreshSuggestModal(this);
    }

    if (!this.isClosed) {
      renderPlaceAttributions(this.resultContainerEl.parentElement, this.results);
    }
  }

  private parseCoordinates(input: string): Coordinate | null {
    const coord = parseCoordinate(input);

    if (coord) return coord;

    const cleaned = input.replace(/\s+/g, ' ').trim();
    const spaceMatch = cleaned.match(/^(-?\d+\.?\d*)\s+(-?\d+\.?\d*)$/);

    if (spaceMatch) {
      const lat = parseFloat(spaceMatch[1]);
      const lng = parseFloat(spaceMatch[2]);

      if (!isNaN(lat) && !isNaN(lng)) {
        return { latitude: lat, longitude: lng };
      }
    }

    return null;
  }
}
