import type * as GeoJSON from 'geojson';
import { MapPlace, scalarToString, parseTrackLineStyle, dashArrayToPixels, parseDashArray } from "places-shared/worker-safe";
import { readNormalizedProperty } from 'places-shared/utils';
import { FrequencyAnalysisResult } from './IFrequencyStrategy';

export interface HeatmapExportStyle {
  lineWidth?: number;
  lineStyle?: string;
}

export function buildHeatmapExportGeoJson(result: FrequencyAnalysisResult, mapPlaces: MapPlace[], style: HeatmapExportStyle): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: result.segments.map((segment, index): GeoJSON.Feature => {
      const mapPlace = mapPlaces[index];
      const isPoint = segment.coordinates.length === 1;

      const geometry: GeoJSON.Geometry = isPoint
        ? {
            type: 'Point',
            coordinates: [segment.coordinates[0].longitude, segment.coordinates[0].latitude]
          }
        : {
            type: 'LineString',
            coordinates: segment.coordinates.map(coord => [coord.longitude, coord.latitude])
          };

      const overlayStyle = mapPlace?.overlay?.style;
      const rawOverlayFeatureProps: unknown = mapPlace?.overlay?.geojson?.features?.[0]?.properties;
      const overlayFeatureProps = rawOverlayFeatureProps !== null && typeof rawOverlayFeatureProps === 'object' && !Array.isArray(rawOverlayFeatureProps)
        ? rawOverlayFeatureProps as Record<string, unknown>
        : {};
      const overlayStroke = scalarToString(overlayFeatureProps.stroke);
      const overlayStrokeWidth = typeof overlayFeatureProps['stroke-width'] === 'number' ? overlayFeatureProps['stroke-width'] : undefined;
      const overlayStrokeOpacity = typeof overlayFeatureProps['stroke-opacity'] === 'number' ? overlayFeatureProps['stroke-opacity'] : undefined;
      const weight = overlayStyle?.weight ?? overlayStrokeWidth ?? style.lineWidth ?? 3;
      const overlayDashArray = overlayFeatureProps['stroke-dasharray'];
      const dashArray = overlayStyle?.dashArray !== undefined
        ? dashArrayToPixels(parseDashArray(overlayStyle.dashArray), weight)
        : typeof overlayDashArray === 'string' ? overlayDashArray
        : dashArrayToPixels(parseTrackLineStyle(style.lineStyle).dashArray, weight);

      return {
        type: 'Feature',
        geometry,
        properties: {
          frequency: segment.frequency,
          normalizedScore: segment.normalizedScore,
          contributingFiles: segment.contributingFiles || [],
          ...(isPoint
            ? {
                'marker-color': overlayStyle?.color || '#FF0000',
                'marker-size': 'medium',
                'marker-symbol': '',
                weight: readNormalizedProperty(mapPlace?.metadata, 'heatmapWeight') || segment.frequency
              }
            : {
                stroke: overlayStyle?.color || overlayStroke || '#FF0000',
                'stroke-width': weight,
                'stroke-opacity': overlayStyle?.opacity ?? overlayStrokeOpacity ?? 1.0,
                'stroke-dasharray': dashArray
              })
        }
      };
    })
  };
}

export const HEATMAP_EXPORT_MIME_TYPE = 'application/geo+json';

export function heatmapExportFilename(strategy: string, at: number = Date.now()): string {
  return `frequency-analysis-${strategy}-${at}.geojson`;
}
