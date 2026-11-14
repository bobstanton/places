import type { Coordinate } from 'places-shared/geo';
import { DistanceCalculator } from 'places-shared/geo';
import { matchMarkerIconRule } from 'places-shared/map';
import type { GeocodedPlaceNoteRequest, LocationPlaceNoteRequest, PlaceNoteRequest, PoiPlaceNoteRequest } from 'places-shared/map';
import { PolylineCodec } from 'places-shared/track';
import { StringCompressor } from 'places-shared/utils';
import { formatDisplayCoordinate } from 'places-shared/utils';
import { Utilities } from 'places-shared/utils';
import { formatKmInSystem, km } from 'places-shared/units';
import type { UnitsSystem } from 'places-shared/units';
import { preparePlaceTags } from './PlaceTagFilter';

export interface PlaceNoteContent {
  name: string;
  frontmatter: Record<string, unknown>;
  icon?: string;
}

export interface PlaceNoteSettings {
  units: UnitsSystem;
  newPlaceTagFilterPatterns: string[];
}

export function resolvePlaceNoteIcon(request: PlaceNoteRequest, preparedTags = request.kind === 'place' ? preparePlaceTags([...(request.tags ?? [])]) : [], note?: { name: string; path: string }): string | undefined {
  switch (request.kind) {
    case 'poi': {
      const ruled = matchMarkerIconRule([request.class, request.subclass ?? ''], note?.name ?? request.name, note?.path);

      if (ruled !== undefined) return ruled || undefined;

      return getIconForPoiClass(request.subclass) ?? getIconForPoiClass(request.class);
    }
    case 'place':
      return matchMarkerIconRule(preparedTags, note?.name ?? request.name, note?.path) || undefined;
    case 'location':
      return matchMarkerIconRule([], note?.name ?? placeNoteName(request), note?.path) || undefined;
    case 'track':
    case 'route-overlay':
      return undefined;
  }
}

export function buildPlaceNoteContent(request: PoiPlaceNoteRequest | LocationPlaceNoteRequest | GeocodedPlaceNoteRequest, settings: PlaceNoteSettings, note?: { name: string; path: string }): PlaceNoteContent {
  const name = note?.name ?? (Utilities.sanitizeFilename(placeNoteName(request)) || 'New Place');
  const overlay = request.kind === 'poi' ? extractLineOverlay(request) : undefined;
  const location = overlay?.startCoordinate ?? requestCoordinate(request);
  const tags = request.kind === 'place' ? preparePlaceTags([...(request.tags ?? [])], settings.newPlaceTagFilterPatterns) : [];
  const icon = resolvePlaceNoteIcon(request, tags, note);

  const frontmatter: Record<string, unknown> = {
    Location: formatDisplayCoordinate(location),
  };

  if (icon) frontmatter.icon = icon;

  if (overlay) {
    frontmatter['Overlay Source'] = overlay.overlaySource;
    frontmatter['Distance'] = formatKmInSystem(km(overlay.distanceKm), settings.units);
  }

  if (request.kind === 'place') {
    if (request.address?.trim()) frontmatter['Address'] = request.address;
    if (request.website?.trim()) frontmatter['Website'] = request.website;
    if (tags.length > 0) frontmatter['tags'] = tags;
  }

  return { name, frontmatter, icon };
}

export function placeNoteName(request: PoiPlaceNoteRequest | LocationPlaceNoteRequest | GeocodedPlaceNoteRequest): string {
  return request.kind === 'location'
    ? `Location ${formatDisplayCoordinate(request.coordinate, 4)}`
    : request.name;
}

function requestCoordinate(request: PoiPlaceNoteRequest | LocationPlaceNoteRequest | GeocodedPlaceNoteRequest): Coordinate {
  return request.kind === 'location'
    ? request.coordinate
    : { latitude: request.lat, longitude: request.lng };
}

function extractLineOverlay(request: PoiPlaceNoteRequest): { overlaySource: string; distanceKm: number; startCoordinate: Coordinate } | undefined {
  const coordinates = lineCoordinates(request);

  if (coordinates.length === 0) return undefined;

  return {
    overlaySource: StringCompressor.compressAndEncode(PolylineCodec.encode(coordinates)),
    distanceKm: DistanceCalculator.calculatePolylineDistanceKm(coordinates),
    startCoordinate: coordinates[0],
  };
}

function lineCoordinates(request: PoiPlaceNoteRequest): Coordinate[] {
  const geometry = request.geometry;

  if (geometry?.type === 'LineString') {
    return geometry.coordinates.map(([lng, lat]) => ({ latitude: lat, longitude: lng }));
  }

  if (geometry?.type === 'MultiLineString') {
    return geometry.coordinates.flat().map(([lng, lat]) => ({ latitude: lat, longitude: lng }));
  }

  return [];
}

function getIconForPoiClass(cls: string | undefined): string | undefined {
  if (!cls) return undefined;

  return POI_CLASS_ICONS[cls.toLowerCase()];
}

const POI_CLASS_ICONS: Record<string, string> = {
  path: '🥾', hiking: '🥾', trail: '🥾',
  cycleway: '🚲', bicycle: '🚲',
  peak: '⛰️', mountain: '⛰️',
  water: '💧', lake: '💧', river: '💧',
  state_park: '🏞️', state_forest: '🏞️', national_park: '🏞️',
  park: '🌲', forest: '🌲', wood: '🌲',
  beach: '🏖️',
  viewpoint: '👀',
  waterfall: '🌊',
  cave: '🕳️',
  restaurant: '🍽️', food: '🍽️',
  cafe: '☕️', coffee: '☕️',
  bar: '🍺', pub: '🍺',
  fast_food: '🍔',
  hotel: '🏨', lodging: '🏨',
  hostel: '🛏️',
  campsite: '⛺', camp_site: '⛺',
  parking: '🅿️',
  bus_stop: '🚌', bus_station: '🚌', bus: '🚌',
  railway: '🚂', train_station: '🚂',
  aerodrome: '✈️', airport: '✈️', aeroway: '✈️',
  ferry: '⛴️',
  hospital: '🏥', clinic: '🏥',
  pharmacy: '💊',
  police: '👮',
  fire_station: '🚒',
  fuel: '⛽', gas_station: '⛽',
  bank: '🏦',
  post_office: '📮',
  shop: '🛒', store: '🛒',
  supermarket: '🏪', grocery: '🏪',
  mall: '🏬',
  museum: '🏛️',
  theatre: '🎭', theater: '🎭',
  cinema: '🎬',
  library: '📚',
  playground: '🎠',
  sports: '🏟️', stadium: '🏟️',
  golf: '⛳',
  swimming: '🏊',
  school: '🏫',
  university: '🎓', college: '🎓',
};
