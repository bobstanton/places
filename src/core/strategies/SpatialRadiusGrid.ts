import { Coordinate, DistanceCalculator } from "places-shared/worker-safe";
import { METERS_PER_DEGREE_LAT } from "./spatial";
import { SpatialUtils } from "./SpatialUtils";

export interface SpatialRadiusGridResult<T> {
  data: T;
  distance: number;
}

export class SpatialRadiusGrid<T> {
  private grid: Map<string, Array<{ lat: number; lon: number; data: T }>> = new Map();

  constructor(private cellSizeDegrees: number) {}

  static fromCellSizeMeters<T>(cellSizeMeters: number): SpatialRadiusGrid<T> {
    return new SpatialRadiusGrid<T>(Math.max(0.0001, cellSizeMeters / METERS_PER_DEGREE_LAT));
  }

  add(lat: number, lon: number, data: T): void {
    const key = this.getCellKey(lat, lon);
    let bucket = this.grid.get(key);

    if (!bucket) {
      bucket = [];
      this.grid.set(key, bucket);
    }

    bucket.push({ lat, lon, data });
  }

  addCoordinate(coordinate: Coordinate, data: T): void {
    this.add(coordinate.latitude, coordinate.longitude, data);
  }

  findNearby(lat: number, lon: number, maxDistanceM: number): Array<SpatialRadiusGridResult<T>> {
    const results: Array<SpatialRadiusGridResult<T>> = [];
    const cellLat = Math.floor(lat / this.cellSizeDegrees);
    const cellLon = Math.floor(lon / this.cellSizeDegrees);
    const { latSpan, lonSpan } = SpatialUtils.neighborCellSpan(lat, maxDistanceM, this.cellSizeDegrees);

    for (let dLat = -latSpan; dLat <= latSpan; dLat++) {
      for (let dLon = -lonSpan; dLon <= lonSpan; dLon++) {
        const bucket = this.grid.get(`${cellLat + dLat},${cellLon + dLon}`);

        if (!bucket) continue;

        for (const item of bucket) {
          const distance = DistanceCalculator.haversineDistanceMeters(lat, lon, item.lat, item.lon);

          if (distance <= maxDistanceM) {
            results.push({ data: item.data, distance });
          }
        }
      }
    }

    return results;
  }

  findNearest(lat: number, lon: number, maxDistanceM: number): SpatialRadiusGridResult<T> | null {
    let nearest: SpatialRadiusGridResult<T> | null = null;

    for (const result of this.findNearby(lat, lon, maxDistanceM)) {
      if (!nearest || result.distance < nearest.distance) {
        nearest = result;
      }
    }

    return nearest;
  }

  clear(): void {
    this.grid.clear();
  }

  private getCellKey(lat: number, lon: number): string {
    return SpatialUtils.degreeGridKey(lat, lon, this.cellSizeDegrees);
  }
}
