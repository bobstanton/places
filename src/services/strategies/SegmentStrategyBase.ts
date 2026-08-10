import { MapPlace, createSegmentOverlayPlace, createBoundsAnchors } from "places-shared/worker-safe";
import { FrequencyAnalysisResult, FrequencySegment } from "./IFrequencyStrategy";
import { FrequencyVisualizationUtils } from "../FrequencyVisualizationUtils";

interface SegmentStrategyRenderConfig {
  spatialOverlapCellSizeDegrees: number;
  spatialOverlapSamplesPerSegment: number;
}

const DEFAULT_SEGMENT_STRATEGY_RENDER_CONFIG: SegmentStrategyRenderConfig = {
  spatialOverlapCellSizeDegrees: 0.001, // ~100m near the equator.
  spatialOverlapSamplesPerSegment: 20,
};

export abstract class SegmentStrategyBase {
  convertToMapPlaces(result: FrequencyAnalysisResult, colorScheme: string, lineThickness: number = 3, lineStyle?: string, fixedOpacity?: number): MapPlace[] {
    const places: MapPlace[] = [];
    const { segments } = result;

    const polylineOpacity = fixedOpacity !== undefined
      ? fixedOpacity
      : (this.getDefaultOpacity() ?? this.calculateOpacityFromSpatialOverlap(segments));

    let minLat = Infinity, maxLat = -Infinity;
    let minLng = Infinity, maxLng = -Infinity;

    for (const segment of segments) {
      for (const c of segment.coordinates) {
        minLat = Math.min(minLat, c.latitude);
        maxLat = Math.max(maxLat, c.latitude);
        minLng = Math.min(minLng, c.longitude);
        maxLng = Math.max(maxLng, c.longitude);
      }

      const color = FrequencyVisualizationUtils.getFrequencyColor(segment.normalizedScore, colorScheme);

      const segCoords = segment.coordinates;
      const geoJsonCoords = new Array<[number, number]>(segCoords.length);
      for (let i = 0; i < segCoords.length; i++) {
        geoJsonCoords[i] = [segCoords[i].longitude, segCoords[i].latitude];
      }

      places.push(createSegmentOverlayPlace({
        coordinates: geoJsonCoords,
        color,
        weight: lineThickness,
        opacity: polylineOpacity,
        style: lineStyle ? 'dashed' : 'solid',
        name: "Frequency: " + segment.frequency,
        metadata: { frequency: segment.frequency, contributingFiles: segment.contributingFiles || [] }
      }));
    }

    places.push(...createBoundsAnchors({ minLat, maxLat, minLng, maxLng }));

    return places;
  }

  protected abstract getStrategyName(): string;

  protected getDefaultOpacity(): number | undefined { return undefined; }

  private calculateOpacityFromSpatialOverlap(segments: FrequencySegment[]): number {
    if (segments.length === 1) return 1.0;
    const { spatialOverlapCellSizeDegrees, spatialOverlapSamplesPerSegment } = DEFAULT_SEGMENT_STRATEGY_RENDER_CONFIG;
    const getCellKey = (lat: number, lon: number) => `${Math.floor(lat / spatialOverlapCellSizeDegrees)},${Math.floor(lon / spatialOverlapCellSizeDegrees)}`;
    const grid = new Map<string, Set<number>>();
    for (let i = 0; i < segments.length; i++) {
      const coords = segments[i].coordinates;
      const step = Math.max(1, Math.floor(coords.length / spatialOverlapSamplesPerSegment));
      for (let j = 0; j < coords.length; j += step) {
        const k = getCellKey(coords[j].latitude, coords[j].longitude);
        if (!grid.has(k)) grid.set(k, new Set());
        grid.get(k)!.add(i);
      }
      if (coords.length > 1) {
        for (const endpoint of [coords[0], coords[coords.length - 1]]) {
          const key = getCellKey(endpoint.latitude, endpoint.longitude);
          if (!grid.has(key)) grid.set(key, new Set());
          grid.get(key)!.add(i);
        }
      }
    }
    let maxInCell = 1;
    for (const s of grid.values()) maxInCell = Math.max(maxInCell, s.size);
    return 1 / maxInCell;
  }
}
