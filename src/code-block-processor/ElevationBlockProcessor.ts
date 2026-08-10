import { App, MarkdownPostProcessorContext, TFile } from "obsidian";
import { createLoadingIndicator } from "places-shared/ui";
import { UnitsSystem, formatMetersInSystem, meters } from "places-shared/units";
import { normalizeChartBlockSettings } from "places-shared/settings";
import { IElevationService } from "places-shared/services";
import { getErrorMessage, renderErrorWithHelp, logger as rootLogger } from "places-shared/utils";
import PlacesPlugin from "../main";
import { ChartService } from "../services/ChartService";
import { optionalStringSetting, parseCodeBlock } from "../services/CodeBlockParser";
import { TrackData, TrackDataService } from "../services/TrackDataService";
import { registerRefreshableCodeBlock, renderHoverPlaceholder, createOwnNoteEditRefreshGuard } from "./RefreshableCodeBlock";
import { disposeManagedChart, registerManagedChart } from "./ManagedChartRenderChild";
import { renderTrackActionBar } from "./TrackActionBar";
import { BlockParameterSupport } from "../services/BlockParameters";

const logger = rootLogger.scope("places-elevation");

interface ElevationBlockSettings {
  track: string;
  provider?: string;
  height: string;
  width: string;
  title: string;
  showGrid: unknown;
  showPoints: unknown;
  smoothing: unknown;
  fillArea: unknown;
}

export class ElevationBlockProcessor {
  private chartService = new ChartService();

  constructor(private app: App, private trackDataService: TrackDataService, private blockParameters: BlockParameterSupport) {}

  private get units(): UnitsSystem {
    return PlacesPlugin.settings.units;
  }

  async processCodeBlock(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
    disposeManagedChart(el);
    if (renderHoverPlaceholder(el, "📈 Elevation preview not available in hover")) return;

    const parsed = parseCodeBlock(source);
    const parameters = await this.blockParameters.apply(parsed, el, ctx);
    registerRefreshableCodeBlock({
      source,
      el,
      ctx,
      process: (src, container, context) => this.processCodeBlock(src, container, context),
      shouldAutoRefresh: createOwnNoteEditRefreshGuard(source, ctx.sourcePath),
      ariaLabel: "Recalculate elevation",
      onError: error => logger.error("Recalculate elevation failed:", error),
      usesParameters: parameters !== null,
    });

    const settings = this.parseSettings(parsed.settings);
    const elevationService = this.resolveElevationService(settings.provider);
    if (!elevationService.service) {
      renderErrorWithHelp(el, { icon: "⚠️", title: "Elevation provider unavailable", message: elevationService.error });
      await parameters?.renderStrip();
      return;
    }

    const trackInput = settings.track || `"${ctx.sourcePath}"`;
    const loading = createLoadingIndicator(el, "Fetching elevation profile...");

    try {
      const original = await this.trackDataService.loadTrackFromPath(trackInput, ctx.sourcePath, { skipCache: true });
      if (original.points.length < 2) {
        throw new Error("The track needs at least two points to fetch an elevation profile");
      }

      const candidate = await this.trackDataService.populateWithElevation(original, elevationService.service, { replaceExisting: true });

      loading.remove();
      this.renderPreview(el, ctx, settings, trackInput, original, candidate, elevationService.service);
    } catch (error) {
      loading.remove();
      logger.error("Elevation preview failed:", error);
      renderErrorWithHelp(el, { icon: "⚠️", title: "Elevation preview failed", message: getErrorMessage(error) });
    }
    await parameters?.renderStrip();
  }

  private parseSettings(pairs: Record<string, unknown>): ElevationBlockSettings {
    return {
      track: optionalStringSetting(pairs, 'track')?.trim() ?? "",
      provider: optionalStringSetting(pairs, 'provider')?.trim().toLowerCase() || undefined,
      height: optionalStringSetting(pairs, 'height') || "320px",
      width: optionalStringSetting(pairs, 'width') || "100%",
      title: optionalStringSetting(pairs, 'title') || "Elevation Replacement Preview",
      showGrid: pairs.showGrid ?? true,
      showPoints: pairs.showPoints ?? false,
      smoothing: pairs.smoothing ?? true,
      fillArea: pairs.fillArea ?? false,
    };
  }

  private resolveElevationService(requested: string | undefined): { service?: IElevationService; error: string } {
    const available = PlacesPlugin.getElevationServiceNames();

    if (requested) {
      const service = PlacesPlugin.getElevationService(requested);
      if (service) return { service, error: "" };
      return {
        error: available.length > 0
          ? `Unknown elevation provider "${requested}". Available: ${available.join(", ")}`
          : `Unknown elevation provider "${requested}". No elevation providers are installed - enable a provider plugin with elevation support (see places-help).`
      };
    }

    const service = PlacesPlugin.getFirstElevationService();
    if (service) return { service, error: "" };
    return { error: "No elevation provider is available. Enable a provider plugin with elevation support (see places-help)." };
  }

  private renderPreview(
    el: HTMLElement,
    ctx: MarkdownPostProcessorContext,
    settings: ElevationBlockSettings,
    trackInput: string,
    original: TrackData,
    candidate: TrackData,
    elevationService: IElevationService,
  ): void {
    const container = el.createDiv({ cls: "places-elevation-container places-chart-container" });
    const chartEl = container.createDiv({ cls: "places-elevation-chart places-chart" });
    chartEl.setCssProps({
      "--places-chart-height": settings.height,
    });
    if (settings.width !== "100%") {
      chartEl.setCssProps({
        "--places-chart-width": settings.width,
      });
    }

    const hasOriginalElevation = this.trackDataService.hasElevationData(original);
    const chartSettings = normalizeChartBlockSettings({
      height: settings.height,
      width: settings.width,
      title: settings.title,
      chartType: "elevation",
      showGrid: settings.showGrid,
      showPoints: settings.showPoints,
      smoothing: settings.smoothing,
      fillArea: settings.fillArea,
      stats: "",
    });

    const targetFile = this.trackDataService.resolveMarkdownTrackFile(trackInput, ctx.sourcePath);
    const trackName = targetFile?.basename ?? original.metadata.name ?? "Track";
    const existingLabel = trackName;
    const replacementLabel = `${elevationService.getProviderName()} replacement`;
    const chart = hasOriginalElevation
      ? this.chartService.createComparisonChart(
        chartEl,
        { data: original, name: existingLabel },
        { data: candidate, name: replacementLabel },
        chartSettings,
        this.units,
      )
      : this.chartService.createChart(chartEl, candidate, chartSettings, this.units);

    registerManagedChart(ctx, el, chartEl, chart);

    this.renderSummary(container, original, candidate, elevationService, hasOriginalElevation, targetFile, existingLabel, replacementLabel);
    renderTrackActionBar({
      app: this.app,
      container,
      trackDataService: this.trackDataService,
      sourcePath: ctx.sourcePath,
      targetFile,
      trackData: { ...candidate, metadata: { ...candidate.metadata, source: "manual" } },
      replaceLabel: targetFile ? `Replace elevation in "${targetFile.basename}"` : "Replace elevation",
      replaceSuccess: targetFile ? `Replaced elevation in "${targetFile.basename}" using ${elevationService.getProviderName()}.` : "",
      replaceDisabledTitle: "Replacement is only available for markdown track notes",
      exportName: `${trackName} (elevation)`,
    });
  }

  private renderSummary(
    container: HTMLElement,
    original: TrackData,
    candidate: TrackData,
    _elevationService: IElevationService,
    hasOriginalElevation: boolean,
    _targetFile: TFile | null,
    existingLabel: string,
    replacementLabel: string,
  ): void {
    const stats = container.createDiv({ cls: "places-stats-grid places-elevation-stats" });
    this.addElevationStat(stats, `${existingLabel} gain`, hasOriginalElevation ? original.metrics.elevationGain : undefined);
    this.addElevationStat(stats, `${replacementLabel} gain`, candidate.metrics.elevationGain);
    this.addElevationStat(stats, `${existingLabel} range`, hasOriginalElevation ? this.formatRange(original) : undefined);
    this.addElevationStat(stats, `${replacementLabel} range`, this.formatRange(candidate));
  }

  private addElevationStat(container: HTMLElement, label: string, value: string | number | undefined): void {
    const stat = container.createDiv({ cls: "places-stat" });
    stat.createDiv({ cls: "places-stat-value", text: typeof value === "number" ? formatMetersInSystem(meters(value), this.units) : value ?? "n/a" });
    stat.createDiv({ cls: "places-stat-label", text: label });
  }

  private formatRange(trackData: TrackData): string | undefined {
    const min = trackData.metrics.minElevation;
    const max = trackData.metrics.maxElevation;
    if (min === undefined || max === undefined) return undefined;
    return `${formatMetersInSystem(min, this.units)} - ${formatMetersInSystem(max, this.units)}`;
  }
}
