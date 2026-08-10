import type { App } from 'obsidian';
import type { MapPlace } from 'places-shared/overlay';
import { resolveMarkerIcon } from 'places-shared/map';
import { parseNamedCoordinate } from 'places-shared/geo';
import { normalizePropertyName } from 'places-shared/settings';
import { scalarToString } from 'places-shared/utils';
import { decodeOverlayFieldsDetailedCached } from './OverlayDecodeCache';
import { TrackStyleParser } from './TrackStyleParser';

// Case- and separator-insensitive access to note/query properties.
export class PlacePropertyReader {
  private readonly values = new Map<string, unknown>();

  constructor(properties: Record<string, unknown>) {
    for (const [key, value] of Object.entries(properties)) {
      const normalized = normalizePropertyName(key);
      if (!this.values.has(normalized) || this.values.get(normalized) == null) this.values.set(normalized, value);
    }
  }

  get(key: string): unknown { return this.values.get(normalizePropertyName(key)); }
}

export interface MapPlaceFactoryOptions {
  app: App;
  properties: Record<string, unknown>;
  name: string;
  filePath?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

// The one construction path for property-backed map places.
export function createMapPlaceFromProperties(options: MapPlaceFactoryOptions): MapPlace | null {
  const reader = new PlacePropertyReader(options.properties);
  const coordinates = parseNamedCoordinate(reader.get('location'));
  if (!coordinates) return null;

  const tags = options.tags ?? toTagList(reader.get('tags'));
  const place: MapPlace = {
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
    name: options.name,
    icon: resolveMarkerIcon(reader.get('icon')),
    tags,
    metadata: options.metadata ?? { ...options.properties },
  };
  if (options.filePath) place.filePath = options.filePath;

  const overlaySource = scalarToString(reader.get('overlay source')) || undefined;
  const overlayCache = scalarToString(reader.get('overlay cache')) || undefined;
  if (overlaySource || overlayCache) {
    const decoded = decodeOverlayFieldsDetailedCached(options.app, options.filePath, overlaySource, overlayCache, readStatHint(reader));
    place.overlay = decoded.overlay;
    if (decoded.errors.length > 0) {
      place.metadata ??= {};
      place.metadata._overlayLoadErrors = decoded.errors;
    }
  }
  // Same flattened name as the resolved config field, same `visible`/`hidden`
  // vocabulary as the block's `track.defaultVisibility`. The retired
  // `showOverlay` and `defaultVisibility` spellings are deliberately not accepted.
  const visibility = scalarToString(reader.get('trackDefaultVisibility')).trim().toLowerCase();
  if (visibility === 'visible' || visibility === 'hidden') place.trackDefaultVisibility = visibility;
  TrackStyleParser.applyFrontmatterStyling(place, reader.get('trackStyle'), reader.get('trackColorBy'));
  return place;
}

// Note stat from the `note_modified`/`note_size` columns the `places`/`places_tracks` views
// expose. Absent (frontmatter path, custom queries) => undefined, and the decode falls back
// to the vault.
function readStatHint(reader: PlacePropertyReader): { mtime: number; size: number } | undefined {
  const mtime = Number(reader.get('note modified'));
  const size = Number(reader.get('note size'));
  return Number.isFinite(mtime) && mtime > 0 && Number.isFinite(size) ? { mtime, size } : undefined;
}

function toTagList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map(tag => tag.trim()).filter(Boolean);
  if (typeof value !== 'string') return [];
  return value.split(/[;,]/).map(tag => tag.trim()).filter(Boolean);
}
