import { Coordinate, DistanceCalculator } from "places-shared/worker-safe";
import { SpatialUtils } from "./SpatialUtils";

interface IndexedEdge {
  start: Coordinate;
  end: Coordinate;
  trackIndex: number;
}

// Spatial index over polyline edges (line segments between consecutive track points).
// Queries measure point-to-segment distance; a track whose point spacing exceeds the
// query radius still matches where a segment passes within range (SpatialRadiusGrid,
// indexing points only, misses it).
export class SpatialEdgeGrid {
  private grid: Map<string, IndexedEdge[]> = new Map();

  constructor(private readonly cellSizeDegrees: number) {}

  addPolyline(coordinates: Coordinate[], trackIndex: number): void {
    for (let i = 0; i < coordinates.length - 1; i++) {
      const edge: IndexedEdge = { start: coordinates[i], end: coordinates[i + 1], trackIndex };
      const latCellA = Math.floor(edge.start.latitude / this.cellSizeDegrees);
      const lonCellA = Math.floor(edge.start.longitude / this.cellSizeDegrees);
      const latCellB = Math.floor(edge.end.latitude / this.cellSizeDegrees);
      const lonCellB = Math.floor(edge.end.longitude / this.cellSizeDegrees);

      const minLatCell = Math.min(latCellA, latCellB);
      const maxLatCell = Math.max(latCellA, latCellB);
      const minLonCell = Math.min(lonCellA, lonCellB);
      const maxLonCell = Math.max(lonCellA, lonCellB);

      for (let latCell = minLatCell; latCell <= maxLatCell; latCell++) {
        for (let lonCell = minLonCell; lonCell <= maxLonCell; lonCell++) {
          const key = `${latCell},${lonCell}`;
          let bucket = this.grid.get(key);
          if (!bucket) {
            bucket = [];
            this.grid.set(key, bucket);
          }
          bucket.push(edge);
        }
      }
    }
  }

  // Returns the distinct track indices whose polyline passes within maxDistanceM of the point.
  findTracksNear(point: Coordinate, maxDistanceM: number): Set<number> {
    const found = new Set<number>();
    this.forEachCandidateEdge(point, maxDistanceM, edge => {
      if (found.has(edge.trackIndex)) return;
      if (DistanceCalculator.pointToSegmentDistanceMeters(point, edge.start, edge.end) <= maxDistanceM) {
        found.add(edge.trackIndex);
      }
    });
    return found;
  }

  private forEachCandidateEdge(point: Coordinate, maxDistanceM: number, visit: (edge: IndexedEdge) => void): void {
    const { latSpan, lonSpan } = SpatialUtils.neighborCellSpan(point.latitude, maxDistanceM, this.cellSizeDegrees);
    const centerLatCell = Math.floor(point.latitude / this.cellSizeDegrees);
    const centerLonCell = Math.floor(point.longitude / this.cellSizeDegrees);

    for (let dLat = -latSpan; dLat <= latSpan; dLat++) {
      for (let dLon = -lonSpan; dLon <= lonSpan; dLon++) {
        const bucket = this.grid.get(`${centerLatCell + dLat},${centerLonCell + dLon}`);
        if (!bucket) continue;
        for (const edge of bucket) {
          visit(edge);
        }
      }
    }
  }

  clear(): void {
    this.grid.clear();
  }
}
