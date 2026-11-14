import { normalizeCodeBlockKeys } from "places-shared/settings";
import { logger as rootLogger } from "places-shared/utils";
import { missingQueryPluginError } from "../services/MissingPluginError";
import { App, MarkdownPostProcessorContext, TFile, setIcon } from "obsidian";
import { UnitsSystem, metersToFeet, meters, getElevationUnit, Meters } from "places-shared/units";
import { ColorSchemes } from "places-shared/track";
import { DEFAULT_MAP_HEIGHT, DEFAULT_MAP_WIDTH, parsePositiveInt, parsePositiveFloat, parseOpacity, parseEnum, parseShortDistanceAsMeters, conditionalProps, parseBooleanOptional } from "places-shared/settings";
import { Utilities, renderError, renderErrorWithHelp, getErrorMessage, numericRange, PLACES_EXPORTS_FOLDER } from "places-shared/utils";
import { downloadOrCopy } from "places-shared/obsidian/utils";
import PlacesPlugin from "../main";
import { FrequencyAnalysisService } from "../services/FrequencyAnalysisService";
import { FrequencySegment, FrequencyAnalysisResult } from 'places/core/strategies';
import { TrackDataService } from "../services/TrackDataService";
import { PlaceDataService } from "../services/PlaceDataService";
import { VaultQueryPreparingError } from "../services/VaultQueryService";
import { renderVaultQueryWaitingState } from "./VaultQueryWaitingState";
import { applyBlockWidth, createFloatingRefreshButton, createLoadingIndicator } from "places-shared/obsidian/ui";
import { BlockRefreshRegistry } from "../services/BlockRefreshRegistry";
import { registerRefreshableCodeBlock, createOwnNoteEditRefreshGuard } from "./RefreshableCodeBlock";
import { renderHoverPlaceholder } from "places-shared/obsidian/ui";
import { renderMapSurface } from "../services/MapSurfaceRenderer";
import { createFloatingButtonContainer } from "../services/MapFloatingControls";
import { RenderStalenessGuard } from "places-shared/obsidian/ui";
import { BlockParameterSupport } from "../services/BlockParameters";
import { ParsedCodeBlock, optionalStringSetting, parseCodeBlock } from 'places/core';
import { resolveEffectiveHeatmapColorScheme, buildHeatmapExportGeoJson, heatmapExportFilename, HEATMAP_EXPORT_MIME_TYPE } from 'places/core/strategies';

const logger = rootLogger.scope('Heatmap');

function waitForNextPaint(): Promise<void> {
  return new Promise(resolve => window.requestAnimationFrame(() => resolve()));
}

interface HeatmapBlockSettings {
  dataview?: string;  
  query?: string;  
  gridSize: Meters;  
  maxSegments: number;
  minFrequency: number;
  colorScheme: string;
  colorSchemeExplicit: boolean;
  height: string;
  width: string;
  mapProvider: string;
  style?: string;  
  strategy: 'density-cloud' | 'track-corridor' | 'opacity-stacking';
  legendLocation: 'hidden' | 'top' | 'bottom';
  infoLocation: 'hidden' | 'top' | 'bottom';
  minOpacity: number;  
  maxOpacity: number;  
  lineOpacity?: number;  
  lineWidth: number;  
  lineStyle?: string;  
  poiDiscovery?: boolean;  
}

const HeatmapBlockDefaultSettings: HeatmapBlockSettings = {
  gridSize: meters(100),
  maxSegments: 100,
  minFrequency: 2,
  colorScheme: 'yellow-to-red',
  colorSchemeExplicit: false,
  height: DEFAULT_MAP_HEIGHT,
  width: DEFAULT_MAP_WIDTH,
  mapProvider: '',
  strategy: 'track-corridor',
  legendLocation: 'hidden',
  infoLocation: 'hidden',
  minOpacity: 0.01,
  maxOpacity: 1.0,
  lineWidth: 3,
  lineStyle: ''
};

export class HeatmapBlockProcessor {
  private frequencyService: FrequencyAnalysisService;
  private units: UnitsSystem;

  constructor(private app: App, trackDataService: TrackDataService, private placeDataService: PlaceDataService, private blockParameters: BlockParameterSupport) {
    this.frequencyService = new FrequencyAnalysisService(app, trackDataService);
    this.units = PlacesPlugin.settings.units;
  }

  async processCodeBlock(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
    if (renderHoverPlaceholder(el, '🗺️ Heatmap preview not available in hover')) return;

    const stalenessGuard = new RenderStalenessGuard(el, ctx.sourcePath);

    ctx.addChild(stalenessGuard);

    const parsed = parseCodeBlock(source);
    const autoRefresh = parsed.settings.autorefresh;
    const parameters = await this.blockParameters.apply(parsed, el, ctx);

    registerRefreshableCodeBlock({
      autoRefresh,
      source,
      el,
      ctx,
      process: (src, container, context) => this.processCodeBlock(src, container, context),
      shouldAutoRefresh: createOwnNoteEditRefreshGuard(source, ctx.sourcePath),
      usesParameters: parameters !== null,
      query: typeof parsed.settings.query === 'string' ? parsed.settings.query || null : null,
    });

    try {
      const settings = this.parseSettings(parsed);

      const loading = createLoadingIndicator(el, "Initializing analysis...", { className: "places-map-loading" });

      await waitForNextPaint();

      let files: TFile[];

      if (settings.dataview || settings.query) {
        loading.setText("Executing query...");

        try {
          files = await this.placeDataService.getFilesFromQuerySettings(settings, ctx.sourcePath);
        } catch (error) {
          logger.error('Query error', error);
          el.empty();

          if (error instanceof VaultQueryPreparingError) {
            renderVaultQueryWaitingState(el, source, ctx, (src, container, context) => this.processCodeBlock(src, container, context));
          } else if (Utilities.isDataviewUnavailableError(error)) {
            renderError(el, missingQueryPluginError('dataview'));
          } else if (Utilities.isVaultQueryUnavailableError(error)) {
            renderError(el, missingQueryPluginError('vaultquery'));
          } else {
            renderError(el, {
              icon: "⚠️",
              title: "Query Error",
              message: getErrorMessage(error)
            });
          }

          return;
        }
      } else {
        files = this.app.vault.getMarkdownFiles();
      }

      if (files.length === 0) {
        logger.warn('No files to analyze');
        el.empty();
        const emptyMessage = el.createDiv({ cls: "places-centered places-empty" });

        setIcon(emptyMessage, "info");
        emptyMessage.appendText(" No files found matching the query.");

        return;
      }

      loading.setText(`Extracting coordinates from ${files.length} files...`);

      const result = await this.frequencyService.analyzeVaultFrequency(
        files,
        settings.gridSize,
        settings.minFrequency,
        settings.maxSegments,
        (progress: string) => {
          loading.setText(progress);
        },
        settings.strategy,
        settings.minOpacity,
        settings.maxOpacity
      );

      el.empty();

      if (result.segments.length === 0) {
        logger.warn('No segments generated');
        const message = settings.strategy === 'track-corridor'
          ? "ℹ️ No overlapping tracks found. Try selecting tracks that cover the same geographic area."
          : "ℹ️ No coordinates found. Files need Location or Overlay Source in frontmatter.";

        el.createDiv({
          text: message,
          cls: "places-centered places-empty"
        });

        return;
      }

      if (stalenessGuard.superseded) {
        return;
      }

      await this.renderHeatmap(el, result, settings, ctx);
    } catch (error) {
      logger.error("Error in places-heatmap code block", error);
      el.empty();
      renderErrorWithHelp(el, {
        icon: "⚠️",
        title: "Heatmap Error",
        message: getErrorMessage(error)
      });
    } finally {
      await parameters?.renderStrip();
    }
  }

  private parseSettings(parsed: ParsedCodeBlock): HeatmapBlockSettings {
    const pairs = normalizeCodeBlockKeys(parsed.settings, ['lineWidth', 'lineStyle']);
    const settings: HeatmapBlockSettings = { ...HeatmapBlockDefaultSettings };

    settings.mapProvider = PlacesPlugin.resolveMapProvider(optionalStringSetting(pairs, 'mapProvider'));

    Object.assign(settings, conditionalProps({
      dataview: optionalStringSetting(pairs, 'dataview'),
      query: optionalStringSetting(pairs, 'query'),
      height: optionalStringSetting(pairs, 'height'),
      width: optionalStringSetting(pairs, 'width'),
      style: optionalStringSetting(pairs, 'style'),
      lineStyle: optionalStringSetting(pairs, 'lineStyle')?.trim(),  
      poiDiscovery: parseBooleanOptional(pairs.poiDiscovery),
      gridSize: parseShortDistanceAsMeters(pairs.gridSize, this.units),
      maxSegments: parsePositiveInt(pairs.maxSegments),
      minFrequency: parsePositiveInt(pairs.minFrequency),
      colorScheme: optionalStringSetting(pairs, 'colorScheme')?.trim() || undefined,
      colorSchemeExplicit: !!optionalStringSetting(pairs, 'colorScheme')?.trim(),
      strategy: parseEnum(pairs.strategy, ['density-cloud', 'track-corridor', 'opacity-stacking'] as const),
      legendLocation: parseEnum(pairs.legendLocation, ['hidden', 'top', 'bottom'] as const),
      infoLocation: parseEnum(pairs.infoLocation, ['hidden', 'top', 'bottom'] as const),
      minOpacity: parseOpacity(pairs.minOpacity),
      maxOpacity: parseOpacity(pairs.maxOpacity),
      lineOpacity: parseOpacity(pairs.lineOpacity),
      lineWidth: parsePositiveFloat(pairs.lineWidth),
    }));

    return settings;
  }

  private async exportResultAsGeoJSON(result: FrequencyAnalysisResult, settings: HeatmapBlockSettings): Promise<void> {
    const strategy = this.frequencyService.getStrategy(settings.strategy);

    if (!strategy) {
      logger.error('Strategy not found for export');

      return;
    }

    const mapPlaces = strategy.convertToMapPlaces(
      result,
      settings.colorScheme,
      settings.lineWidth,
      settings.lineStyle,
      settings.lineOpacity
    );

    const geojson = buildHeatmapExportGeoJson(result, mapPlaces, { lineWidth: settings.lineWidth, lineStyle: settings.lineStyle });
    const filename = heatmapExportFilename(settings.strategy);

    await downloadOrCopy({
      app: this.app,
      content: JSON.stringify(geojson, null, 2),
      filename,
      mimeType: HEATMAP_EXPORT_MIME_TYPE,
      desktopNotice: `Exported ${filename}`,
      vaultFallbackFolder: PLACES_EXPORTS_FOLDER
    });
  }

  private async renderHeatmap(el: HTMLElement, result: FrequencyAnalysisResult, settings: HeatmapBlockSettings, ctx: MarkdownPostProcessorContext): Promise<void> {
    const { segments } = result;

    const outputType = this.frequencyService.getStrategyOutputType(settings.strategy);
    const isHeatmapLayer = outputType === 'points';

    const effectiveColorScheme = resolveEffectiveHeatmapColorScheme(isHeatmapLayer, settings.colorScheme, settings.colorSchemeExplicit);

    applyBlockWidth(el, settings.width);
    const container = el.createDiv("places-heatmap-container");

    const buttonContainer = createFloatingButtonContainer({
      host: container,
      className: 'places-heatmap-floating-buttons',
      removeGeocodingSearch: false,
    });
    const exportButton = buttonContainer.createDiv('places-floating-button');

    exportButton.setAttribute('aria-label', 'Export GeoJSON');
    setIcon(exportButton, 'download');
    exportButton.addEventListener('click', () => {
      void this.exportResultAsGeoJSON(result, settings);
    });

    createFloatingRefreshButton({
      buttonContainer,
      ctx,
      ariaLabel: 'Refresh heatmap',
      onRefresh: () => BlockRefreshRegistry.refreshForElement(el),
      onError: error => logger.error('Heatmap refresh failed:', error),
    });

    if (settings.legendLocation === 'top') {
      this.createLegend(container, effectiveColorScheme, settings.strategy);
    }

    if (settings.infoLocation === 'top') {
      this.addSettingsInfo(container, settings, segments, effectiveColorScheme);
    }

    const rawBlockSettings: Record<string, unknown> = {
      mapProvider: settings.mapProvider,
      height: settings.height,
      width: settings.width,
      showLabels: false,
      poiDiscovery: settings.poiDiscovery ?? false,
      poiFilterPatterns: PlacesPlugin.settings.poiFilterPatterns
    };

    if (settings.style) {
      rawBlockSettings.style = settings.style;
    }

    const strategy = this.frequencyService.getStrategy(settings.strategy);

    if (!strategy) {
      logger.error('Strategy not found', settings.strategy);

      return;
    }

    const mapPlaces = strategy.convertToMapPlaces(result, settings.colorScheme, settings.lineWidth, settings.lineStyle, settings.lineOpacity);

    if (isHeatmapLayer) {
      rawBlockSettings.heatmapLayer = true;
      rawBlockSettings.heatmapColorScheme = effectiveColorScheme;
    } else {
      rawBlockSettings.track = { defaultVisibility: 'visible' };
    }

    await renderMapSurface({
      host: container,
      places: mapPlaces,
      providerName: settings.mapProvider,
      ctx,
      rawSettings: rawBlockSettings,
      mapContainerClass: "places-heatmap-map",
      height: settings.height,
      onRerenderRequested: () => BlockRefreshRegistry.refreshForElement(el).then(() => undefined),
    });

    if (settings.legendLocation === 'bottom') {
      this.createLegend(container, effectiveColorScheme, settings.strategy);
    }

    if (settings.infoLocation === 'bottom') {
      this.addSettingsInfo(container, settings, segments, effectiveColorScheme);
    }
  }

  private createLegend(container: HTMLElement, colorScheme: string, strategy: HeatmapBlockSettings['strategy']): void {
    const legend = container.createDiv({ cls: "places-heatmap-legend" });
    const label = strategy === 'opacity-stacking' ? "Overlap: Low " : "Intensity: Low ";

    legend.createSpan({ text: label, cls: "places-heatmap-legend-label" });

    const gradientBar = legend.createDiv({ cls: "places-heatmap-legend-gradient" });

    gradientBar.setCssProps({
      '--places-legend-gradient': strategy === 'opacity-stacking'
        ? ColorSchemes.getHeatmapOpacityGradientCSS(colorScheme)
        : ColorSchemes.getHeatmapGradientCSS(colorScheme)
    });

    legend.createSpan({ text: " High", cls: "places-heatmap-legend-high" });
  }

  private addSettingsInfo(container: HTMLElement, settings: HeatmapBlockSettings, segments: FrequencySegment[], effectiveColorScheme: string): void {
    const info = container.createDiv({ cls: "places-heatmap-info" });

    const { min: minFreq, max: maxFreq } = numericRange(segments.map(s => s.frequency)) ?? { min: 0, max: 0 };

    const gridSizeConverted = this.units === 'imperial'
      ? metersToFeet(settings.gridSize)
      : settings.gridSize;
    const unit = getElevationUnit(this.units); // Elevation units double as short-distance units (m/ft)
    const gridSizeDisplay = `${Math.round(gridSizeConverted)}${unit.abbreviation}`;

    const infoText = [
      `Grid size: ${gridSizeDisplay}`,
      `Frequency range: ${minFreq}-${maxFreq}`,
      `Min threshold: ${settings.minFrequency}`,
      `Color scheme: ${effectiveColorScheme}`
    ].join(' • ');

    info.createSpan({ text: infoText, cls: "places-heatmap-info-text" });
  }
}
