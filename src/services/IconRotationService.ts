import type { MapPlace } from "places-shared/place";
import { getErrorMessage, logger as rootLogger } from "places-shared/utils";
import { createPlaceLabelResolver } from "./PlaceLabelTemplate";

const logger = rootLogger.scope("Places");

export interface IconRotationResult {
  // At most 3 messages; one per place whose template produced something unusable.
  errors: string[];
}

// Resolve `iconRotation` onto each place as degrees clockwise from true north.
// The value is either a plain number, applied to every marker, or a per-place
// template resolved against that place's own data - the same context marker
// labels use: every column a query returns is available as `{this.column}`,
// and templates evaluate JavaScript expressions
// (`{(this.wind_direction_10m + 270) % 360}`).
export async function applyIconRotation(places: MapPlace[], iconRotation: string | undefined): Promise<IconRotationResult> {
  const template = iconRotation?.trim();
  if (!template) return { errors: [] };

  const constant = parseRotation(template);
  if (constant !== undefined) {
    for (const place of places) place.iconRotation = constant;
    return { errors: [] };
  }

  const errors: string[] = [];
  let reported = 0;
  for (const place of places) {
    try {
      const resolved = await createPlaceLabelResolver(place).resolve(template);
      const degrees = parseRotation(resolved);
      if (degrees === undefined) {
        if (reported < 3) {
          errors.push(`iconRotation: "${template}" gave "${resolved.trim()}" for ${place.name || place.filePath || "a place"}, which is not a number of degrees.`);
          reported++;
        }
        continue;
      }
      place.iconRotation = degrees;
    } catch (error) {
      if (reported < 3) {
        errors.push(`iconRotation: "${template}" failed for ${place.name || place.filePath || "a place"}: ${getErrorMessage(error)}`);
        reported++;
      }
    }
  }

  if (errors.length > 0) logger.warn("iconRotation template errors", { count: errors.length, template });
  return { errors };
}

// Degrees from a resolved template; values outside a turn, negatives included, wrap into 0-359.
export function parseRotation(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const degrees = Number(trimmed);
  if (!Number.isFinite(degrees)) return undefined;

  return ((degrees % 360) + 360) % 360;
}
