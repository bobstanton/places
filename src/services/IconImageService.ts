import { App } from "obsidian";
import type { MapPlace } from "places-shared/place";
import { defaultPictureShape } from "places-shared/map";
import { getErrorMessage, logger as rootLogger } from "places-shared/utils";
import { resolveLocalFile } from "places-shared/obsidian/utils";
import { createPlaceLabelResolver } from "./PlaceLabelTemplate";

const logger = rootLogger.scope("Places");

export interface IconImageResult {
  errors: string[];
}

export async function applyIconImages(app: App, places: MapPlace[], iconImage: string | undefined): Promise<IconImageResult> {
  const errors: string[] = [];
  let reported = 0;

  for (const place of places) {
    const template = (place.settings?.iconImage ?? iconImage)?.trim();

    if (!template) continue;

    try {
      const resolved = template.includes('{') ? (await createPlaceLabelResolver(place).resolve(template)).trim() : template;

      if (!resolved) continue;
      place.iconImage = resolved;
      const url = resolveLocalFile(app, resolved, place.filePath)?.url;

      if (!url) {
        if (reported < 3) {
          errors.push(`iconImage: "${resolved}" did not resolve to an image (${place.name || place.filePath || 'a place'}).`);
          reported++;
        }

        continue;
      }

      place.iconImageUrl = url;
      place.iconStyle = { ...(place.iconStyle ?? { inlineCss: '', classes: [] }), shape: place.iconImageStyle?.shape ?? defaultPictureShape() };
    } catch (error) {
      if (reported < 3) {
        errors.push(`iconImage: "${template}" failed for ${place.name || place.filePath || 'a place'}: ${getErrorMessage(error)}`);
        reported++;
      }
    }
  }

  if (errors.length > 0) logger.warn("iconImage errors", { count: errors.length });

  return { errors };
}
