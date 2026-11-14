import { Place } from "places-shared/place";
import { Coordinate, PlacesBoundingBox } from "places-shared/geo";
import { IPlacesService } from "places-shared/services";
import { ServiceCachingDecoratorBase, ICacheStorage } from "places-shared/utils";
import type { PartialPlacesResultsCallback } from "places-shared/services";

export class PlacesCachingDecorator
  extends ServiceCachingDecoratorBase
  implements IPlacesService
{
  constructor(private wrappedService: IPlacesService, private serviceName: string, cacheStorage: ICacheStorage, onCacheHit?: () => void) {
    super(cacheStorage, undefined, onCacheHit);
  }

  private normalizeQuery(query: string): string {
    return query.toLowerCase().trim().replace(/\s+/g, ' ');
  }

  private generateQueryCacheKey(query: string): string {
    return `${this.serviceName}:query:${this.normalizeQuery(query)}`;
  }

  private generateCoordCacheKey(coord: Coordinate): string {
    // Round coordinates to 5 decimal places (~1m precision)
    const lat = coord.latitude.toFixed(5);
    const lng = coord.longitude.toFixed(5);

    return `${this.serviceName}:coord:${lat},${lng}`;
  }

  private generateBoundsCacheKey(query: string, bounds: PlacesBoundingBox): string {
    const normalizedQuery = this.normalizeQuery(query);
    // Round bounds to 3 decimal places (~100m precision)
    const boundsKey = `${bounds.minLat.toFixed(3)},${bounds.minLng.toFixed(3)},${bounds.maxLat.toFixed(3)},${bounds.maxLng.toFixed(3)}`;

    return `${this.serviceName}:bounds:${normalizedQuery}:${boundsKey}`;
  }

  async lookupPlace(query: string, onPartialResults?: PartialPlacesResultsCallback): Promise<Place[]> {
    const cacheKey = this.generateQueryCacheKey(query);
    const results = await this.executeWithCache(cacheKey, () =>
      this.wrappedService.lookupPlace(query, onPartialResults)
    );

    onPartialResults?.(results);

    return results;
  }

  async lookupPlaceByCoordinates(coordinate: Coordinate): Promise<Place[]> {
    const cacheKey = this.generateCoordCacheKey(coordinate);

    return this.executeWithCache(cacheKey, () =>
      this.wrappedService.lookupPlaceByCoordinates(coordinate)
    );
  }

  async lookupPlaceInBounds(query: string, bounds: PlacesBoundingBox, onPartialResults?: PartialPlacesResultsCallback): Promise<Place[]> {
    if (!this.wrappedService.lookupPlaceInBounds) {
      return [];
    }

    const cacheKey = this.generateBoundsCacheKey(query, bounds);
    const results = await this.executeWithCache(cacheKey, () =>
      this.wrappedService.lookupPlaceInBounds!(query, bounds, onPartialResults)
    );

    onPartialResults?.(results);

    return results;
  }

  clearCache(): void {
    void this.clear();
  }
}
