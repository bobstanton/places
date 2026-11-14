import { logger as rootLogger } from "places-shared/utils";
import { Place } from "places-shared/place";
import { Coordinate, PlacesBoundingBox } from "places-shared/geo";
import { shouldFilterPOI } from "places-shared/map";
import { IPlacesService } from "places-shared/services";
import type { PartialPlacesResultsCallback } from "places-shared/services";
import { ServiceTrackingDecoratorBase } from "../ServiceDecorators";
import { API_USAGE_SERVICES, type ApiUsageOrigin, type ApiUsageRecorder } from "places-shared/services";

const logger = rootLogger.scope('PlacesSearch');

export class PlacesTrackingDecorator
  extends ServiceTrackingDecoratorBase
  implements IPlacesService
{
  constructor(private wrappedService: IPlacesService, serviceName: string, recorder: ApiUsageRecorder, private getPoiFilterPatterns: () => string[], origin?: ApiUsageOrigin) {
    super(recorder, serviceName, API_USAGE_SERVICES.geocoding, origin);
  }

  async lookupPlace(query: string, onPartialResults?: PartialPlacesResultsCallback): Promise<Place[]> {
    logger.debug(`Query: "${query}"`);
    const results = await this.executeAndTrack(() => this.wrappedService.lookupPlace(query, results => {
      onPartialResults?.(this.filterPOIResults(results));
    }));

    return this.filterPOIResults(results);
  }

  async lookupPlaceByCoordinates(coordinate: Coordinate): Promise<Place[]> {
    logger.debug(`Reverse geocode: ${coordinate.latitude}, ${coordinate.longitude}`);
    const results = await this.executeAndTrack(() => this.wrappedService.lookupPlaceByCoordinates(coordinate));

    return this.filterPOIResults(results);
  }

  async lookupPlaceInBounds(query: string, bounds: PlacesBoundingBox, onPartialResults?: PartialPlacesResultsCallback): Promise<Place[]> {
    if (!this.wrappedService.lookupPlaceInBounds) {
      return [];
    }

    logger.debug(`Query in bounds: "${query}" (${bounds.minLat},${bounds.minLng} to ${bounds.maxLat},${bounds.maxLng})`);
    const results = await this.executeAndTrack(() => this.wrappedService.lookupPlaceInBounds!(query, bounds, results => {
      onPartialResults?.(this.filterPOIResults(results));
    }));

    return this.filterPOIResults(results);
  }

  private filterPOIResults(results: Place[]): Place[] {
    logger.debug('Raw results', results.map(p => ({
      name: p.name,
      address: p.address,
      city: p.city,
      tags: p.tags,
      lat: p.latitude,
      lng: p.longitude
    })));

    const patterns = this.getPoiFilterPatterns();

    if (!patterns || patterns.length === 0) {
      return results;
    }

    const filtered = results.filter(place => {
      const shouldFilter = shouldFilterPOI(patterns, {
        name: place.name,
        tags: place.tags,
      });

      if (shouldFilter) {
        logger.debug(`Filtered out: "${place.name}" (matched POI filter)`);
      }

      return !shouldFilter;
    });

    logger.debug(`After filtering: ${filtered.length}/${results.length} results`);

    return filtered;
  }
}
