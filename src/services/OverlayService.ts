import { logger as rootLogger } from "places-shared/utils";
import { TileJsonLayerIndex } from './TileJsonLayerIndex';
import { App, TFile, normalizePath } from "obsidian";
import { loggedRequestUrl as requestUrl, bytesToBase64 } from "places-shared/utils";
import { PlaceholderResolver } from "places-shared/obsidian/utils";
import { SimpleContextProvider } from 'placeholder-resolver';
import { TrackDataService } from "./TrackDataService";
import { parseTrackFile } from 'places/core';
import type * as GeoJSON from 'geojson';
import { expandVectorTileOverlayPreset, type Overlay, type OverlayResult, type GeoJSONOverlay, type ImageOverlay, type OverlayRenderStyle, type VectorTileFilter, type VectorTileLayerType, type VectorTileOverlay, type VectorTileOverlayPreset, type ZoomScaledNumber } from "places-shared/overlay";
import { dispatchOverlayFormat, isTrackFileFormat, type TrackFileFormat } from 'places/core';
import { TRACK_STYLE_DEFAULTS } from "places-shared/track";
import { getGeoJsonFeatures, isPmtilesPath, parseVectorTileFilter, parseVectorTileDashArray, parseZoomScaledNumber, parseTileJson, isPmtilesUrl, pmtilesRemoteUrl, pmtilesVaultUrl, type ResolvedTileJson } from "places-shared/overlay";
import { detectOverlayFormat } from 'places/core';
import { isImageOverlayDefinition } from "places-shared/overlay";
import { parseCsvCoordinates } from 'places/core';
import { conditionalProps, DEFAULT_GPX_WAYPOINT_LABEL_TEMPLATE, parsePopupContentConfig } from "places-shared/settings";
import { applyWaypointIconsToGeoJson, buildFeatureTemplateContext } from "places-shared/map";
import { StringCompressor, getFileNameWithoutExtension, getErrorMessage, isRecord, scalarToString, stripSurroundingQuotes } from "places-shared/utils";

const logger = rootLogger.scope('OverlayService');

export class OverlayService {
  private trackDataService: TrackDataService;
  private readonly localGeoJsonCache = new Map<string, { mtime: number; size: number; geojson: GeoJSON.GeoJSON }>();
  private readonly geoJsonLoads = new Map<string, Promise<GeoJSONOverlay>>();
  private readonly tileJsonLoads = new Map<string, Promise<ResolvedTileJson>>();

  constructor(private app: App, private readonly getOverlayPreset: (id: string) => VectorTileOverlayPreset | undefined = () => undefined) {
    this.trackDataService = new TrackDataService(app);
  }

  async loadOverlays(overlaysSetting: unknown, waypointLabelTemplate?: string): Promise<OverlayResult> {
    let definitions: ExpandedOverlayDefinition[];

    try {
      definitions = normalizeOverlayDefinitions('overlays', overlaysSetting, group =>
        group.values.get('name') ?? group.values.get('path') ?? group.values.get('preset') ?? group.values.get('tiles') ?? group.values.get('url')
      );
    } catch (error) {
      return { overlays: [], errors: [{ path: 'overlays', error: getErrorMessage(error) }] };
    }

    const overlays: Overlay[] = [];
    const errors: Array<{ path: string; error: string }> = [];

    await Promise.all(definitions.map(async definition => {
      try {
        if (!parseVisibleOption(definition.get('visible'))) {
          return;
        }

        const kind = inferOverlayKind(definition);

        if (kind === 'vector-tile') {
          overlays.push(...await this.parseVectorTileOverlays(definition));
        } else if (kind === 'image') {
          overlays.push(await this.loadImageOverlayEntry(definition));
        } else {
          overlays.push(await this.loadGeoDataOverlayEntry(definition, waypointLabelTemplate));
        }
      } catch (error) {
        logger.error(`Failed to load ${definition.source}`, error);
        errors.push({ path: definition.source, error: getErrorMessage(error) });
      }
    }));

    return { overlays, errors };
  }

  private async loadGeoDataOverlayEntry(definition: ExpandedOverlayDefinition, blockWaypointLabelTemplate?: string): Promise<Overlay> {
    const path = definition.get('path');

    if (!path) throw new Error(`Overlay requires path: ${definition.source}`);

    const overlay = await this.loadGeoJsonOverlayFile(path);

    overlay.geojson = applyWaypointIconsToGeoJson(overlay.geojson);
    const zoom = parseZoomDefinition(definition);

    if (zoom) overlay.zoom = zoom;

    const labelTemplate = definition.get('labeltemplate');
    const entryWaypointLabelTemplate = definition.get('waypointlabeltemplate');
    const waypointLabelTemplate = entryWaypointLabelTemplate !== undefined
      ? entryWaypointLabelTemplate
      : blockWaypointLabelTemplate !== undefined
        ? blockWaypointLabelTemplate
        : DEFAULT_GPX_WAYPOINT_LABEL_TEMPLATE;

    overlay.waypointLabelTemplate = waypointLabelTemplate;
    overlay.geojson = await this.applyGeoJsonLabelTemplate(
      overlay.geojson,
      waypointLabelTemplate,
      overlay.source,
      feature => feature.properties?._placesGpxWaypoint === true,
      true,
    );

    if (labelTemplate !== undefined) {
      overlay.labelTemplate = labelTemplate;
      overlay.geojson = await this.applyGeoJsonLabelTemplate(
        overlay.geojson,
        labelTemplate,
        overlay.source,
        feature => feature.properties?._placesGpxWaypoint !== true,
      );
    }

    overlay.popup = parsePopupContentConfig(definition.getRaw?.('popup'), `${definition.source}.popup`);
    overlay.style = parseOverlayRenderStyle(definition, 'style');
    overlay.hoverStyle = parseOverlayRenderStyle(definition, 'hoverstyle');

    return overlay;
  }

  private async loadImageOverlayEntry(definition: ExpandedOverlayDefinition): Promise<Overlay> {
    const overlay = await this.loadImageOverlayDefinition(definition);
    const zoom = parseZoomDefinition(definition);

    if (zoom) overlay.zoom = zoom;

    return overlay;
  }

  private async loadGeoJsonOverlayFile(path: string): Promise<GeoJSONOverlay> {
    const file = this.resolveVaultFile(path);

    if (file) {
      const cached = this.localGeoJsonCache.get(file.path);

      if (cached?.mtime === file.stat.mtime && cached.size === file.stat.size) {
        return { type: 'geojson', geojson: cached.geojson, source: path };
      }
    }

    const workKey = file ? `file:${file.path}:${file.stat.mtime}:${file.stat.size}` : `source:${path}`;
    const active = this.geoJsonLoads.get(workKey);

    if (active) return active;
    const request = this.loadGeoJsonOverlayFileUncached(path);

    this.geoJsonLoads.set(workKey, request);

    try {
      const overlay = await request;

      if (file) {
        this.localGeoJsonCache.delete(file.path);
        this.localGeoJsonCache.set(file.path, { mtime: file.stat.mtime, size: file.stat.size, geojson: overlay.geojson });

        if (this.localGeoJsonCache.size > 200) {
          const oldest = this.localGeoJsonCache.keys().next().value;

          if (oldest !== undefined) this.localGeoJsonCache.delete(oldest);
        }
      }

      return overlay;
    } finally {
      if (this.geoJsonLoads.get(workKey) === request) this.geoJsonLoads.delete(workKey);
    }
  }

  private async loadGeoJsonOverlayFileUncached(path: string): Promise<GeoJSONOverlay> {
    const fileType = detectOverlayFormat(path, { sourceType: 'path' });

    if (fileType === 'image') {
      throw new Error(`Image files require an image overlay entry with bounds or corners: ${path}`);
    }

    const isUrl = path.startsWith('http://') || path.startsWith('https://');

    if (!isUrl && fileType === 'md') {
      const storedGeoJson = this.loadMarkdownStoredGeoJsonOverlay(path);

      if (storedGeoJson) {
        return { type: 'geojson', geojson: storedGeoJson, source: path };
      }
    }

    if (!isUrl && (isTrackFileFormat(fileType) || fileType === 'md')) {
      try {
        const trackData = await this.trackDataService.loadTrackFromPath(`"${path}"`, '');
        const geojson = this.trackDataService.trackDataToGeoJson(trackData);

        return { type: 'geojson', geojson, source: path };
      } catch (error) {
        throw new Error("Failed to load " + path + ": " + getErrorMessage(error));
      }
    }

    const content = await this.fetchContent(path);

    let geojson: GeoJSON.GeoJSON;

    switch (fileType) {
      case 'gpx':
      case 'fit':
        geojson = this.convertTrackFileToGeoJson(content, path, fileType);
        break;
      case 'csv':
        geojson = this.convertCsvToGeoJson(content, path);
        break;
      case 'geojson':
        geojson = this.parseAndValidateGeoJson(content, path);
        break;
      case 'md':
      case 'unknown':
        geojson = this.parseUnknownFormat(content, path);
        break;
      default:
        throw new Error(`Unsupported overlay format for ${path}: ${fileType}`);
    }

    return { type: 'geojson', geojson, source: path };
  }

  private async parseVectorTileOverlays(definition: ExpandedOverlayDefinition): Promise<VectorTileOverlay[]> {
    const presetId = definition.get('preset');

    if (presetId !== undefined) return this.parsePresetOverlays(definition, presetId);

    const archivePath = definition.get('path');
    const url = archivePath !== undefined ? pmtilesVaultUrl(archivePath) : pmtilesRemoteUrl(definition.get('url') ?? definition.get('tiles'));

    if (!url) {
      throw new Error(`Vector tile overlay requires tiles, url, or a .pmtiles path: ${definition.source}`);
    }

    if (archivePath !== undefined && !isPmtilesPath(archivePath)) {
      throw new Error(`A vector tile overlay path must be a .pmtiles archive: ${archivePath}`);
    }

    if (archivePath === undefined && !isPmtilesUrl(url) && !url.startsWith('http://') && !url.startsWith('https://')) {
      throw new Error(`Vector tile overlays require an external http(s) URL or a .pmtiles path: ${url}`);
    }

    if (definition.get('url') && definition.get('tiles')) {
      throw new Error(`Vector tile overlay must use either tiles or url, not both: ${definition.source}`);
    }

    const sourceLayer = definition.get('sourcelayer');
    const sourceLayers = parseStringListOption(definition.get('sourcelayers'));

    if (sourceLayer && sourceLayers.length > 0) {
      throw new Error(`Vector tile overlay must use either sourceLayer or sourceLayers, not both: ${definition.source}`);
    }

    if (!sourceLayer && sourceLayers.length === 0) {
      throw new Error(`Vector tile overlay requires sourceLayer or sourceLayers: ${definition.source}`);
    }

    const layerType = parseVectorLayerType(definition.get('layertype'));
    const filter = parseVectorFilterDefinition(definition);

    if (layerType === 'symbol' && !definition.get('textfield') && !definition.get('icon')) {
      throw new Error(`A "symbol" vector overlay requires textField (the feature property to label) or icon (a sprite image name): ${definition.source}.`);
    }

    const tileJson = archivePath === undefined
      && (Boolean(definition.get('url')) || parseBooleanOption(definition.get('tilejson')) || /\.json(?:$|[?#])/i.test(url));
    const tileJsonSource = tileJson ? await this.loadVectorTileJson(url, definition.source) : undefined;
    const minZoom = parseNumberOption(definition.get('minzoom'));
    const maxZoom = parseNumberOption(definition.get('maxzoom'));
    const zoom = minZoom !== undefined || maxZoom !== undefined
      ? {
        ...(minZoom !== undefined ? { minZoom } : {}),
        ...(maxZoom !== undefined ? { maxZoom } : {}),
      }
      : undefined;

    const style = parseOverlayRenderStyle(definition, 'style');
    const hoverStyle = parseOverlayRenderStyle(definition, 'hoverstyle');
    const popup = parsePopupContentConfig(definition.getRaw?.('popup'), `${definition.source}.popup`);
    const baseOverlay = {
      type: 'vector-tile',
      source: definition.source,
      ...(tileJson || archivePath !== undefined ? { url } : { tiles: [url] }),
      layerType,
      ...(zoom ? { zoom } : {}),
      bounds: parseBoundsOption(definition.get('bounds')),
      attribution: definition.get('attribution') ?? tileJsonSource?.attribution,
      ...(filter ? { filter } : {}),
      textField: definition.get('textfield'),
      symbolPlacement: parseSymbolPlacement(definition.get('symbolplacement')),
      sprite: definition.get('sprite'),
      icon: definition.get('icon'),
      ...(style ? { style } : {}),
      ...(hoverStyle ? { hoverStyle } : {}),
      ...(popup ? { popup } : {}),
    } satisfies Omit<VectorTileOverlay, 'sourceLayer'>;

    return (sourceLayer ? [sourceLayer] : sourceLayers).map(layer => ({
      ...baseOverlay,
      sourceLayer: layer,
    }));
  }

  private parsePresetOverlays(definition: ExpandedOverlayDefinition, presetId: string): VectorTileOverlay[] {
    if (definition.get('tiles') !== undefined || definition.get('url') !== undefined || definition.get('path') !== undefined) {
      throw new Error(`An overlay preset supplies its own tiles; remove tiles, url, and path: ${definition.source}`);
    }

    const preset = this.getOverlayPreset(presetId);

    if (!preset) {
      throw new Error(`No installed Places extension supplies the overlay preset "${presetId}": ${definition.source}`);
    }

    const sourceLayer = definition.get('sourcelayer');
    const sourceLayers = sourceLayer !== undefined ? [sourceLayer] : parseStringListOption(definition.get('sourcelayers'));
    const zoom = parseZoomDefinition(definition);
    const filter = parseVectorFilterDefinition(definition);
    const style = parseOverlayRenderStyle(definition, 'style');
    const hoverStyle = parseOverlayRenderStyle(definition, 'hoverstyle');
    const popup = parsePopupContentConfig(definition.getRaw?.('popup'), `${definition.source}.popup`);

    return expandVectorTileOverlayPreset(preset, {
      source: definition.source,
      ...(sourceLayers.length > 0 ? { sourceLayers } : {}),
      ...(zoom ? { zoom } : {}),
      ...(filter ? { filter } : {}),
      ...(style ? { style } : {}),
      ...(hoverStyle ? { hoverStyle } : {}),
      ...(popup ? { popup } : {}),
    });
  }

  private async loadVectorTileJson(url: string, source: string): Promise<ResolvedTileJson> {
    const active = this.tileJsonLoads.get(url);

    if (active) return active;
    const request = this.loadVectorTileJsonUncached(url, source);

    this.tileJsonLoads.set(url, request);

    try {
      return await request;
    } finally {
      if (this.tileJsonLoads.get(url) === request) this.tileJsonLoads.delete(url);
    }
  }

  private async loadVectorTileJsonUncached(url: string, source: string): Promise<ResolvedTileJson> {
    try {
      const response = await requestUrl({ url });
      const tileJson = parseTileJson(JSON.parse(response.text) as Record<string, unknown>, url);

      // Rendering a block is the cheapest way to warm the editor's layer index:
      // the document is already in hand, and completion for this tileset is
      // immediate instead of firing its own request on the first keystroke.
      TileJsonLayerIndex.instance.record(url, tileJson);

      return tileJson;
    } catch (error) {
      throw new Error(`Failed to load TileJSON for ${source}: ${getErrorMessage(error)}`);
    }
  }

  private async applyGeoJsonLabelTemplate(
    geojson: GeoJSON.GeoJSON,
    template: string,
    source: string,
    includeFeature: (feature: GeoJSON.Feature) => boolean = () => true,
    markWaypointTemplate = false,
  ): Promise<GeoJSON.FeatureCollection> {
    const features = getGeoJsonFeatures(geojson);

    // Labels resolve independently per feature; running them in parallel and
    // flattening keeps each label point adjacent to its feature, matching the
    // ordering of the old sequential loop.
    const entries = await Promise.all(features.map(async (feature, index): Promise<GeoJSON.Feature[]> => {
      if (!feature.geometry || feature.properties?.route_label_point || !includeFeature(feature)) {
        return [feature];
      }

      const label = await resolveGeoJsonFeatureLabel(template, feature, index, source);
      const featureWithLabel = label || markWaypointTemplate
        ? {
          ...feature,
          properties: {
            ...(feature.properties ?? {}),
            ...(label ? { _placesLabel: label } : {}),
            ...(markWaypointTemplate ? { _placesWaypointLabelApplied: true } : {}),
          },
        }
        : feature;

      const coordinate = getGeoJsonLabelCoordinate(feature.geometry);

      if (!coordinate || !label) {
        return [featureWithLabel];
      }

      return [featureWithLabel, {
        type: 'Feature',
        properties: {
          route_label: label,
          route_label_point: true,
          route_label_role: 'geojson',
          _geojson_label: true,
          _overlaySource: source,
        },
        geometry: {
          type: 'Point',
          coordinates: coordinate,
        },
      }];
    }));

    return {
      type: 'FeatureCollection',
      features: entries.flat(),
    };
  }

  private loadMarkdownStoredGeoJsonOverlay(path: string): GeoJSON.GeoJSON | null {
    const file = this.resolveVaultFile(path);

    if (!file) return null;

    const source: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.["Overlay Source"];

    if (typeof source !== 'string') return null;

    try {
      const decompressed = StringCompressor.decodeAndDecompress(source);

      if (detectOverlayFormat(decompressed) !== 'geojson') return null;

      return this.parseAndValidateGeoJson(decompressed, path);
    } catch {
      return null;
    }
  }

  private resolveVaultFile(path: string): TFile | null {
    const direct = this.app.vault.getAbstractFileByPath(normalizePath(path));

    if (direct instanceof TFile) return direct;

    const linked = this.app.metadataCache.getFirstLinkpathDest(path.replace(/\.md$/i, ''), '');

    return linked instanceof TFile ? linked : null;
  }

  private async loadImageOverlayDefinition(definition: ExpandedOverlayDefinition): Promise<ImageOverlay> {
    const imagePath = definition.get('path');

    if (!imagePath) {
      throw new Error(`Image overlay requires path: ${definition.source}`);
    }

    const boundsValue = definition.get('bounds');
    const cornersValue = definition.get('corners');

    if (boundsValue && cornersValue) {
      throw new Error(`Image overlay must use either bounds or corners, not both: ${definition.source}`);
    }

    if (!boundsValue && !cornersValue) {
      throw new Error(`Image overlay requires bounds or corners: ${definition.source}`);
    }

    const styleOpacity = parseNumberOption(definition.get('styleOpacity'));
    const style = styleOpacity !== undefined ? { opacity: styleOpacity } : undefined;
    const url = await this.resolveImageUrl(imagePath);

    if (boundsValue) {
      const coords = parseNumberList(boundsValue, 4, 'Image overlay bounds');

      return {
        type: 'image',
        url,
        bounds: {
          swLat: coords[0],
          swLng: coords[1],
          neLat: coords[2],
          neLng: coords[3]
        },
        style,
        source: imagePath
      };
    }

    const coords = parseNumberList(cornersValue ?? '', 8, 'Image overlay corners');

    return {
      type: 'image',
      url,
      corners: {
        nwLat: coords[0],
        nwLng: coords[1],
        neLat: coords[2],
        neLng: coords[3],
        seLat: coords[4],
        seLng: coords[5],
        swLat: coords[6],
        swLng: coords[7]
      },
      style,
      source: imagePath
    };
  }

  private async resolveImageUrl(path: string): Promise<string> {
    // External URL - fetch through requestUrl (no CORS) and inline as a data
    // URL, since GL image sources cannot load cross-origin images that lack
    // CORS headers.
    if (path.startsWith('http://') || path.startsWith('https://')) {
      try {
        const response = await requestUrl({ url: path });
        const contentType = response.headers?.['content-type'] || response.headers?.['Content-Type'] || 'image/*';

        return `data:${contentType};base64,${bytesToBase64(new Uint8Array(response.arrayBuffer))}`;
      } catch (error) {
        throw new Error(`Failed to fetch image ${path}: ${getErrorMessage(error)}`);
      }
    }

    if (path.startsWith('data:')) {
      return path;
    }

    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));

    if (!file || !(file instanceof TFile)) {
      throw new Error(`Image file not found: ${path}`);
    }

    return this.app.vault.getResourcePath(file);
  }

  private async fetchContent(path: string): Promise<string> {
    const isFit = detectOverlayFormat(path, { sourceType: 'path' }) === 'fit';

    if (path.startsWith('http://') || path.startsWith('https://')) {
      try {
        const response = await requestUrl({ url: path });

        return isFit ? bytesToBase64(new Uint8Array(response.arrayBuffer)) : response.text;
      } catch (error) {
      throw new Error("Failed to fetch from URL " + path + ": " + getErrorMessage(error));
      }
    }

    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));

    if (!file || !(file instanceof TFile)) {
      throw new Error(`File not found: ${path}`);
    }

    return await this.app.vault.cachedRead(file);
  }

  private parseAndValidateGeoJson(content: string, path: string): GeoJSON.GeoJSON {
    let geojson: { type?: string; [key: string]: unknown };

    try {
      geojson = JSON.parse(content) as { type?: string; [key: string]: unknown };
    } catch (error) {
      throw new Error("Invalid JSON in " + path + ": " + getErrorMessage(error));
    }

    if (!geojson.type) {
      throw new Error(`Invalid GeoJSON: missing type property in ${path}`);
    }

    const validTypes = ['Feature', 'FeatureCollection', 'Point', 'LineString', 'Polygon',
                        'MultiPoint', 'MultiLineString', 'MultiPolygon', 'GeometryCollection'];

    if (!validTypes.includes(geojson.type)) {
      throw new Error(`Invalid GeoJSON type: ${String(geojson.type)} in ${path}`);
    }

    return geojson as unknown as GeoJSON.GeoJSON;
  }

  private convertTrackFileToGeoJson(content: string, path: string, format: TrackFileFormat): GeoJSON.GeoJSON {
    try {
      const trackData = parseTrackFile(content, format);

      return this.trackDataService.trackDataToGeoJson(trackData);
    } catch (error) {
      throw new Error(`Failed to parse ${format.toUpperCase()} file ${path}: ${getErrorMessage(error)}`);
    }
  }

  // Expects columns: Latitude/lat, Longitude/lng/lon, optional: name, description, icon
  private convertCsvToGeoJson(content: string, path: string): GeoJSON.GeoJSON {
    try {
      const parsedCsv = parseCsvCoordinates(content, `CSV file ${path}`);
      const { header } = parsedCsv;
      const nameIndex = header.indexOf('name');
      const descIndex = header.findIndex(col => col === 'description' || col === 'desc');
      const iconIndex = header.indexOf('icon');

      const features: GeoJSON.Feature[] = [];
      const trackCoordinates: number[][] = [];

      for (const row of parsedCsv.rows) {
        const coords: number[] = [row.longitude, row.latitude];

        if (row.elevation !== undefined) {
          coords.push(row.elevation);
        }

        trackCoordinates.push(coords);

        const name = nameIndex !== -1 ? row.values[nameIndex]?.trim() : undefined;
        const description = descIndex !== -1 ? row.values[descIndex]?.trim() : undefined;
        const icon = iconIndex !== -1 ? row.values[iconIndex]?.trim() : undefined;

        if (name || icon) {
          features.push({
            type: 'Feature',
            properties: {
              ...conditionalProps({ name, description }),
              ...(icon && { icon, 'marker-symbol': icon })
            },
            geometry: {
              type: 'Point',
              coordinates: coords
            }
          });
        }
      }

      if (trackCoordinates.length > 1 && features.length === 0) {
        features.push({
          type: 'Feature',
          properties: {
            name: getFileNameWithoutExtension(path, path, /\.csv$/i),
            stroke: TRACK_STYLE_DEFAULTS.color,
            'stroke-width': 3,
            'stroke-opacity': 0.8
          },
          geometry: {
            type: 'LineString',
            coordinates: trackCoordinates
          }
        });
      } else if (trackCoordinates.length === 1 && features.length === 0) {
        features.push({
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'Point',
            coordinates: trackCoordinates[0]
          }
        });
      }

      if (features.length === 0) {
        throw new Error(`No valid coordinates found in CSV file ${path}`);
      }

      return {
        type: 'FeatureCollection',
        features
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes(path)) {
        throw error;
      }

      throw new Error("Failed to parse CSV file " + path + ": " + getErrorMessage(error));
    }
  }

  private parseUnknownFormat(content: string, path: string): GeoJSON.GeoJSON {
    const format = dispatchOverlayFormat({ path, content });

    switch (format) {
      case 'geojson': return this.parseAndValidateGeoJson(content, path);
      case 'gpx': return this.convertTrackFileToGeoJson(content, path, 'gpx');
      case 'fit': return this.convertTrackFileToGeoJson(content, path, 'fit');
      case 'csv': return this.convertCsvToGeoJson(content, path);
      default:
        throw new Error(`Unable to determine file format for ${path}. Supported formats: .geojson, .json, .gpx, .fit, .csv, .md`);
    }
  }
}

async function resolveGeoJsonFeatureLabel(template: string, feature: GeoJSON.Feature, index: number, source: string): Promise<string> {
  const trimmed = template.trim();

  if (!trimmed) return '';

  const resolver = new PlaceholderResolver(new SimpleContextProvider(buildFeatureTemplateContext(feature, index, source)), {
    escapeValue: (value) => value,
    prefix: 'this',
  });
  const result = await resolver.resolveWithDetails(trimmed);

  if (result.diagnostics.length > 0 || result.hasUnresolved) {
    const details = result.diagnostics
      .map(diagnostic => `${diagnostic.placeholder}: ${diagnostic.message ?? diagnostic.kind}`)
      .join('; ');

    throw new Error(`Label template failed for feature ${index + 1}: ${details || 'unresolved placeholder'}`);
  }

  return result.result.trim();
}

function getGeoJsonLabelCoordinate(geometry: GeoJSON.Geometry): GeoJSON.Position | null {
  switch (geometry.type) {
    case 'Point':
      return validPosition(geometry.coordinates);
    case 'MultiPoint':
      return averagePositions(geometry.coordinates);
    case 'LineString':
      return middlePosition(geometry.coordinates);
    case 'MultiLineString':
      return middlePosition(longestLine(geometry.coordinates));
    case 'Polygon':
      return averagePositions(geometry.coordinates[0] ?? []);
    case 'MultiPolygon':
      return averagePositions((geometry.coordinates[0] ?? [])[0] ?? []);
    case 'GeometryCollection':
      for (const child of geometry.geometries) {
        const coordinate = getGeoJsonLabelCoordinate(child);

        if (coordinate) return coordinate;
      }

      return null;
    default:
      return null;
  }
}

function middlePosition(coordinates: GeoJSON.Position[]): GeoJSON.Position | null {
  if (!coordinates.length) return null;

  return validPosition(coordinates[Math.floor((coordinates.length - 1) / 2)] ?? null);
}

function longestLine(lines: GeoJSON.Position[][]): GeoJSON.Position[] {
  return lines.reduce<GeoJSON.Position[]>((longest, line) =>
    line.length > longest.length ? line : longest, []);
}

function averagePositions(coordinates: GeoJSON.Position[]): GeoJSON.Position | null {
  const valid = coordinates.filter((coordinate): coordinate is GeoJSON.Position => validPosition(coordinate) !== null);

  if (!valid.length) return null;

  const sum = valid.reduce((acc, coordinate) => {
    acc[0] += coordinate[0];
    acc[1] += coordinate[1];

    return acc;
  }, [0, 0]);

  return [sum[0] / valid.length, sum[1] / valid.length];
}

function validPosition(coordinate: GeoJSON.Position | null | undefined): GeoJSON.Position | null {
  if (!coordinate || coordinate.length < 2) return null;
  const lng = Number(coordinate[0]);
  const lat = Number(coordinate[1]);

  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;

  return coordinate;
}

export interface ExpandedOverlayDefinition {
  source: string;
  get(key: string): string | undefined;
  // The un-stringified parsed value for a key, preserving YAML arrays and
  // objects (e.g. a raw MapLibre `filter` expression). `get` flattens everything
  // to a string; `getRaw` is how structured settings survive to the parser.
  getRaw?(key: string): unknown;
}

export function inferOverlayKind(definition: ExpandedOverlayDefinition): 'geodata' | 'image' | 'vector-tile' {
  const explicit = definition.get('type');

  if (explicit === 'image') return 'image';
  if (explicit === 'vector-tile' || explicit === 'vector') return 'vector-tile';
  if (explicit === 'geojson' || explicit === 'geodata') return 'geodata';

  if (explicit === 'line' || explicit === 'fill' || explicit === 'circle') {
    throw new Error(`"${explicit}" is a vector layer type, not an overlay kind: ${definition.source}. Use "layerType: ${explicit}" (the overlay is recognized as a vector tile from its tiles/sourceLayer), or set "type: vector-tile".`);
  }

  if (explicit !== undefined) {
    throw new Error(`Unknown overlay type "${explicit}": ${definition.source}. Expected geodata, image, or vector-tile.`);
  }

  const overlayPath = definition.get('path');

  if (definition.get('preset') !== undefined) return 'vector-tile';

  if (definition.get('tiles') || definition.get('sourcelayer') || definition.get('sourcelayers') || (definition.get('url') && !overlayPath)) {
    return 'vector-tile';
  }

  if (overlayPath && isPmtilesPath(overlayPath)) {
    return 'vector-tile';
  }

  return isImageOverlayDefinition({ path: overlayPath, bounds: definition.get('bounds'), corners: definition.get('corners') })
    ? 'image' : 'geodata';
}

function normalizeOverlayDefinitions(settingName: string, setting: unknown, getSource?: (group: { values: Map<string, string> }) => string | undefined): ExpandedOverlayDefinition[] {
  if (Array.isArray(setting) || isRecord(setting)) {
    return parseStructuredOverlayDefinitions(settingName, setting, getSource);
  }

  throw new Error(`${settingName} must be a YAML object or list, not a string.`);
}

function parseStructuredOverlayDefinitions(settingName: string, setting: Record<string, unknown> | unknown[], getSource?: (group: { values: Map<string, string> }) => string | undefined): ExpandedOverlayDefinition[] {
  const items = Array.isArray(setting) ? setting : [setting];

  if (items.length === 0) {
    throw new Error(`${settingName} must contain at least one overlay definition.`);
  }

  return items.map((item, index) => {
    const values = new Map<string, string>();
    const rawValues = new Map<string, unknown>();

    if (isRecord(item)) {
      for (const [key, value] of Object.entries(item)) {
        const normalizedKey = normalizeVectorOptionKey(key);

        if ((normalizedKey === 'style' || normalizedKey === 'hoverstyle') && isRecord(value)) {
          for (const [styleKey, styleValue] of Object.entries(value)) {
            values.set(`${normalizedKey}${normalizeVectorOptionKey(styleKey)}`, stringifyOverlayValue(styleValue));
          }
        } else {
          values.set(normalizedKey, stringifyOverlayValue(value));
        }

        rawValues.set(normalizedKey, value);
      }
    } else if (typeof item === 'string') {
      values.set('path', stripSurroundingQuotes(item));
      rawValues.set('path', stripSurroundingQuotes(item));
    } else {
      throw new Error(`Invalid ${settingName} item ${index + 1}`);
    }

    const group = { values };

    return {
      source: getSource?.(group) ?? values.get('name') ?? values.get('path') ?? `${settingName} item ${index + 1}`,
      get: (key: string) => values.get(normalizeVectorOptionKey(key)),
      getRaw: (key: string) => rawValues.get(normalizeVectorOptionKey(key)),
    };
  });
}

function normalizeVectorOptionKey(key: string): string {
  return key.trim().replace(/[-_\s]/g, '').toLowerCase();
}

function stringifyOverlayValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(item => stringifyOverlayValue(item)).filter(Boolean).join(',');
  }

  if (value === null || value === undefined) return '';

  return stripSurroundingQuotes(scalarToString(value));
}

function parseStringListOption(value: string | undefined): string[] {
  if (!value) return [];

  return value
    .split(',')
    .map(item => stripSurroundingQuotes(item).trim())
    .filter(Boolean);
}

function parseVectorLayerType(value: string | undefined): VectorTileLayerType {
  if (value === 'fill' || value === 'circle' || value === 'line' || value === 'symbol') return value;
  if (!value) return 'line';

  throw new Error(`Unsupported vector tile layer type: ${value}. Expected line, fill, circle, or symbol.`);
}

function parseSymbolPlacement(value: string | undefined): 'point' | 'line' | 'line-center' | undefined {
  if (value === undefined) return undefined;
  if (value === 'point' || value === 'line' || value === 'line-center') return value;

  throw new Error(`Unsupported symbolPlacement: ${value}. Expected point, line, or line-center.`);
}

function parseBooleanOption(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

// The `visible:` entry option: default visible; anything but true/false is an error.
function parseVisibleOption(value: string | undefined): boolean {
  if (value === undefined || value.trim() === '') return true;
  const normalized = value.trim().toLowerCase();

  if (normalized === 'true') return true;
  if (normalized === 'false') return false;

  throw new Error(`Expected visible to be true or false, received: ${value}`);
}

function parseNumberOption(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected number option, received: ${value}`);
  }

  return parsed;
}

function parseZoomScaledOption(value: string | undefined, label: string): ZoomScaledNumber | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = parseZoomScaledNumber(value);

  if (parsed === undefined) {
    throw new Error(`Expected ${label} as a number or @z zoom stops (e.g. 1 @z10, 2.5 @z14), received: ${value}`);
  }

  return parsed;
}

export function parseOverlayRenderStyle(definition: ExpandedOverlayDefinition, prefix: 'style' | 'hoverstyle'): OverlayRenderStyle | undefined {
  const get = (key: string): string | undefined => definition.get(`${prefix}${key}`);
  const style: OverlayRenderStyle = {
    color: get('color'),
    opacity: parseZoomScaledOption(get('opacity'), `${prefix}.opacity`),
    width: parseZoomScaledOption(get('width'), `${prefix}.width`),
    dashArray: parseVectorTileDashArray(get('dasharray')),
    fillColor: get('fillcolor'),
    fillOpacity: parseNumberOption(get('fillopacity')),
    circleRadius: parseNumberOption(get('circleradius') ?? get('radius')),
    strokeColor: get('strokecolor'),
    strokeWidth: parseNumberOption(get('strokewidth')),
    strokeOpacity: parseNumberOption(get('strokeopacity')),
    textSize: parseZoomScaledOption(get('textsize'), `${prefix}.textSize`),
    textColor: get('textcolor'),
    textHaloColor: get('texthalocolor'),
    textHaloWidth: parseNumberOption(get('texthalowidth')),
    iconSize: parseNumberOption(get('iconsize')),
  };
  const entries = Object.entries(style).filter(([, value]) => value !== undefined);

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function parseVectorFilterDefinition(definition: ExpandedOverlayDefinition): VectorTileFilter | undefined {
  const rawFilter = definition.getRaw ? definition.getRaw('filter') : definition.get('filter');

  if (Array.isArray(rawFilter)) return rawFilter as VectorTileFilter;
  if (typeof rawFilter !== 'string' || rawFilter.trim() === '') return undefined;
  const filter = parseVectorTileFilter(rawFilter);

  if (!filter) {
    throw new Error(`Invalid vector overlay filter "${rawFilter}": ${definition.source}. Use a MapLibre filter expression like ["==", ["get", "class"], "motorway"], or the shorthand "index == 1" / "ele >= 1000 AND ele <= 3000".`);
  }

  return filter;
}

function parseZoomDefinition(definition: ExpandedOverlayDefinition): { minZoom?: number; maxZoom?: number } | undefined {
  const minZoom = parseNumberOption(definition.get('minzoom'));
  const maxZoom = parseNumberOption(definition.get('maxzoom'));

  return minZoom !== undefined || maxZoom !== undefined
    ? {
      ...(minZoom !== undefined ? { minZoom } : {}),
      ...(maxZoom !== undefined ? { maxZoom } : {}),
    }
    : undefined;
}

function parseNumberList(value: string, expectedLength: number, label: string): number[] {
  const parts = value.split(',').map(part => Number(part.trim()));

  if (parts.length !== expectedLength || parts.some(part => !Number.isFinite(part))) {
    throw new Error(`${label} must contain ${expectedLength} comma-separated numbers: ${value}`);
  }

  return parts;
}

function parseBoundsOption(value: string | undefined): [number, number, number, number] | undefined {
  if (!value) return undefined;
  const parts = parseNumberList(value, 4, 'Vector tile bounds');

  return [parts[0], parts[1], parts[2], parts[3]];
}
