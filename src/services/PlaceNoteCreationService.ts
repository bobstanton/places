import { App, Notice, TFile, normalizePath } from 'obsidian';
import { DEFAULT_MARKER_ICON, matchMarkerIconRule, resolveDefaultMarkerIcon, type GeocodedPlaceNoteRequest, type LocationPlaceNoteRequest, type PlaceNoteHost, type PlaceNoteRequest, type PoiPlaceNoteRequest, type RouteOverlayPlaceNoteRequest } from 'places-shared/map';
import { Coordinate, DistanceCalculator, coordinateFromPosition } from 'places-shared/geo';
import { PolylineCodec } from 'places-shared/track';
import { formatKmInSystem, km } from 'places-shared/units';
import { IPlacesPluginSettings } from 'places-shared/settings';
import { createOverlayNote } from 'places-shared/services';
import { StringCompressor, Utilities, ensureVaultFolder, formatDisplayCoordinate, getAvailableVaultPath, resolveNewNoteFolder, logger as rootLogger } from 'places-shared/utils';
import { preparePlaceTags } from './PlaceTagFilter';

const logger = rootLogger.scope('PlaceNote');

// The main plugin's implementation of `PlaceNoteHost` - where a
// provider-originated place note is written. Providers describe what the user
// clicked (a `PlaceNoteRequest`); everything about the resulting note is
// decided here: a POI click on a MapLibre map, a right-click on a Leaflet
// map, and any future entry point produce structurally identical notes.
//
// It runs in the main plugin's bundle on purpose: the configured marker icon
// rules, the compression codec, and the units setting all live here, and no
// cross-bundle state hacks are needed to honor them.
export class PlaceNoteCreationService implements PlaceNoteHost {
  constructor(private readonly app: App, private readonly getSettings: () => IPlacesPluginSettings) {}

  async createNote(request: PlaceNoteRequest): Promise<void> {
    try {
      const file = request.kind === 'route-overlay'
        ? await this.writeRouteOverlayNote(request)
        : await this.writePlaceNote(request);
      // A new tab, because every entry point is a click on a map in the note
      // the user is reading - replacing that note would lose their place.
      await this.app.workspace.getLeaf('tab').openFile(file);
      new Notice(`Created note: ${file.basename}`);
    } catch (error) {
      logger.error('Failed to create place note', { request, error });
      new Notice('Failed to create note');
    }
  }

  // The icon the note would get. Configured marker icon rules come first, fed
  // whatever tag-like vocabulary the request carries - a POI's class/subclass,
  // a geocoded place's filtered tags - plus the display name for `name:` rules,
  // and `tag:^viewpoint$` and `name:Boat Ramp` govern these notes exactly as
  // they govern tagged notes. Only a POI falls back further, to the vendor
  // class table, for tile vocabulary no tag rule would sensibly cover.
  resolveIcon(request: PlaceNoteRequest): string {
    switch (request.kind) {
      case 'poi': {
        const ruled = matchMarkerIconRule([request.class, request.subclass ?? ''], request.name);
        // '' is a rule that deliberately suppresses the icon - it must yield the
        // default, not fall through to the class table it was meant to override.
        if (ruled !== undefined) return ruled || DEFAULT_MARKER_ICON;
        return getIconForPoiClass(request.subclass) ?? getIconForPoiClass(request.class) ?? DEFAULT_MARKER_ICON;
      }
      case 'place':
        return resolveDefaultMarkerIcon(this.filteredTags(request), request.name);
      case 'location':
        return DEFAULT_MARKER_ICON;
      case 'route-overlay':
        // An overlay note is a map, not a marker: nothing renders this icon.
        return DEFAULT_MARKER_ICON;
    }
  }

  // A rendered route or isochrone stored as its own note: the overlay payload
  // in a note whose body is a `places` block, which renders on open. Uses the
  // shared overlay-note primitive, and compresses here - in the host's bundle,
  // where the codec and the configured compression level live.
  private async writeRouteOverlayNote(request: RouteOverlayPlaceNoteRequest): Promise<TFile> {
    return createOverlayNote(this.app, {
      name: request.name,
      sourcePath: request.sourcePath,
      frontmatter: {
        ...(request.location ? { Location: formatDisplayCoordinate(coordinateFromPosition(request.location)) } : {}),
        'Overlay Source': StringCompressor.compressAndEncode(JSON.stringify(request.geojson)),
      },
      // createNote opens and announces every kind uniformly.
      openAfterCreate: false,
    });
  }

  private async writePlaceNote(request: PoiPlaceNoteRequest | LocationPlaceNoteRequest | GeocodedPlaceNoteRequest): Promise<TFile> {
    const name = Utilities.sanitizeFilename(this.noteName(request)) || 'New Place';
    const folderPath = resolveNewNoteFolder(this.app);

    const basePath = normalizePath(folderPath ? `${folderPath}/${name}.md` : `${name}.md`);
    await ensureVaultFolder(this.app, basePath);
    const notePath = getAvailableVaultPath(this.app, basePath);

    const overlay = request.kind === 'poi' ? extractLineOverlay(request) : undefined;
    const location = overlay?.startCoordinate ?? this.requestCoordinate(request);
    const icon = this.resolveIcon(request);
    const units = this.getSettings().units;

    const file = await this.app.vault.create(notePath, '');
    await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
      frontmatter['Location'] = formatDisplayCoordinate(location);
      frontmatter['icon'] = icon;
      if (overlay) {
        frontmatter['Overlay Source'] = overlay.overlaySource;
        frontmatter['Distance'] = formatKmInSystem(km(overlay.distanceKm), units);
      }
      if (request.kind === 'place') {
        if (request.address?.trim()) frontmatter['Address'] = request.address;
        if (request.website?.trim()) frontmatter['Website'] = request.website;
        const tags = this.filteredTags(request);
        if (tags.length > 0) frontmatter['tags'] = tags;
      }
    });
    return file;
  }

  // Provider tags after the configured filter patterns and sanitization - what the note stores AND what icon rules see.
  private filteredTags(request: GeocodedPlaceNoteRequest): string[] {
    return preparePlaceTags([...(request.tags ?? [])], this.getSettings().newPlaceTagFilterPatterns);
  }

  private noteName(request: PoiPlaceNoteRequest | LocationPlaceNoteRequest | GeocodedPlaceNoteRequest): string {
    return request.kind === 'location'
      ? `Location ${formatDisplayCoordinate(request.coordinate, 4)}`
      : request.name;
  }

  private requestCoordinate(request: PoiPlaceNoteRequest | LocationPlaceNoteRequest | GeocodedPlaceNoteRequest): Coordinate {
    return request.kind === 'location'
      ? request.coordinate
      : { latitude: request.lat, longitude: request.lng };
  }
}

// A line POI's geometry as stored-overlay fields; point POIs return undefined.
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

// Fallback icons for the tile vendors' POI vocabulary (OpenMapTiles
// class/subclass, Mapbox Streets class/type). Only consulted when no
// configured marker icon rule matched - a rule always wins.
function getIconForPoiClass(cls: string | undefined): string | undefined {
  if (!cls) return undefined;
  return POI_CLASS_ICONS[cls.toLowerCase()];
}

const POI_CLASS_ICONS: Record<string, string> = {
  // Trails and paths
  path: '🥾', hiking: '🥾', trail: '🥾',
  cycleway: '🚲', bicycle: '🚲',
  // Natural features
  peak: '⛰️', mountain: '⛰️',
  water: '💧', lake: '💧', river: '💧',
  state_park: '🏞️', state_forest: '🏞️', national_park: '🏞️',
  park: '🌲', forest: '🌲', wood: '🌲',
  beach: '🏖️',
  viewpoint: '👀',
  waterfall: '🌊',
  cave: '🕳️',
  // Food & drink
  restaurant: '🍽️', food: '🍽️',
  cafe: '☕', coffee: '☕',
  bar: '🍺', pub: '🍺',
  fast_food: '🍔',
  // Accommodation
  hotel: '🏨', lodging: '🏨',
  hostel: '🛏️',
  campsite: '⛺', camp_site: '⛺',
  // Transport
  parking: '🅿️',
  bus_stop: '🚌', bus_station: '🚌', bus: '🚌',
  railway: '🚂', train_station: '🚂',
  aerodrome: '✈️', airport: '✈️', aeroway: '✈️',
  ferry: '⛴️',
  // Services
  hospital: '🏥', clinic: '🏥',
  pharmacy: '💊',
  police: '👮',
  fire_station: '🚒',
  fuel: '⛽', gas_station: '⛽',
  bank: '🏦',
  post_office: '📮',
  // Shopping
  shop: '🛒', store: '🛒',
  supermarket: '🏪', grocery: '🏪',
  mall: '🏬',
  // Culture & entertainment
  museum: '🏛️',
  theatre: '🎭', theater: '🎭',
  cinema: '🎬',
  library: '📚',
  // Recreation
  playground: '🎠',
  sports: '🏟️', stadium: '🏟️',
  golf: '⛳',
  swimming: '🏊',
  // Education
  school: '🏫',
  university: '🎓', college: '🎓',
};
