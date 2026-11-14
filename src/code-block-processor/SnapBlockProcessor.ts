import { isRecord, logger as rootLogger, scalarToString } from "places-shared/utils";
import { applyBlockWidth, createLoadingIndicator, RenderStalenessGuard } from "places-shared/obsidian/ui";
import { App, MarkdownPostProcessorContext, TFile } from "obsidian";
import { parseBooleanOptional, parseEnum, parseEnumWithDefault, parseShortDistanceAsMeters } from "places-shared/settings";
import { ISnapService, type ApiUsageOrigin, RouteTravelMode, SnapExclusion, SnapMatchedEdge, SnapRequest, SnapShapeMatch, SnappedPoint, VALHALLA_TRACE_EDGE_ATTRIBUTES, summarizeMatchedSurfaces, summarizeMatchedWayNames } from "places-shared/services";
import { TrackPointProcessor, RawTrackPoint } from 'places/core';
import { renderErrorWithHelp, getErrorMessage } from "places-shared/utils";
import PlacesPlugin from "../main";
import { optionalStringSetting, parseCodeBlock } from 'places/core';
import { TrackDataService, TrackData } from "../services/TrackDataService";
import { renderTrackPreviewMap } from "./TrackMapPreview";
import { renderTrackActionBar } from "./TrackActionBar";
import { registerRefreshableCodeBlock, createTrackFileRefreshGuard } from "./RefreshableCodeBlock";
import { renderHoverPlaceholder } from "places-shared/obsidian/ui";
import { BlockRefreshRegistry } from "../services/BlockRefreshRegistry";
import { BlockParameterSupport } from "../services/BlockParameters";
import { cleanupMapContainer } from "../services/MapSurfaceCleanup";

const logger = rootLogger.scope('places-snap');

const ORIGINAL_COLOR = "#9e9e9e";
const SNAPPED_COLOR = "#16a34a";

// `exclude` accepts a comma-separated string or a YAML list; unknown names are dropped.
function parseSnapExclusions(raw: unknown): SnapExclusion[] | undefined {
  const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  const parsed = values
    .map(value => scalarToString(value).trim().toLowerCase())
    .filter((value): value is SnapExclusion => value === 'motorway' || value === 'toll' || value === 'ferry');

  return parsed.length > 0 ? parsed : undefined;
}

// Unnamed ways are ordinary on trails; an empty name list reports the count instead.
function renderMatchedWaySummary(el: HTMLElement, edges: SnapMatchedEdge[] | undefined): void {
  if (!edges?.length) return;
  const names = summarizeMatchedWayNames(edges);
  const surfaces = summarizeMatchedSurfaces(edges);
  const parts: string[] = [];

  parts.push(names.length > 0 ? `Ways: ${names.join(', ')}` : `Ways: ${edges.length} unnamed`);
  if (surfaces.length > 0) parts.push(`Surfaces: ${surfaces.join(', ')}`);
  el.createDiv({ cls: 'places-action-status', text: parts.join('. ') });
}

interface SnapBlockSettings {
  track: string;
  provider?: string;
  mode: RouteTravelMode;
  radiusMeters?: number;
  // Valhalla costing name, overriding the one `mode` resolves to.
  costing?: string;
  // Verbatim `costingOptions:` block, scoped to the effective costing by the provider.
  costingOptions?: Record<string, unknown>;
  timestamps?: boolean;
  tidy?: boolean;
  exclude?: SnapExclusion[];
  shapeMatch?: SnapShapeMatch;
  // Verbatim `traceOptions:` block: Valhalla's matcher tuning.
  traceOptions?: Record<string, unknown>;
  wayDetails?: boolean;
  height: string;
  width: string;
  mapProvider: string;
  style?: string;
  poiDiscovery?: boolean;
}

export class SnapBlockProcessor {
  private static renders = new WeakMap<HTMLElement, RenderStalenessGuard>();

  constructor(private app: App, private trackDataService: TrackDataService, private blockParameters: BlockParameterSupport) {}

  async processCodeBlock(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
    if (renderHoverPlaceholder(el, '🗺️ Snap preview not available in hover')) return;

    const previous = SnapBlockProcessor.renders.get(el);

    if (previous) previous.superseded = true;
    const guard = new RenderStalenessGuard(el, ctx.sourcePath);

    SnapBlockProcessor.renders.set(el, guard);
    ctx.addChild(guard);
    const isStale = () => guard.superseded;

    for (const map of el.querySelectorAll<HTMLElement>('.places-map-container')) cleanupMapContainer(map);
    el.empty();

    const parsed = parseCodeBlock(source);
    const autoRefresh = parsed.settings.autorefresh;
    const parameters = await this.blockParameters.apply(parsed, el, ctx);

    if (isStale()) return;
    registerRefreshableCodeBlock({
      autoRefresh,
      source,
      el,
      ctx,
      process: (src, container, context) => this.processCodeBlock(src, container, context),
      shouldAutoRefresh: createTrackFileRefreshGuard(source, ctx.sourcePath,
        typeof parsed.settings.track === 'string' && parsed.settings.track.trim() ? [parsed.settings.track] : [],
        (input, sourcePath) => this.trackDataService.resolveTrackFile(input, sourcePath)),
      ariaLabel: 'Re-snap track',
      onError: error => logger.error('Re-snap failed:', error),
      usesParameters: parameters !== null,
    });

    const settings = this.parseSettings(parsed.settings);
    const snapService = this.resolveSnapService(settings.provider, { sourcePath: ctx.sourcePath, blockType: 'places-snap' });

    if (!snapService.service) {
      renderErrorWithHelp(el, { icon: "⚠️", title: "Snap provider unavailable", message: snapService.error });
      await parameters?.renderStrip();

      return;
    }

    const trackInput = settings.track || `"${ctx.sourcePath}"`;
    const loading = createLoadingIndicator(el, "Snapping track to roads...");

    try {
      const trackData = await this.trackDataService.loadTrackFromPath(trackInput, ctx.sourcePath, { skipCache: true });

      if (isStale()) return;

      if (trackData.points.length < 2) {
        throw new Error("The track needs at least two points to snap");
      }

      const snapRequest: SnapRequest = {
        points: trackData.points,
        mode: settings.mode,
        costing: settings.costing,
        costingOptions: settings.costingOptions,
        radiusMeters: settings.radiusMeters,
        timestamps: settings.timestamps,
        tidy: settings.tidy,
        exclude: settings.exclude,
        shapeMatch: settings.shapeMatch,
        traceOptions: settings.traceOptions,
        units: PlacesPlugin.settings.units,
        attributes: settings.wayDetails ? VALHALLA_TRACE_EDGE_ATTRIBUTES : undefined,
      };
      const unsupported = snapService.service.describeUnsupportedRequest?.(snapRequest) ?? [];
      const snapResult = await snapService.service.snapPoints(snapRequest);

      if (isStale()) return;

      loading.remove();

      for (const note of unsupported) {
        el.createDiv({ cls: 'places-action-status', text: note });
      }

      renderMatchedWaySummary(el, snapResult.edges);

      await this.renderPreview(el, ctx, settings, trackInput, trackData, snapResult.points, snapService.service, isStale);
    } catch (error) {
      if (isStale()) return;
      loading.remove();
      logger.error('Snap failed:', error);
      renderErrorWithHelp(el, { icon: "⚠️", title: "Snap failed", message: getErrorMessage(error) });
    }

    if (!isStale()) await parameters?.renderStrip();
  }

  private parseSettings(pairs: Record<string, unknown>): SnapBlockSettings {
    return {
      track: optionalStringSetting(pairs, 'track')?.trim() ?? "",
      provider: optionalStringSetting(pairs, 'provider')?.trim().toLowerCase() || undefined,
      mode: parseEnumWithDefault(pairs.mode, ['drive', 'walk', 'bike'] as const, 'drive'),
      radiusMeters: parseShortDistanceAsMeters(pairs.radius, PlacesPlugin.settings.units),
      costing: optionalStringSetting(pairs, 'costing')?.trim() || undefined,
      costingOptions: isRecord(pairs.costingOptions) ? pairs.costingOptions : undefined,
      timestamps: parseBooleanOptional(pairs.timestamps),
      tidy: parseBooleanOptional(pairs.tidy),
      exclude: parseSnapExclusions(pairs.exclude),
      shapeMatch: parseEnum(pairs.shapeMatch, ['map_snap', 'edge_walk', 'walk_or_snap'] as const),
      traceOptions: isRecord(pairs.traceOptions) ? pairs.traceOptions : undefined,
      wayDetails: parseBooleanOptional(pairs.wayDetails),
      height: optionalStringSetting(pairs, 'height') || "400px",
      width: optionalStringSetting(pairs, 'width') || "100%",
      mapProvider: PlacesPlugin.resolveMapProvider(optionalStringSetting(pairs, 'mapProvider')),
      style: optionalStringSetting(pairs, 'style'),
      poiDiscovery: parseBooleanOptional(pairs.poiDiscovery),
    };
  }

  private resolveSnapService(requested: string | undefined, origin: ApiUsageOrigin): { service?: ISnapService; error: string } {
    const available = PlacesPlugin.getSnapServiceNames();

    if (requested) {
      const service = PlacesPlugin.getSnapService(requested, origin);

      if (service) return { service, error: "" };

      return {
        error: available.length > 0
          ? `Unknown snap provider "${requested}". Available: ${available.join(", ")}`
          : `Unknown snap provider "${requested}". No snap providers are installed - enable a provider plugin with snap support (see places-help).`
      };
    }

    const service = PlacesPlugin.getFirstSnapService(origin);

    if (service) return { service, error: "" };

    return { error: "No snap provider is available. Enable a provider plugin with snap support (see places-help)." };
  }

  private async renderPreview(el: HTMLElement, ctx: MarkdownPostProcessorContext, settings: SnapBlockSettings, trackInput: string, original: TrackData, snappedPoints: SnappedPoint[], snapService: ISnapService, isStale: () => boolean): Promise<void> {
    applyBlockWidth(el, settings.width);
    const container = el.createDiv({ cls: "places-snap-container" });

    const targetFile = this.resolveTrackFile(trackInput, ctx.sourcePath);
    const trackName = original.metadata.name ?? "Track";

    const rendered = await renderTrackPreviewMap({
      host: container,
      mapContainerClass: "places-snap-map",
      ctx,
      isStale,
      onRerenderRequested: () => BlockRefreshRegistry.refreshForElement(el).then(() => undefined),
      mapProviderName: settings.mapProvider,
      height: settings.height,
      style: settings.style,
      tracks: [
        { name: `${trackName} (original)`, icon: "⚪", coordinates: original.points.map((point) => [point.longitude, point.latitude]), color: ORIGINAL_COLOR, lineStyle: 'dashed' },
        { name: `${trackName} (snapped)`, icon: "🟢", coordinates: snappedPoints.map((point) => [point.longitude, point.latitude]), color: SNAPPED_COLOR, lineStyle: 'solid' },
      ],
      poiDiscovery: settings.poiDiscovery ?? false,
    });

    if (!rendered || isStale()) return;

    const snappedCount = snappedPoints.filter((point) => point.snapped).length;
    const info = container.createEl("p", { cls: "places-snap-info" });

    info.setText(`${snapService.getProviderName()} snapped ${snappedCount} of ${snappedPoints.length} points (${settings.mode}${settings.radiusMeters !== undefined ? `, ${settings.radiusMeters}m radius` : ''}).`);

    const rawPoints: RawTrackPoint[] = snappedPoints.map((point, index) => ({
      latitude: point.latitude,
      longitude: point.longitude,
      elevationMeters: original.points[index]?.elevationMeters,
      time: original.points[index]?.time,
    }));
    const { points, metrics } = TrackPointProcessor.processTrackData(rawPoints);
    const snappedTrack: TrackData = {
      points,
      metrics,
      waypoints: original.waypoints,
      metadata: { ...original.metadata, source: 'manual' },
    };

    renderTrackActionBar({
      app: this.app,
      container,
      trackDataService: this.trackDataService,
      sourcePath: ctx.sourcePath,
      targetFile,
      trackData: snappedTrack,
      replaceLabel: targetFile ? `Replace overlay in "${targetFile.basename}"` : "Replace overlay",
      replaceSuccess: targetFile ? `Replaced overlay in "${targetFile.basename}" with the snapped track.` : "",
      replaceDisabledTitle: "Replacing is only available for markdown track notes",
      exportName: `${trackName} (snapped)`,
    });
  }

  private resolveTrackFile(trackInput: string, sourcePath: string): TFile | null {
    return this.trackDataService.resolveMarkdownTrackFile(trackInput, sourcePath);
  }
}
