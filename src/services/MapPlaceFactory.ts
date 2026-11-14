import { normalizeFrontmatterTags } from "places-shared/map";
import type { MapPlace } from "places-shared/overlay";
import { resolveMarkerIcon } from "places-shared/map";
import { collectGeoJsonGeometryParts, coordinateFromPosition, parseNamedCoordinate, type Coordinate } from "places-shared/geo";
import type { MapPlaceOverlay } from "places-shared/place";
import { mergePlaceSettings, parsePlaceSettings, type MapConfigPatch, type PlaceSettingsLayer } from "places-shared/settings";
import { normalizePropertyName, readNormalizedProperty, scalarToString } from "places-shared/utils";
import { type OverlayLoadMetrics } from "../core/OverlayLoadMetrics";
import { applyWaypointIconsToGeoJson } from "places-shared/map";
import { decodeOverlayFieldsDetailedCached } from './OverlayDecodeCache';
import { TrackStyleParser } from 'places/core';

export interface MapPlaceFactoryOptions {
  metrics?: OverlayLoadMetrics;
  properties: Record<string, unknown>;
  name: string;
  filePath?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  queryRow?: Record<string, unknown>;
  noteProperties?: Record<string, unknown>;
}

const OVERLAY_BLOB_PROPERTIES = ['overlaysource', 'overlaycache'];

export function compactOverlayBlobs<T extends Record<string, unknown>>(record: T): T {
  for (const key of Object.keys(record)) {
    if (normalizePropertyName(key) === 'content') { delete record[key]; continue; }
    if (OVERLAY_BLOB_PROPERTIES.includes(normalizePropertyName(key))) (record as Record<string, unknown>)[key] = 'true';
  }

  return record;
}

export function createMapPlaceFromProperties(options: MapPlaceFactoryOptions): MapPlace | null {
  const properties = options.properties;
  const location = readNormalizedProperty(properties, 'location');
  let coordinates: Coordinate | null = parseNamedCoordinate(location);

  if (!coordinates && location !== undefined && location !== null && location !== '') throw new Error('Invalid Location: expected latitude, longitude.');
  const source = readNormalizedProperty(properties, 'overlay source');
  let overlaySource: string | Uint8Array | undefined;

  if (typeof source === 'string') overlaySource = source || undefined;
  else if (source != null) {
    if (!ArrayBuffer.isView(source) || Object.prototype.toString.call(source) !== '[object Uint8Array]') throw new Error('Overlay Source must contain text or bytes.');
    overlaySource = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  }

  const overlayCache = scalarToString(readNormalizedProperty(properties, 'overlay cache')) || undefined;
  const decoded = decodeOverlayFieldsDetailedCached(options.filePath, overlaySource, overlayCache, readStatHint(properties), options.metrics);

  if (!coordinates && decoded.overlay) coordinates = coordinatesFromOverlay(decoded.overlay);

  if (!coordinates) {
    if (decoded.errors.length) throw new Error(decoded.errors.join('; '));
    const contentStatus = scalarToString(readNormalizedProperty(properties, 'content status'));

    if (contentStatus && contentStatus !== 'ready') throw new Error(scalarToString(readNormalizedProperty(properties, 'content error')) || `Overlay contents unavailable (${contentStatus}).`);
    if (source != null || overlayCache) throw new Error('Overlay contains no valid coordinates.');

    return null;
  }

  const noteProperties = options.queryRow ? options.noteProperties : properties;
  const settingsLayers: PlaceSettingsLayer[] = [];

  settingsLayers.push({ source: 'note', values: parsePlaceSettings(noteProperties, 'note') });
  if (options.queryRow) settingsLayers.push({ source: 'query', values: parsePlaceSettings(options.queryRow, 'query') });
  const tags = options.tags ?? normalizeFrontmatterTags(readNormalizedProperty(properties, 'tags'));
  const place: MapPlace = {
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
    name: options.name,
    icon: resolveMarkerIcon(readNormalizedProperty(properties, 'icon')),
    tags,
    metadata: buildPlaceMetadata(noteProperties, options.metadata ?? properties),
    settingsLayers,
    settings: mergePlaceSettings(settingsLayers),
  };

  if (options.filePath) place.filePath = options.filePath;
  if (options.queryRow) place.queryRow = compactOverlayBlobs({ ...options.queryRow });

  if (decoded.overlay || decoded.errors.length) {
    place.overlay = decoded.overlay
      ? { ...decoded.overlay, geojson: applyWaypointIconsToGeoJson(decoded.overlay.geojson) }
      : undefined;

    if (decoded.errors.length > 0) {
      place.metadata ??= {};
      place.metadata._overlayLoadErrors = decoded.errors;
    }
  }

  applyPlaceTrackSettings(place);

  return place;
}

function coordinatesFromOverlay(overlay: MapPlaceOverlay): Coordinate | null {
  for (const trackOnly of [true, false]) {
    for (const feature of overlay.geojson.features) {
      if (trackOnly && feature.geometry?.type !== 'LineString' && feature.geometry?.type !== 'MultiLineString') continue;
      const parts = collectGeoJsonGeometryParts(feature.geometry);
      const groups = [...parts.lines, parts.points];

      for (const group of groups) {
        for (const position of group) {
          if (Number.isFinite(position?.[0]) && Number.isFinite(position?.[1]) && Math.abs(position[0]) <= 180 && Math.abs(position[1]) <= 90) return coordinateFromPosition(position);
        }
      }
    }
  }

  return null;
}

export function applyPlaceTrackSettings(place: MapPlace, block: MapConfigPatch = {}): void {
  const layers = [block, ...(place.settingsLayers ?? []).map(layer => layer.values)];

  if (place.overlay && layers.some(values => values.trackStyle !== undefined)) {
    const geojson = place.overlay.geojson;

    place.overlay = { ...place.overlay, geojson: { ...geojson, features: geojson.features.map(feature => ({ ...feature, properties: { ...feature.properties } })) } };
  }

  for (const values of layers) {
    TrackStyleParser.applyStyles(place, values.trackStyle, values.trackColorBy);
    if (values.trackDefaultVisibility !== undefined) place.trackDefaultVisibility = values.trackDefaultVisibility;
    if (values.trackOutline !== undefined) place.trackOutline = values.trackOutline;
  }
}

function buildPlaceMetadata(note: Record<string, unknown> | undefined, properties: Record<string, unknown>): Record<string, unknown> {
  const values = new Map<string, [string, unknown]>();

  for (const source of [note, properties]) {
    for (const [key, value] of Object.entries(source ?? {})) {
      const normalized = normalizePropertyName(key);

      if (['places', 'settings', 'overlaysource', 'overlaycache', 'content'].includes(normalized) || value == null) continue;
      values.set(normalized, [key, value]);
    }
  }

  return Object.fromEntries(values.values());
}

function readStatHint(properties: Record<string, unknown>): { mtime: number; size: number } | undefined {
  const mtime = Number(readNormalizedProperty(properties, 'note modified'));
  const size = Number(readNormalizedProperty(properties, 'note size'));

  return Number.isFinite(mtime) && mtime > 0 && Number.isFinite(size) ? { mtime, size } : undefined;
}
