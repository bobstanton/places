import { getErrorMessage, logger as rootLogger } from "places-shared/utils";
import { MapPlaceOverlay } from "places-shared/place";
import { convertOverlaySourceToGeoJson } from "./OverlaySourceConverter";
import { StringCompressor } from "places-shared/utils";
import type { ScopedDebugLogger } from 'obsidian-debug-logger';

const defaultLogger = rootLogger.scope('Places');

export function buildOverlayFromFields(overlaySource?: string, overlayCache?: string, path?: string, logger: ScopedDebugLogger = defaultLogger): MapPlaceOverlay | undefined {
  return buildOverlayFromFieldsDetailed(overlaySource, overlayCache, path, logger).overlay;
}

export function buildOverlayFromFieldsDetailed(overlaySource?: string, overlayCache?: string, path?: string, logger: ScopedDebugLogger = defaultLogger): { overlay?: MapPlaceOverlay; errors: string[] } {
  const errors: string[] = [];
  if (overlayCache) {
    try {
      const decompressed = StringCompressor.decodeAndDecompress(overlayCache);
      return { overlay: convertOverlaySourceToGeoJson(decompressed, 'geojson'), errors };
    } catch (error) {
      logger.warn(`Invalid Overlay Cache for ${path}; falling back to Overlay Source`, error);
      errors.push(`Invalid Overlay Cache: ${getErrorMessage(error)}`);
    }
  }

  if (overlaySource) {
    try {
      const decompressed = StringCompressor.decodeAndDecompress(overlaySource);
      return { overlay: convertOverlaySourceToGeoJson(decompressed), errors };
    } catch (error) {
      logger.warn(`Error building overlay from Overlay Source for ${path}`, error);
      errors.push(`Invalid Overlay Source: ${getErrorMessage(error)}`);
    }
  }

  return { errors };
}
