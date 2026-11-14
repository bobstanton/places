import { logger as rootLogger } from "places-shared/utils";
import { applyBlockWidth, createLoadingIndicator } from "places-shared/obsidian/ui";
import { App, MarkdownPostProcessorContext } from "obsidian";
import { formatKmInSystem, formatMetersInSystem, km, meters, Meters, UnitsSystem } from "places-shared/units";
import { parseBoolean, parseBooleanOptional, parseShortDistanceAsMeters, conditionalProps } from "places-shared/settings";
import { renderError, renderErrorWithHelp, formatDisplayCoordinate, getErrorMessage } from "places-shared/utils";
import PlacesPlugin from "../main";
import { BlockParameterSupport } from "../services/BlockParameters";
import { ParsedCodeBlock, optionalStringSetting, parseCodeBlock } from 'places/core';
import { TrackDataService, TrackData } from "../services/TrackDataService";
import { TrackComparisonService, TrackComparisonResult, DirectionRelationship } from "../services/TrackComparisonService";
import { renderTrackPreviewMap } from "./TrackMapPreview";
import { registerRefreshableCodeBlock, createTrackFileRefreshGuard } from "./RefreshableCodeBlock";
import { renderHoverPlaceholder } from "places-shared/obsidian/ui";
import { BlockRefreshRegistry } from "../services/BlockRefreshRegistry";

const logger = rootLogger.scope('places-compare');

interface CompareTracksBlockSettings {
  track1: string;
  track2: string;
  toleranceMeters: Meters;
  height: string;
  width: string;
  mapProvider: string;
  showMiniMap: boolean;
  showMetrics: boolean;
  style?: string;
  poiDiscovery?: boolean;
}

const DEFAULT_COMPARE_SETTINGS: CompareTracksBlockSettings = {
  track1: "",
  track2: "",
  toleranceMeters: meters(50),
  height: "300px",
  width: "100%",
  mapProvider: "",
  showMiniMap: true,
  showMetrics: true
};

export class CompareTracksBlockProcessor {
  private trackDataService: TrackDataService;
  private comparisonService: TrackComparisonService;
  private units: UnitsSystem;

  constructor(private app: App, trackDataService: TrackDataService, private blockParameters: BlockParameterSupport) {
    this.trackDataService = trackDataService;
    this.comparisonService = new TrackComparisonService();
    this.units = PlacesPlugin.settings.units;
  }

  async processCodeBlock(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
    if (renderHoverPlaceholder(el, '🗺️ Track comparison preview not available in hover')) return;

    const parsed = parseCodeBlock(source);
    const autoRefresh = parsed.settings.autorefresh;
    const parameters = await this.blockParameters.apply(parsed, el, ctx);

    registerRefreshableCodeBlock({
      autoRefresh,
      source,
      el,
      ctx,
      process: (src, container, context) => this.processCodeBlock(src, container, context),
      shouldAutoRefresh: createTrackFileRefreshGuard(source, ctx.sourcePath,
        [parsed.settings.track1, parsed.settings.track2].filter((value): value is string => typeof value === 'string' && value.trim() !== ''),
        (input, sourcePath) => this.trackDataService.resolveTrackFile(input, sourcePath)),
      ariaLabel: 'Refresh comparison',
      onError: error => logger.error('Refresh comparison failed:', error),
      usesParameters: parameters !== null,
    });

    try {
      const settings = this.parseSettings(parsed);

      applyBlockWidth(el, settings.width);

      if (!settings.track1 || !settings.track2) {
        renderError(el, {
          icon: "⚠️",
          title: "Missing Track Files",
          message: "Both track1 and track2 must be specified."
        });
        el.createEl("p", {
          text: "Example: track1: [[path/to/track1.md]]",
          cls: "places-muted"
        });

        return;
      }

      const track1File = this.trackDataService.resolveTrackFile(settings.track1, ctx.sourcePath);
      const track2File = this.trackDataService.resolveTrackFile(settings.track2, ctx.sourcePath);

      if (!track1File) {
        renderError(el, {
          icon: "⚠️",
          title: "Track 1 Not Found",
          message: `File not found: ${settings.track1}`
        });

        return;
      }

      if (!track2File) {
        renderError(el, {
          icon: "⚠️",
          title: "Track 2 Not Found",
          message: `File not found: ${settings.track2}`
        });

        return;
      }

      const loading = createLoadingIndicator(el, "Loading track data...");

      let track1Data: TrackData;
      let track2Data: TrackData;

      try {
        track1Data = await this.trackDataService.loadTrackFromPath(settings.track1, ctx.sourcePath, { skipCache: true });
        track2Data = await this.trackDataService.loadTrackFromPath(settings.track2, ctx.sourcePath, { skipCache: true });
      } catch (error) {
        loading.remove();

        throw error;
      }

      if (track1Data.points.length < 2) {
        loading.remove();
        renderError(el, {
          icon: "⚠️",
          title: "Insufficient Track Data",
          message: `${settings.track1} needs at least 2 points for comparison.`
        });

        return;
      }

      if (track2Data.points.length < 2) {
        loading.remove();
        renderError(el, {
          icon: "⚠️",
          title: "Insufficient Track Data",
          message: `${settings.track2} needs at least 2 points for comparison.`
        });

        return;
      }

      const track1Coords = track1Data.points;
      const track2Coords = track2Data.points;

      loading.setText("Analyzing tracks...");

      const result = this.comparisonService.compare(
        track1Coords, track1File,
        track2Coords, track2File,
        settings.toleranceMeters,
        track1Data.points,
        track2Data.points
      );

      result.track1Name = this.app.metadataCache.fileToLinktext(track1File, ctx.sourcePath, true);
      result.track2Name = this.app.metadataCache.fileToLinktext(track2File, ctx.sourcePath, true);

      loading.remove();

      await this.renderOutput(el, result, settings, ctx);
    } catch (error) {
      logger.error("Error in places-compare code block:", error);
      renderErrorWithHelp(el, {
        icon: "⚠️",
        title: "Comparison Error",
        message: getErrorMessage(error)
      });
    } finally {
      await parameters?.renderStrip();
    }
  }

  private parseSettings(parsed: ParsedCodeBlock): CompareTracksBlockSettings {
    const pairs = parsed.settings;
    const settings: CompareTracksBlockSettings = { ...DEFAULT_COMPARE_SETTINGS };

    settings.mapProvider = PlacesPlugin.resolveMapProvider(optionalStringSetting(pairs, 'mapProvider'));
    settings.showMiniMap = parseBoolean(pairs.showMiniMap, settings.showMiniMap);
    settings.showMetrics = parseBoolean(pairs.showMetrics, settings.showMetrics);

    Object.assign(settings, conditionalProps({
      track1: optionalStringSetting(pairs, 'track1'),
      track2: optionalStringSetting(pairs, 'track2'),
      toleranceMeters: parseShortDistanceAsMeters(pairs.tolerance, this.units),
      height: optionalStringSetting(pairs, 'height'),
      width: optionalStringSetting(pairs, 'width'),
      style: optionalStringSetting(pairs, 'style'),
      poiDiscovery: parseBooleanOptional(pairs.poiDiscovery),
    }));

    return settings;
  }

  private async renderOutput(container: HTMLElement, result: TrackComparisonResult, settings: CompareTracksBlockSettings, ctx: MarkdownPostProcessorContext): Promise<void> {
    const outputContainer = container.createDiv({ cls: "places-compare" });

    this.renderHeader(outputContainer, result);

    if (settings.showMiniMap) {
      await this.renderMiniMap(outputContainer, result, settings, ctx);
    }

    if (settings.showMetrics) {
      this.renderMetrics(outputContainer, result);
    }
  }

  private renderHeader(container: HTMLElement, result: TrackComparisonResult): void {
    const header = container.createDiv({ cls: "places-compare-header" });

    header.createEl("h3", {
      text: `${result.track1Name} vs ${result.track2Name}`,
      cls: "places-compare-title"
    });

    const summary = header.createEl("p");

    summary.textContent = this.generateSummary(result);
  }

  private generateSummary(result: TrackComparisonResult): string {
    const directionText = result.direction === 'same' ? 'same direction' :
                          result.direction === 'opposite' ? 'opposite directions' : 'mixed directions';

    switch (result.relationship) {
      case 'no-overlap':
        return `Tracks don't share any common route. Closest approach: ${Math.round(result.closestApproachMeters ?? 0)}m.`;

      case 'nearly-identical':
        return `Tracks are nearly identical (${Math.round(result.track1OverlapPercent)}% / ${Math.round(result.track2OverlapPercent)}% overlap, ${directionText}).`;

      case 'subset':
        if (result.track1OverlapPercent > result.track2OverlapPercent) {
          return `${result.track1Name} is mostly contained within ${result.track2Name} (${Math.round(result.track1OverlapPercent)}% overlap).`;
        } else {
          return `${result.track2Name} is mostly contained within ${result.track1Name} (${Math.round(result.track2OverlapPercent)}% overlap).`;
        }

      case 'continuation': {
        const gapPoint = result.divergencePoints.find(p => p.type === 'continuation-gap');
        const gapText = gapPoint?.gapDistanceMeters ? ` with ${Math.round(gapPoint.gapDistanceMeters)}m gap` : '';

        return `Tracks appear to be a continuation of each other${gapText}.`;
      }

      case 'partial-overlap':
      default:
        return `Tracks share ${formatKmInSystem(result.sharedDistanceKm, this.units, 1)} of route (${Math.round(result.track1OverlapPercent)}% / ${Math.round(result.track2OverlapPercent)}% overlap, ${directionText}).`;
    }
  }

  private async renderMiniMap(container: HTMLElement, result: TrackComparisonResult, settings: CompareTracksBlockSettings, ctx: MarkdownPostProcessorContext): Promise<void> {
    await renderTrackPreviewMap({
      host: container,
      mapContainerClass: "places-compare-map",
      ctx,
      onRerenderRequested: () => BlockRefreshRegistry.refreshForElement(container).then(() => undefined),
      mapProviderName: settings.mapProvider,
      height: settings.height,
      style: settings.style,
      tracks: [
        { name: result.track1Name, icon: "🔵", coordinates: result.track1Coordinates.map(c => [c.longitude, c.latitude]), color: '#2196F3', lineStyle: 'solid', filePath: result.track1Path },
        { name: result.track2Name, icon: "🟠", coordinates: result.track2Coordinates.map(c => [c.longitude, c.latitude]), color: '#FF9800', lineStyle: 'solid', filePath: result.track2Path },
      ],
      poiDiscovery: settings.poiDiscovery ?? false,
    });
  }

  private renderMetrics(container: HTMLElement, result: TrackComparisonResult): void {
    const metricsContainer = container.createDiv({ cls: "places-compare-metrics" });

    const overlapSection = metricsContainer.createDiv({ cls: "places-compare-section" });

    overlapSection.createEl("h4", { text: "Overlap analysis", cls: "places-compare-section-title" });

    const overlapContent = overlapSection.createDiv({ cls: "places-compare-overlap" });

    const line1 = overlapContent.createDiv();

    line1.appendText(`${result.track1OverlapPercent.toFixed(1)}% of `);
    line1.createEl("code", { text: result.track1Name });
    line1.appendText(` follows `);
    line1.createEl("code", { text: result.track2Name });
    line1.appendText(`'s route`);

    const line2 = overlapContent.createDiv();

    line2.appendText(`${result.track2OverlapPercent.toFixed(1)}% of `);
    line2.createEl("code", { text: result.track2Name });
    line2.appendText(` follows `);
    line2.createEl("code", { text: result.track1Name });
    line2.appendText(`'s route`);

    overlapContent.createDiv({ text: `Shared distance: ${formatKmInSystem(result.sharedDistanceKm, this.units, 2)}` });
    overlapContent.createDiv({ text: "Direction: " + this.getDirectionLabel(result.direction) });
    overlapContent.createDiv({ text: `Shape similarity (Fréchet): ${Math.round(result.frechetSimilarity * 100)}%` });

    const comparisonSection = metricsContainer.createDiv({ cls: "places-compare-section" });

    comparisonSection.createEl("h4", { text: "Track comparison", cls: "places-compare-section-title" });

    const lengthDiff = Math.abs((result.track1LengthKm as number) - (result.track2LengthKm as number));
    const maxLength = Math.max(result.track1LengthKm, result.track2LengthKm);
    const lengthSignificant = maxLength > 0 && (lengthDiff / maxLength) > 0.1;

    const hasElevation = result.elevation.available;
    let gainSignificant = false;
    let lossSignificant = false;
    let gainDiff = 0;
    let lossDiff = 0;

    if (hasElevation) {
      gainDiff = Math.abs((result.elevation.track1.gainMeters as number) - (result.elevation.track2.gainMeters as number));
      const maxGain = Math.max(result.elevation.track1.gainMeters, result.elevation.track2.gainMeters);

      gainSignificant = maxGain > 0 && (gainDiff / maxGain) > 0.1;

      lossDiff = Math.abs((result.elevation.track1.lossMeters as number) - (result.elevation.track2.lossMeters as number));
      const maxLoss = Math.max(result.elevation.track1.lossMeters, result.elevation.track2.lossMeters);

      lossSignificant = maxLoss > 0 && (lossDiff / maxLoss) > 0.1;
    }

    const tableWrapper = comparisonSection.createDiv({ cls: "places-similar-table" });
    const table = tableWrapper.createEl("table", { cls: "places-similar-table-element" });

    const headerRow = table.createEl("tr", { cls: "places-similar-row" });

    headerRow.createEl("th", { text: "", cls: "places-similar-cell" });
    headerRow.createEl("th", { text: "Distance", cls: "places-similar-cell places-compare-value" });

    if (hasElevation) {
      headerRow.createEl("th", { text: "Elevation gain", cls: "places-similar-cell places-compare-value" });
      headerRow.createEl("th", { text: "Elevation loss", cls: "places-similar-cell places-compare-value" });
    }

    const track1Row = table.createEl("tr", { cls: "places-similar-row" });

    track1Row.createEl("td", { text: result.track1Name, cls: "places-similar-cell" });
    track1Row.createEl("td", { text: formatKmInSystem(result.track1LengthKm, this.units, 2), cls: "places-similar-cell places-compare-value" });

    if (hasElevation) {
      track1Row.createEl("td", { text: formatMetersInSystem(result.elevation.track1.gainMeters, this.units), cls: "places-similar-cell places-compare-value" });
      track1Row.createEl("td", { text: formatMetersInSystem(result.elevation.track1.lossMeters, this.units), cls: "places-similar-cell places-compare-value" });
    }

    const track2Row = table.createEl("tr", { cls: "places-similar-row" });

    track2Row.createEl("td", { text: result.track2Name, cls: "places-similar-cell" });
    track2Row.createEl("td", { text: formatKmInSystem(result.track2LengthKm, this.units, 2), cls: "places-similar-cell places-compare-value" });

    if (hasElevation) {
      track2Row.createEl("td", { text: formatMetersInSystem(result.elevation.track2.gainMeters, this.units), cls: "places-similar-cell places-compare-value" });
      track2Row.createEl("td", { text: formatMetersInSystem(result.elevation.track2.lossMeters, this.units), cls: "places-similar-cell places-compare-value" });
    }

    const diffRow = table.createEl("tr", { cls: "places-similar-row" });

    diffRow.createEl("td", { text: "Difference", cls: "places-similar-cell" });
    const distDiffCls = lengthSignificant ? "places-similar-cell places-compare-value places-compare-value-significant" : "places-similar-cell places-compare-value";

    diffRow.createEl("td", { text: formatKmInSystem(km(lengthDiff), this.units, 2), cls: distDiffCls });

    if (hasElevation) {
      const gainDiffCls = gainSignificant ? "places-similar-cell places-compare-value places-compare-value-significant" : "places-similar-cell places-compare-value";

      diffRow.createEl("td", { text: formatMetersInSystem(meters(gainDiff), this.units), cls: gainDiffCls });
      const lossDiffCls = lossSignificant ? "places-similar-cell places-compare-value places-compare-value-significant" : "places-similar-cell places-compare-value";

      diffRow.createEl("td", { text: formatMetersInSystem(meters(lossDiff), this.units), cls: lossDiffCls });
    }

    if (result.divergencePoints.length > 0) {
      const keyPointsSection = metricsContainer.createDiv({ cls: "places-compare-section" });

      keyPointsSection.createEl("h4", { text: "Key points", cls: "places-compare-section-title" });

      for (const point of result.divergencePoints) {
        const icon = point.type === 'divergence' ? '↗️' :
                     point.type === 'convergence' ? '↘️' : '🔗';
        const label = point.type === 'divergence' ? 'Divergence' :
                      point.type === 'convergence' ? 'Convergence' : 'Continuation gap';
        const text = point.gapDistanceMeters
          ? `${icon} ${label} at (${formatDisplayCoordinate(point.coordinate)}) - ${Math.round(point.gapDistanceMeters)}m gap`
          : `${icon} ${label} at (${formatDisplayCoordinate(point.coordinate)})`;

        keyPointsSection.createDiv({ text });
      }
    }

    if (result.relationship === 'no-overlap' && result.closestApproachMeters !== undefined) {
      const approachSection = metricsContainer.createDiv({ cls: "places-compare-section" });

      approachSection.createEl("h4", { text: "Closest approach", cls: "places-compare-section-title" });

      const approachTable = this.createTable(approachSection);

      this.addTableRow(approachTable, "Distance", formatMetersInSystem(meters(result.closestApproachMeters), this.units));

      if (result.closestApproachLocation) {
        this.addTableRow(approachTable, "Location", formatDisplayCoordinate(result.closestApproachLocation));
      }
    }
  }

  private createTable(container: HTMLElement): HTMLTableElement {
    const tableWrapper = container.createDiv({ cls: "places-similar-table" });

    return tableWrapper.createEl("table", { cls: "places-similar-table-element" });
  }

  private addTableRow(table: HTMLTableElement, label: string, value: string): void {
    const row = table.createEl("tr", { cls: "places-similar-row" });

    row.createEl("td", { text: label, cls: "places-similar-cell" });
    row.createEl("td", { text: value, cls: "places-similar-cell places-compare-value" });
  }

  private getDirectionLabel(direction: DirectionRelationship): string {
    const labels: Record<DirectionRelationship, string> = {
      'same': 'Same direction',
      'opposite': 'Opposite directions',
      'mixed': 'Mixed directions'
    };

    return labels[direction];
  }
}
