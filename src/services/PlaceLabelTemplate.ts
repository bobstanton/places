import { PlaceholderResolver, SimpleContextProvider, obsidianHelpers } from 'placeholder-resolver';
import { applyContextOverrides } from 'places/core';
import type { MapPlace } from "places-shared/place";
import { buildPlaceTemplateContext } from "places-shared/map";
import { logger } from "places-shared/utils";

export { buildPlaceTemplateContext } from 'places-shared/obsidian/map';

// The shared resolver for place label templates (marker labels and path/overlay labels).
// Output is display text, not SQL: values are not escaped here; HTML callers (Leaflet)
// must escape at insertion. `{h.*}` exposes the generic helpers plus the obsidian
// helpers ({h.wikilink(...)} etc.).
export function createPlaceLabelResolver(place: MapPlace, overrides?: Record<string, unknown>): PlaceholderResolver {
  const context = buildPlaceTemplateContext(place);

  if (overrides) applyContextOverrides(context, overrides);

  return new PlaceholderResolver(new SimpleContextProvider(context), {
    escapeValue: (value) => value,
    prefix: 'this',
    customHelpers: obsidianHelpers,
    helpersName: 'h',
  });
}

export async function resolvePlaceLabelTemplate(place: MapPlace, template: string, resolver?: PlaceholderResolver): Promise<string> {
  const trimmed = (template ?? '').trim();

  if (!trimmed) return '';

  try {
    return (await (resolver ?? createPlaceLabelResolver(place)).resolve(trimmed)).trim();
  } catch (error) {
    logger.scope('Labels').warn('Label template failed to resolve', {
      template: trimmed,
      place: place.filePath ?? place.name,
      error: error instanceof Error ? error.message : String(error),
    });

    return '';
  }
}
