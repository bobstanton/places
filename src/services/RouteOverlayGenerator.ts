import type { UnitsSystem } from "places-shared/units";
import { App, MarkdownPostProcessorContext, normalizePath, TFile } from "obsidian";
import { type MapPlace, type OverlayResult } from "places-shared/overlay";
import { type DirectionsOverlayRequest, type IsochroneOverlayRequest, type RouteOverlayService, type RouteWaypoint, markGeneratedOverlayFeatures } from "places-shared/services";
import type { ApiUsageOrigin } from "places-shared/services";
import { getErrorMessage, logger as rootLogger, scalarToString } from "places-shared/utils";
import type { DirectionsDefinition, IsochroneDefinition, ResolvedMapConfig } from "places-shared/settings";
import { CACHE_DISABLED, resolveCascadedLabelTemplate, DEFAULT_WAYPOINT_LABEL_TEMPLATE, normalizePropertyName } from "places-shared/settings";
import { normalizeZoomRange } from "places-shared/map";
import { parseNamedCoordinate } from "places-shared/geo";
import type { VaultQueryService } from "./VaultQueryService";
import type { QueryParameterMapMarker } from "places/core";

const logger = rootLogger.scope("RouteOverlays");

interface ParsedRouteOverlayDefinitions {
  directions: DirectionsOverlayRequest[];
  isochrones: IsochroneOverlayRequest[];
  errors: Array<{ path: string; error: string }>;
}

export interface RouteOverlayServiceLookup {
  get(name: string, origin?: ApiUsageOrigin): RouteOverlayService | undefined;
  getNames(): string[];
}

export class RouteOverlayGenerator {
  constructor(private app: App, private routeOverlayServices: RouteOverlayServiceLookup, private vaultQueryService?: VaultQueryService, private getDefaultRouteLabelTemplate: () => string = () => "{this.distance_text} · {this.duration_text}", private getUnits: () => UnitsSystem = () => 'imperial') {}

  async generateForBlock(settings: ResolvedMapConfig, places: MapPlace[], mapProviderName: string, ctx: MarkdownPostProcessorContext, options: { bypassCache?: boolean } = {}): Promise<OverlayResult> {
    const errors: Array<{ path: string; error: string }> = [];
    const blockProvider = settings.routeProvider?.trim().toLowerCase() || undefined;

    logger.debug("route overlay generation requested", {
      mapProvider: mapProviderName,
      routeProvider: blockProvider,
      hasDirections: Boolean(settings.directions),
      hasIsochrones: Boolean(settings.isochrones),
      placeCount: places.length,
      sourcePath: ctx.sourcePath,
    });

    const origin: ApiUsageOrigin = { sourcePath: ctx.sourcePath, blockType: 'places' };
    const parsed = await this.resolveDefinitions(settings, places, ctx.sourcePath);

    errors.push(...parsed.errors);

    if (options.bypassCache) {
      parsed.directions.forEach((request) => { request.cache = CACHE_DISABLED; });
      parsed.isochrones.forEach((request) => { request.cache = CACHE_DISABLED; });
    }

    const overlays: OverlayResult["overlays"] = [];

    for (const directions of parsed.directions) {
      const path = ["directions", directions.name].filter(Boolean).join(":");
      const resolved = this.resolveRouteService(directions.provider ?? blockProvider, mapProviderName, { origin });

      if (!resolved.service) {
        errors.push({ path, error: resolved.error });
        continue;
      }

      try {
        overlays.push({
          type: "geojson",
          geojson: markGeneratedOverlayFeatures(await resolved.service.getDirectionsOverlay(directions)),
          source: "directions",
        });
      } catch (error) {
        errors.push({ path, error: getErrorMessage(error) });
      }
    }

    for (const isochrones of parsed.isochrones) {
      const path = ["isochrones", isochrones.name].filter(Boolean).join(":");
      const resolved = this.resolveRouteService(isochrones.provider ?? blockProvider, mapProviderName, { needsIsochrones: true, origin });

      if (!resolved.service) {
        errors.push({ path, error: resolved.error });
        continue;
      }

      try {
        logger.debug("requesting isochrone overlay", summarizeIsochroneRequest(isochrones));
        const geojson = await resolved.service.getIsochroneOverlay(isochrones);

        logger.debug("isochrone overlay generated", {
          ...summarizeIsochroneRequest(isochrones),
          featureCount: geojson.features?.length ?? 0,
        });
        overlays.push({
          type: "geojson",
          geojson: markGeneratedOverlayFeatures(geojson),
          source: "isochrones",
          renderBand: "background",
          ...(isochrones.zoom ? { zoom: isochrones.zoom } : {}),
        });
      } catch (error) {
        errors.push({ path, error: getErrorMessage(error) });
      }
    }

    return { overlays, errors };
  }

  private resolveRouteService(requested: string | undefined, mapProviderName: string, options?: { needsIsochrones?: boolean; origin?: ApiUsageOrigin }): { service: RouteOverlayService; error?: undefined } | { service?: undefined; error: string } {
    const supportsRequest = (service: RouteOverlayService): boolean =>
      !options?.needsIsochrones || service.getCapabilities?.()?.supportsIsochrones !== false;
    const available = this.routeOverlayServices.getNames();

    if (requested) {
      const service = this.routeOverlayServices.get(requested, options?.origin);

      if (service && supportsRequest(service)) return { service };

      if (service) {
        const capable = available.filter((name) => {
          const candidate = this.routeOverlayServices.get(name);

          return candidate !== undefined && supportsRequest(candidate);
        });

        return {
          error: capable.length > 0
            ? `Provider "${requested}" supports directions only, not isochrones. Providers with isochrones: ${capable.join(", ")}`
            : `Provider "${requested}" supports directions only, not isochrones.`
        };
      }

      return {
        error: available.length > 0
          ? `Unknown directions/isochrone provider "${requested}". Available: ${available.join(", ")}`
          : `Unknown directions/isochrone provider "${requested}". No route providers are installed - enable a provider plugin with routing support (see places-help).`
      };
    }

    const mapProviderService = this.routeOverlayServices.get(mapProviderName, options?.origin);

    if (mapProviderService && supportsRequest(mapProviderService)) return { service: mapProviderService };

    const capable = available.filter(name => {
      const service = this.routeOverlayServices.get(name);

      return service !== undefined && supportsRequest(service);
    });

    if (capable.length > 0) {
      return {
        error: `Map provider "${mapProviderName}" does not provide this routing capability. Set routeProvider explicitly. Available: ${capable.join(", ")}`
      };
    }

    return { error: "No directions/isochrone provider is available. Enable a provider plugin with routing support (see places-help)." };
  }

  getAvailableProviderNames(): string[] {
    return this.routeOverlayServices.getNames();
  }

  getDefaultIsochroneLocationInput(file: TFile | null | undefined): string {
    return file && this.resolveFileWaypoint(file.path) ? "{this.location}" : "";
  }

  resolveParameterMarkers(markers: readonly QueryParameterMapMarker[], places: MapPlace[], sourcePath?: string): MapPlace[] {
    const counts = new Map<string, number>();

    for (const marker of markers) counts.set(marker.parameterName, (counts.get(marker.parameterName) ?? 0) + 1);

    return markers.flatMap(marker => {
      const waypoint = this.resolveWaypointToken(marker.token, places, sourcePath);

      if (!waypoint) {
        logger.warn('Could not resolve query parameter map marker', {
          parameter: marker.parameterName,
          token: marker.token,
          sourcePath,
        });

        return [];
      }

      const parsedCoordinate = parseNamedCoordinate(cleanToken(marker.token));
      const fallbackName = (counts.get(marker.parameterName) ?? 0) > 1
        ? `${marker.label} ${marker.index + 1}`
        : marker.label;
      const name = parsedCoordinate?.name ?? waypoint.name ?? fallbackName;

      return [{
        id: `query-parameter:${marker.parameterName}:${marker.index}`,
        latitude: waypoint.latitude,
        longitude: waypoint.longitude,
        name: name === marker.token ? fallbackName : name,
        icon: marker.icon || waypoint.icon || '📍',
        ...(waypoint.sourcePath ? { filePath: waypoint.sourcePath } : {}),
        metadata: {
          queryParameter: marker.parameterName,
          queryParameterIndex: marker.index,
          queryParameterValue: marker.token,
        },
      }];
    });
  }

  private async resolveDefinitions(settings: ResolvedMapConfig, places: MapPlace[], sourcePath: string | undefined): Promise<ParsedRouteOverlayDefinitions> {
    const errors: Array<{ path: string; error: string }> = [];
    // Skip hidden groups (visible: false, e.g. a `{parameter.*}` toggle) before
    // resolving them, and no directions/isochrone request is issued at all.
    const directions = (await Promise.all(settings.directions.filter(definition => definition.visible).map(definition =>
      this.resolveDirectionsDefinition(definition, places, sourcePath, errors, settings.waypointLabelTemplate)
    ))).filter((request): request is DirectionsOverlayRequest => request !== null);
    const isochrones = settings.isochrones
      .filter(definition => definition.visible)
      .flatMap(definition => this.resolveIsochroneDefinition(definition, places, sourcePath, errors));

    return { directions, isochrones, errors };
  }

  private async resolveDirectionsDefinition(
    definition: DirectionsDefinition,
    places: MapPlace[],
    sourcePath: string | undefined,
    errors: Array<{ path: string; error: string }>,
    blockWaypointLabelTemplate: string | undefined,
  ): Promise<DirectionsOverlayRequest | null> {
    const routes: RouteWaypoint[][] = [];

    for (const routeDefinition of definition.routes) {
      const route = routeDefinition.kind === 'query'
        ? await this.resolveRouteQuery(routeDefinition.query, sourcePath, errors)
        : routeDefinition.waypoints
          .map(token => ({ token, waypoint: this.resolveWaypointToken(token, places, sourcePath) }))
          .filter(entry => {
            if (entry.waypoint) return true;
            errors.push({ path: 'directions', error: `Could not resolve route waypoint "${entry.token}".` });

            return false;
          })
          .map(entry => entry.waypoint as RouteWaypoint);

      if (route.length >= 2) routes.push(route);
      else errors.push({ path: 'directions', error: 'Each route must resolve to at least two waypoints.' });
    }

    if (routes.length === 0) return null;
    const style = {
      ...(definition.style?.color ? { color: definition.style.color } : {}),
      ...(definition.style?.strokeWidth !== undefined ? { strokeWidth: definition.style.strokeWidth } : {}),
      ...(definition.style?.strokeOpacity !== undefined ? { strokeOpacity: definition.style.strokeOpacity } : {}),
    };

    return {
      mode: definition.mode,
      units: this.getUnits(),
      name: definition.name,
      provider: definition.provider,
      cache: definition.cache,
      routes,
      optimize: definition.optimize,
      traffic: definition.traffic || undefined,
      metricLabels: definition.metricLabels,
      labelTemplate: definition.labelTemplate ?? this.getDefaultRouteLabelTemplate(),
      legLabelTemplate: definition.legLabelTemplate,
      waypointLabelTemplate: resolveCascadedLabelTemplate(undefined, definition.waypointLabelTemplate, blockWaypointLabelTemplate ?? '', DEFAULT_WAYPOINT_LABEL_TEMPLATE),
      style: Object.keys(style).length ? style : undefined,
    };
  }

  private resolveIsochroneDefinition(definition: IsochroneDefinition, places: MapPlace[], sourcePath: string | undefined, errors: Array<{ path: string; error: string }>): IsochroneOverlayRequest[] {
    const centers = definition.centers
      .map(token => ({ token, waypoint: this.resolveWaypointToken(token, places, sourcePath) }))
      .filter(entry => {
        if (entry.waypoint) return true;
        errors.push({ path: 'isochrones', error: `Could not resolve isochrone center "${entry.token}".` });

        return false;
      })
      .map(entry => entry.waypoint as RouteWaypoint);

    if (centers.length === 0) return [];
    const colors = definition.style?.colors ?? [];
    const style = {
      ...(colors.length ? { colors: [...colors] } : {}),
      ...(definition.style?.strokeWidth !== undefined ? { strokeWidth: definition.style.strokeWidth } : {}),
      ...(definition.style?.strokeOpacity !== undefined ? { strokeOpacity: definition.style.strokeOpacity } : {}),
      ...(definition.style?.fillOpacity !== undefined ? { fillOpacity: definition.style.fillOpacity } : {}),
    };
    const zoom = normalizeZoomRange({ minZoom: definition.minZoom, maxZoom: definition.maxZoom });
    const requests: IsochroneOverlayRequest[] = [];

    for (const rangeType of ['time', 'distance'] as const) {
      const selected = definition.ranges
        .map((range, index) => ({ range, index }))
        .filter(({ range }) => range.type === rangeType);

      if (selected.length === 0) continue;
      const selectedStyle = {
        ...style,
        ...(colors.length ? { colors: selected.map(({ index }) => colors[index % colors.length]) } : {}),
      };

      requests.push({
        mode: definition.mode,
        units: this.getUnits(),
        name: definition.name,
        provider: definition.provider,
        cache: definition.cache,
        rangeType,
        ranges: selected.map(({ range }) => range.value),
        centers,
        polygons: definition.polygons,
        traffic: definition.traffic || undefined,
        zoom,
        style: Object.keys(selectedStyle).length ? selectedStyle : undefined,
      });
    }

    return requests;
  }
  private async resolveRouteQuery(query: string, sourcePath: string | undefined, errors: Array<{ path: string; error: string }>): Promise<RouteWaypoint[]> {
    if (!this.vaultQueryService) {
      errors.push({ path: "directions", error: "VaultQuery service is not available for route query entries" });

      return [];
    }

    try {
      const { places, errors: queryErrors } = await this.vaultQueryService.extractFromQuery(query, sourcePath);

      if (queryErrors.length > 0) {
        errors.push(...queryErrors);

        return [];
      }

      return places.map((place) => ({
        latitude: place.latitude,
        longitude: place.longitude,
        name: place.originalName ?? place.name,
        sourcePath: place.filePath ?? scalarToString(place.metadata?.sourceFile),
        ...(place.icon ? { icon: place.icon } : {}),
      }));
    } catch (error) {
      errors.push({ path: "directions", error: getErrorMessage(error) });

      return [];
    }
  }

  // One Map per places array, built lazily and keyed by every matchable
  // identifier. Earlier places win a key.
  private waypointLookupByPlaces = new WeakMap<MapPlace[], Map<string, MapPlace>>();

  private getWaypointLookup(places: MapPlace[]): Map<string, MapPlace> {
    let lookup = this.waypointLookupByPlaces.get(places);

    if (!lookup) {
      lookup = new Map<string, MapPlace>();

      for (const place of places) {
        const keys = [place.filePath, place.name, place.originalName, place.metadata?.sourceFile];

        for (const key of keys) {
          if (typeof key === "string" && key && !lookup.has(key)) {
            lookup.set(key, place);
          }
        }
      }

      this.waypointLookupByPlaces.set(places, lookup);
    }

    return lookup;
  }

  private resolveWaypointToken(token: string, places: MapPlace[], sourcePath?: string): RouteWaypoint | null {
    const cleaned = cleanToken(token);

    if (!cleaned) return null;

    const currentNoteReference = cleaned.match(/^\{?this(?:\.([^{}]+))?\}?$/i);

    if (currentNoteReference && sourcePath) {
      return this.resolveFileWaypoint(sourcePath, currentNoteReference[1]);
    }

    const coordinate = parseNamedCoordinate(cleaned);

    if (coordinate) {
      return coordinate.name ? coordinate : { ...coordinate, name: cleaned };
    }

    const linkTarget = stripWikiLink(cleaned);
    const normalizedPath = normalizePath(linkTarget.replace(/\.md$/i, "") + (linkTarget.endsWith(".md") ? "" : ".md"));
    const lookup = this.getWaypointLookup(places);
    const fromPlaces = lookup.get(cleaned) ?? lookup.get(linkTarget) ?? lookup.get(normalizedPath);

    if (fromPlaces) {
      return {
        latitude: fromPlaces.latitude,
        longitude: fromPlaces.longitude,
        name: fromPlaces.originalName ?? fromPlaces.name,
        sourcePath: fromPlaces.filePath ?? scalarToString(fromPlaces.metadata?.sourceFile),
        ...(fromPlaces.icon ? { icon: fromPlaces.icon } : {}),
      };
    }

    return this.resolveFileWaypoint(linkTarget);
  }

  private resolveFileWaypoint(token: string, locationProperty?: string): RouteWaypoint | null {
    const path = this.resolveFilePath(token);

    if (!path) return null;
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));

    if (!(file instanceof TFile)) return null;
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const location: unknown = this.readFrontmatterProperty(frontmatter, locationProperty ?? 'Location');
    const coordinate = parseNamedCoordinate(location);

    if (!coordinate) return null;
    const icon = scalarToString(this.readFrontmatterProperty(frontmatter, 'icon'));

    return { ...coordinate, name: coordinate.name ?? file.basename, sourcePath: file.path, ...(icon ? { icon } : {}) };
  }

  private readFrontmatterProperty(frontmatter: Record<string, unknown> | undefined, property: string): unknown {
    if (!frontmatter) return undefined;
    const target = normalizePropertyName(property);
    const key = Object.keys(frontmatter).find(candidate => normalizePropertyName(candidate) === target);

    return key === undefined ? undefined : frontmatter[key];
  }

  private resolveFilePath(token: string): string | null {
    const link = stripWikiLink(token);
    const direct = normalizePath(link.endsWith(".md") ? link : `${link}.md`);

    if (this.app.vault.getAbstractFileByPath(direct) instanceof TFile) return direct;
    const destination = this.app.metadataCache.getFirstLinkpathDest(link.replace(/\.md$/i, ""), "");

    return destination?.path ?? null;
  }
}

function summarizeIsochroneRequest(request: IsochroneOverlayRequest): Record<string, unknown> {
  return {
    name: request.name,
    mode: request.mode,
    rangeType: request.rangeType,
    ranges: request.ranges,
    centerCount: request.centers.length,
    centers: request.centers.map((center) => ({
      name: center.name,
      latitude: center.latitude,
      longitude: center.longitude,
    })),
    polygons: request.polygons,
    colorCount: request.style?.colors?.length ?? 0,
  };
}

function stripWikiLink(value: string): string {
  const trimmed = cleanToken(value);
  const match = trimmed.match(/^\[\[([^|\]]+)(?:\|[^\]]+)?\]\]$/);

  return match?.[1]?.trim() ?? trimmed;
}

function cleanToken(value: string): string {
  return value
    .trim()
    .replace(/^-\s*/, "")
    .replace(/^["']|["']$/g, "")
    .replace(/,$/, "")
    .trim();
}
