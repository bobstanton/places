import { Coordinate, DEG_TO_RAD } from "places-shared/worker-safe";
import { METERS_PER_DEGREE_LAT, MIN_COS_LATITUDE } from "../constants/spatial";

export class SpatialUtils {
  // Meters per degree of longitude at the given latitude (floored near the poles).
  static metersPerDegreeLon(lat: number): number {
    return METERS_PER_DEGREE_LAT * Math.max(MIN_COS_LATITUDE, Math.cos(lat * DEG_TO_RAD));
  }

  // Latitude-aware grid key ("gridX,gridY") for a metre-sized cell.
  static getGridKey(lat: number, lng: number, cellSizeMeters: number): string {
    const { gridX, gridY } = this.getGridCoordinates(lat, lng, cellSizeMeters);
    return `${gridX},${gridY}`;
  }

  // Cell size in degrees for a metre-sized cell, scaling longitude by avgLatitude.
  static getCellSizeDegrees(cellSizeMeters: number, avgLatitude: number = 0): { cellLatDeg: number; cellLngDeg: number } {
    return {
      cellLatDeg: cellSizeMeters / METERS_PER_DEGREE_LAT,
      cellLngDeg: cellSizeMeters / this.metersPerDegreeLon(avgLatitude),
    };
  }

  // Integer grid cell (gridX, gridY) for a location on a metre-sized grid.
  static getGridCoordinates(lat: number, lng: number, cellSizeMeters: number): { gridX: number; gridY: number } {
    return {
      gridX: Math.floor((lng * this.metersPerDegreeLon(lat)) / cellSizeMeters),
      gridY: Math.floor((lat * METERS_PER_DEGREE_LAT) / cellSizeMeters),
    };
  }

  // Cell key ("latCell,lonCell") for a grid whose cells are measured in degrees.
  static degreeGridKey(lat: number, lon: number, cellSizeDegrees: number): string {
    return `${Math.floor(lat / cellSizeDegrees)},${Math.floor(lon / cellSizeDegrees)}`;
  }

  // Neighbour-cell span (in cells, each direction) needed to cover maxDistanceM around lat on a degree-sized grid.
  static neighborCellSpan(lat: number, maxDistanceM: number, cellSizeDegrees: number): { latSpan: number; lonSpan: number } {
    const radiusDegLat = maxDistanceM / METERS_PER_DEGREE_LAT;
    const radiusDegLon = maxDistanceM / this.metersPerDegreeLon(lat);
    return {
      latSpan: Math.max(1, Math.ceil(radiusDegLat / cellSizeDegrees)),
      lonSpan: Math.max(1, Math.ceil(radiusDegLon / cellSizeDegrees)),
    };
  }

  // Axis-aligned bounding box of the coordinates (zeroed when empty).
  static calculateBounds(coordinates: Coordinate[]): { minLat: number; maxLat: number; minLng: number; maxLng: number } {
    if (coordinates.length === 0) {
      return { minLat: 0, maxLat: 0, minLng: 0, maxLng: 0 };
    }

    let minLat = Infinity, maxLat = -Infinity;
    let minLng = Infinity, maxLng = -Infinity;

    for (const coord of coordinates) {
      minLat = Math.min(minLat, coord.latitude);
      maxLat = Math.max(maxLat, coord.latitude);
      minLng = Math.min(minLng, coord.longitude);
      maxLng = Math.max(maxLng, coord.longitude);
    }

    return { minLat, maxLat, minLng, maxLng };
  }

  // Arithmetic-mean centroid of the coordinates (zeroed when empty).
  static calculateCentroid(coordinates: Coordinate[]): Coordinate {
    if (coordinates.length === 0) {
      return { latitude: 0, longitude: 0 };
    }

    let sumLat = 0;
    let sumLng = 0;
    for (const coord of coordinates) {
      sumLat += coord.latitude;
      sumLng += coord.longitude;
    }

    return {
      latitude: sumLat / coordinates.length,
      longitude: sumLng / coordinates.length
    };
  }
}
