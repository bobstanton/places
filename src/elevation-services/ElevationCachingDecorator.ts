import { Coordinate } from "places-shared/geo";
import { IElevationService, ElevationProfile } from "places-shared/services";
import { ServiceCachingDecoratorBase, ICacheStorage } from "places-shared/utils";

export class ElevationCachingDecorator
  extends ServiceCachingDecoratorBase
  implements IElevationService
{
  constructor(private wrappedService: IElevationService, private serviceName: string, cacheStorage: ICacheStorage) {
    super(cacheStorage);
  }

  getProviderName(): string {
    return this.wrappedService.getProviderName();
  }

  private generateCoordinatesCacheKey(prefix: string, coordinates: Coordinate[]): string {
    // Round to 5 decimal places (~1 m); near-identical coordinate lists share a key.
    const keyBase = coordinates
      .map(coord => `${coord.latitude.toFixed(5)},${coord.longitude.toFixed(5)}`)
      .join("|");
    return `${this.serviceName}:${prefix}:${keyBase}`;
  }

  async getElevationProfile(coordinates: Coordinate[]): Promise<ElevationProfile> {
    const cacheKey = this.generateCoordinatesCacheKey("profile", coordinates);
    return this.executeWithCache(cacheKey, () =>
      this.wrappedService.getElevationProfile(coordinates)
    );
  }

  clearCache(): void {
    void this.clear();
  }
}
