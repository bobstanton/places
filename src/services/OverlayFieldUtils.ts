import { getErrorMessage, logger as rootLogger } from "places-shared/utils";
import { type OverlayLoadMetrics } from "../core/OverlayLoadMetrics";
import { MapPlaceOverlay } from "places-shared/place";
import { convertOverlaySourceToGeoJson } from '../core/gpx/OverlaySourceConverter';
import { StringCompressor } from "places-shared/utils";
import type { ScopedDebugLogger } from 'obsidian-debug-logger';

const defaultLogger = rootLogger.scope('Places');

export function buildOverlayFromFields(overlaySource?: string | Uint8Array, overlayCache?: string, path?: string, logger: ScopedDebugLogger = defaultLogger): MapPlaceOverlay | undefined {
  return buildOverlayFromFieldsDetailed(overlaySource, overlayCache, path, logger).overlay;
}

export function buildOverlayFromFieldsDetailed(overlaySource?: string | Uint8Array, overlayCache?: string, path?: string, logger: ScopedDebugLogger = defaultLogger, metrics?: OverlayLoadMetrics): { overlay?: MapPlaceOverlay; errors: string[] } {
  const errors: string[] = [];

  if (overlayCache) {
    try {
      const decompressed = decodeOverlayField(overlayCache, metrics);

      return { overlay: convertOverlaySourceToGeoJson(decompressed, 'geojson', { metrics, deferTrackData: true }), errors };
    } catch (error) {
      logger.warn(`Invalid Overlay Cache for ${path}; falling back to Overlay Source`, error);
      if (metrics && overlaySource) metrics.counts.cacheFallbacks++;
      errors.push(`Invalid Overlay Cache: ${getErrorMessage(error)}`);
    }
  }

  if (overlaySource) {
    try {
      if (typeof overlaySource !== 'string' && metrics) metrics.counts.binaryBytes += overlaySource.byteLength;
      const decompressed = typeof overlaySource === 'string' ? decodeOverlayField(overlaySource, metrics) : overlaySource;

      return { overlay: convertOverlaySourceToGeoJson(decompressed, undefined, { metrics, deferTrackData: true }), errors };
    } catch (error) {
      logger.warn(`Error building overlay from Overlay Source for ${path}`, error);
      errors.push(`Invalid Overlay Source: ${getErrorMessage(error)}`);
    }
  }

  return { errors };
}

function decodeOverlayField(value: string, metrics?: OverlayLoadMetrics): string {
  if (metrics) metrics.counts.storedChars += value.length;
  const decoded = metrics
    ? metrics.measure('decode', () => StringCompressor.decodeAndDecompress(value))
    : StringCompressor.decodeAndDecompress(value);

  if (metrics) {
    metrics.counts.decodedChars += decoded.length;

    if (decoded === value) metrics.counts.plainFields++;
    else metrics.counts.compressedFields++;
  }

  return decoded;
}
