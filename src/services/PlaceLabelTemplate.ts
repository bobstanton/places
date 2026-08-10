import { PlaceholderResolver, SimpleContextProvider, obsidianHelpers } from 'placeholder-resolver';
import type { MapPlace } from 'places-shared/place';
import { getFileNameWithoutExtension, logger } from 'places-shared/utils';

const KNOWN_PLACE_CONTEXT_KEYS = new Set([
  'name',
  'originalName',
  'title',
  'filename',
  'path',
  'icon',
  'latitude',
  'longitude',
  'tags',
]);

function setAlias(context: Record<string, unknown>, key: string, value: unknown): void {
  if (!key || key in context || KNOWN_PLACE_CONTEXT_KEYS.has(key)) return;
  context[key] = value;
}

function toTitleCaseFrontmatterKey(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function addFrontmatterAliases(context: Record<string, unknown>, metadata: Record<string, unknown> | undefined): void {
  if (!metadata) return;

  for (const [key, value] of Object.entries(metadata)) {
    setAlias(context, key.toLowerCase(), value);
    setAlias(context, key.replace(/\s+/g, '_').toLowerCase(), value);

    if (key === key.toLowerCase() || /[_-]/.test(key)) {
      setAlias(context, toTitleCaseFrontmatterKey(key), value);
    }
  }
}

// Build the flat placeholder context for a place's label templates.
//
// Everything a template can reference is already materialized on the MapPlace: query results carry
// the note's full frontmatter on `metadata` (the `places`/notes_with_properties view selects it),
// plus name, tags, coordinates and path. Resolution never re-reads the vault.
//
// Frontmatter is flattened to the top level, where `{this.Distance}` / `{this['Elevation Gain']}`
// resolve, matching the query-template surface. The known place fields are layered on top: the
// built-ins (name/title/path/tags/...) always win over a frontmatter key of the same name.
export function buildPlaceTemplateContext(place: MapPlace): Record<string, unknown> {
  const filename = getFileNameWithoutExtension(place.filePath, place.name, /\.md$/i);
  const context: Record<string, unknown> = {
    ...(place.queryRow ?? {}),
    ...(place.metadata ?? {}),
    name: place.name,
    originalName: place.originalName ?? place.name,
    title: filename,
    filename,
    path: place.filePath ?? '',
    icon: place.icon,
    latitude: place.latitude,
    longitude: place.longitude,
    tags: place.tags ?? [],
  };

  addFrontmatterAliases(context, place.queryRow);
  addFrontmatterAliases(context, place.metadata);
  return context;
}

// Overwrite context values under every spelling `buildPlaceTemplateContext`
// exposes: a template written `{this.Distance}`, `{this.distance}`, or
// `{this.total_points}` all see the override instead of the note-wide value.
function applyContextOverrides(context: Record<string, unknown>, overrides: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(overrides)) {
    if (KNOWN_PLACE_CONTEXT_KEYS.has(key)) continue;
    context[key] = value;
    context[key.toLowerCase()] = value;
    context[key.replace(/\s+/g, '_').toLowerCase()] = value;
    context[toTitleCaseFrontmatterKey(key)] = value;
  }
}

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

// Resolve a label template against a place, returning display text. Returns '' for an empty template
// or on failure (callers that need error reporting build the resolver via createPlaceLabelResolver).
export async function resolvePlaceLabelTemplate(
  place: MapPlace,
  template: string,
  overrides?: Record<string, unknown>,
): Promise<string> {
  const trimmed = (template ?? '').trim();
  if (!trimmed) return '';
  try {
    return (await createPlaceLabelResolver(place, overrides).resolve(trimmed)).trim();
  } catch (error) {
    // A label that cannot resolve renders as nothing, which on a map is
    // indistinguishable from a label that was never configured. Say so.
    logger.scope('Labels').warn('Label template failed to resolve', {
      template: trimmed,
      place: place.filePath ?? place.name,
      error: error instanceof Error ? error.message : String(error),
    });
    return '';
  }
}
