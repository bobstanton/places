import { logger } from "places-shared/utils";
import { BlockParameterSupport } from "../services/BlockParameters";
import { parseCodeBlock } from 'places/core';
import { App, MarkdownPostProcessorContext, normalizePath } from "obsidian";
import { UnitsSystem, Kilometers, Meters, KilometersPerHour, MinutesPerKilometer, formatKmInSystem, formatMetersInSystem, formatKphInSystem, formatMinPerKmInSystem, meters } from "places-shared/units";
import { getLegendPosition, createGradeLegend, createElevationLegend, getElevationRange } from 'places/core/charts';
import { Utilities, renderError, getFileNameWithoutExtension, getErrorMessage } from "places-shared/utils";
import PlacesPlugin from "../main";
import { TrackData, TrackDataService } from "../services/TrackDataService";
import { ChartService, ChartDataUnavailableError, NamedTrack } from 'places/core/charts';
import { DEFAULT_GRADE_WINDOW, DEFAULT_SPEED_WINDOW, parseMetricWindow, NormalizedChartBlockSettings, normalizeChartBlockSettings } from "places-shared/settings";
import { TRACK_PLAYBACK_POSITION_EVENT, TRACK_POINT_HOVER_EVENT, TRACK_POINT_SELECT_EVENT } from "places-shared/map";
import { applyBlockWidth } from "places-shared/obsidian/ui";
import { registerRefreshableCodeBlock, createTrackFileRefreshGuard } from "./RefreshableCodeBlock";
import { disposeManagedChart, registerManagedChart } from "./ManagedChartRenderChild";
import { parseNamedCoordinate } from "places-shared/geo";
import { NoteParameterRegistry, QueryParameterState } from "../services/QueryParameterState";
import { applyExternalParameterValue } from "../ui/ParameterStrip";
import { MapRefreshService } from "../services/MapRefreshService";
import { parseQueryParameterDefinitions } from "places/core";

export class PlacesChartBlockProcessor {
  private chartService: ChartService;

  constructor(private app: App, private trackDataService: TrackDataService, private blockParameters: BlockParameterSupport) {
    this.chartService = new ChartService();
  }

  private get units(): UnitsSystem {
    return PlacesPlugin.settings.units;
  }

  async processCodeBlock(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
    disposeManagedChart(el);
    const parsed = parseCodeBlock(source);
    const autoRefresh = parsed.settings.autorefresh;
    const rawPosition = parsed.settings.position;
    const positionParameter = typeof rawPosition === 'string'
      ? /^\s*\{parameter\.([A-Za-z_][A-Za-z0-9_-]*)\}\s*$/.exec(rawPosition)?.[1]
      : undefined;
    const rawDefinitions = parsed.settings.queryParameters;
    const parameters = await this.blockParameters.apply(parsed, el, ctx);

    registerRefreshableCodeBlock({
      autoRefresh,
      source,
      el,
      ctx,
      process: (src, container, context) => this.processCodeBlock(src, container, context),
      shouldAutoRefresh: createTrackFileRefreshGuard(source, ctx.sourcePath,
        (typeof parsed.settings.track1 === 'string' && parsed.settings.track1.trim() ? [parsed.settings.track1, parsed.settings.track2] : [])
          .filter((value): value is string => typeof value === 'string' && value.trim() !== ''),
        (input, sourcePath) => this.trackDataService.resolveTrackFile(input, sourcePath)),
      ariaLabel: 'Refresh chart',
      onError: error => logger.error('Refresh chart failed:', error),
      usesParameters: parameters !== null,
    });

    try {
      const blockSettings = normalizeChartBlockSettings(parsed.settings, {
        speedWindow: parseMetricWindow(PlacesPlugin.settings.speedWindow, DEFAULT_SPEED_WINDOW),
        gradeWindow: parseMetricWindow(PlacesPlugin.settings.gradeWindow, DEFAULT_GRADE_WINDOW),
      });

      applyBlockWidth(el, blockSettings.width);

      const track1Setting = blockSettings.track1;
      const track2Setting = blockSettings.track2;
      const isComparisonMode = track1Setting && track2Setting;

      if (isComparisonMode) {
        await this.processComparisonChart(el, ctx, blockSettings, track1Setting, track2Setting);
      } else {
        await this.processSingleChart(el, ctx, blockSettings, track1Setting, positionParameter, rawDefinitions);
      }
    } catch (error) {
      logger.error("Error processing track data chart:", error);
      renderError(el, {
        icon: '⚠️',
        title: 'Error processing chart',
        message: getErrorMessage(error)
      });
    } finally {
      await parameters?.renderStrip();
    }
  }

  private async processSingleChart(el: HTMLElement, ctx: MarkdownPostProcessorContext, blockSettings: NormalizedChartBlockSettings, trackSetting?: string, positionParameter?: string, rawDefinitions?: unknown): Promise<void> {
    let trackData: TrackData;

    try {
      if (trackSetting) {
        trackData = await this.trackDataService.loadTrackFromPath(trackSetting, ctx.sourcePath, { skipCache: true, speedWindow: blockSettings.speedWindow });
      } else {
        const file = this.app.vault.getFileByPath(normalizePath(ctx.sourcePath));

        if (!file) {
          renderError(el, {
            icon: '⚠️',
            title: 'File not found',
            message: 'The source file for this chart could not be located.'
          });

          return;
        }

        trackData = this.trackDataService.extractTrackFromNote(file, { skipCache: true, speedWindow: blockSettings.speedWindow });
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error);

      renderError(el, {
        icon: '📊',
        title: 'No track data found',
        message: trackSetting
          ? "Failed to load track: " + errorMessage
          : 'Import GPX data using the "Import track from GPX" command.'
      });

      return;
    }

    if (trackData.points.length === 0) {
      renderError(el, {
        icon: '📊',
        title: 'No track data found',
        message: trackSetting
          ? `The track file contains no track points.`
          : 'Import GPX data using the "Import track from GPX" command.'
      });

      return;
    }

    const chartContainer = el.createDiv("places-chart-container");
    const legendPosition = getLegendPosition(blockSettings.colorBy, blockSettings.legend);

    if (legendPosition === 'top') {
      this.addLegend(chartContainer, blockSettings, trackData);
    }

    const chartEl = chartContainer.createDiv("places-chart");

    chartEl.setCssProps({
      '--places-chart-height': blockSettings.height
    });

    try {
      const trackPath = trackSetting ?? ctx.sourcePath;
      const selectionChannel = blockSettings.selectionChannel?.trim() || 'primary';
      const publishPoint = (point: { latitude: number; longitude: number }): void => {
        chartEl.ownerDocument.dispatchEvent(new CustomEvent(TRACK_POINT_HOVER_EVENT, { detail: { trackPath, latitude: point.latitude, longitude: point.longitude } }));
      };
      const chart = this.chartService.createChart(chartEl, trackData, blockSettings, this.units, publishPoint, point => {
        publishPoint(point);
        PlacesPlugin.publishSelection(ctx.sourcePath, {
          kind: 'track-point',
          id: trackPath,
          path: trackPath,
          coordinate: { latitude: point.latitude, longitude: point.longitude },
          data: { origin: `chart:${trackPath}` },
        }, selectionChannel);
        chartEl.ownerDocument.dispatchEvent(new CustomEvent(TRACK_POINT_SELECT_EVENT, {
          detail: { trackPath, latitude: point.latitude, longitude: point.longitude },
        }));
        if (!positionParameter) return;
        const value = `${point.latitude}, ${point.longitude}`;
        const local = parseQueryParameterDefinitions(rawDefinitions).definitions.some(definition => definition.name === positionParameter);
        const stateKey = local
          ? QueryParameterState.getStateKey(ctx.sourcePath, ctx.getSectionInfo(el)?.lineStart)
          : NoteParameterRegistry.noteStateKey(ctx.sourcePath);

        applyExternalParameterValue(stateKey, positionParameter, value);
        logger.scope('ChartSelection').debug('chart point committed to shared parameter', {
          trackPath,
          parameter: positionParameter,
          latitude: point.latitude,
          longitude: point.longitude,
          scope: local ? 'block' : 'note',
        });

        if (local) void MapRefreshService.getInstance().refreshBlockForElement(el);
        else MapRefreshService.getInstance().refreshParameterConsumers(ctx.sourcePath);
      });
      const nearestPointIndex = (latitude: number, longitude: number): number => {
        let nearestDistance = Number.POSITIVE_INFINITY;
        let index = 0;

        for (let candidate = 0; candidate < trackData.points.length; candidate++) {
          const point = trackData.points[candidate];
          const distance = (point.latitude - latitude) ** 2 + (point.longitude - longitude) ** 2;

          if (distance < nearestDistance) {
            nearestDistance = distance;
            index = candidate;
          }
        }

        return index;
      };
      const activatePoint = (trackIndex: number): void => {
        const meta = chart.getDatasetMeta(0);
        const elementCount = meta.data.length;
        const pointCount = trackData.points.length;

        if (elementCount === 0 || pointCount === 0) return;
        const index = pointCount > 1
          ? Math.max(0, Math.min(elementCount - 1, Math.round((trackIndex / (pointCount - 1)) * (elementCount - 1))))
          : 0;
        const element = meta.data[index];

        if (!element) return;

        chart.setActiveElements([{ datasetIndex: 0, index }]);
        const { x, y } = element.getProps(['x', 'y'], true) ?? {};

        if (typeof x === 'number' && typeof y === 'number') chart.tooltip?.setActiveElements([{ datasetIndex: 0, index }], { x, y });
        chart.update('none');
      };
      const playbackListener = (event: Event) => {
        const detail = (event as CustomEvent<{ trackPath?: string; progress?: number; latitude?: number; longitude?: number }>).detail;

        if (detail?.trackPath !== trackPath) return;
        let index: number;

        if (detail.latitude !== undefined && detail.longitude !== undefined) {
          index = nearestPointIndex(detail.latitude, detail.longitude);
        } else if (detail.progress !== undefined) {
          index = Math.max(0, Math.min(trackData.points.length - 1, Math.round(detail.progress * (trackData.points.length - 1))));
        } else {
          return;
        }

        activatePoint(index);
      };
      const unsubscribeSelection = PlacesPlugin.subscribeSelection(ctx.sourcePath, selection => {
        if (selection?.kind !== 'track-point' || !selection.coordinate) return;
        if (selection.path && normalizePath(selection.path) !== normalizePath(trackPath)) return;
        activatePoint(nearestPointIndex(selection.coordinate.latitude, selection.coordinate.longitude));
      }, selectionChannel);

      chartEl.ownerDocument.addEventListener(TRACK_PLAYBACK_POSITION_EVENT, playbackListener);
      registerManagedChart(ctx, el, chartEl, chart, () => {
        chartEl.ownerDocument.removeEventListener(TRACK_PLAYBACK_POSITION_EVENT, playbackListener);
        unsubscribeSelection();
      });
      const initialPosition = blockSettings.position ? parseNamedCoordinate(blockSettings.position) : undefined;

      if (initialPosition) activatePoint(nearestPointIndex(initialPosition.latitude, initialPosition.longitude));
      this.addStatsSection(chartContainer, trackData, blockSettings);

      if (legendPosition === 'bottom') {
        this.addLegend(chartContainer, blockSettings, trackData);
      }
    } catch (chartError) {
      if (chartError instanceof ChartDataUnavailableError) {
        chartContainer.empty();
        chartContainer.createDiv({ text: 'No chart data.' });

        return;
      }

      logger.error("Chart creation failed:", chartError);
      chartEl.remove();
      const errorMessage = getErrorMessage(chartError);

      renderError(chartContainer, {
        icon: '⚠️',
        title: 'Chart creation failed',
        message: errorMessage
      });
    }
  }

  private async processComparisonChart(el: HTMLElement, ctx: MarkdownPostProcessorContext, blockSettings: NormalizedChartBlockSettings, track1Setting: string, track2Setting: string): Promise<void> {
    let track1: NamedTrack;
    let track2: NamedTrack;

    try {
      const track1Data = await this.trackDataService.loadTrackFromPath(track1Setting, ctx.sourcePath, { skipCache: true, speedWindow: blockSettings.speedWindow });

      track1 = {
        data: track1Data,
        name: this.extractTrackName(track1Setting, track1Data)
      };
    } catch (error) {
      const errorMessage = getErrorMessage(error);

      renderError(el, {
        icon: '📊',
        title: 'Failed to load track 1',
        message: errorMessage
      });

      return;
    }

    try {
      const track2Data = await this.trackDataService.loadTrackFromPath(track2Setting, ctx.sourcePath, { skipCache: true, speedWindow: blockSettings.speedWindow });

      track2 = {
        data: track2Data,
        name: this.extractTrackName(track2Setting, track2Data)
      };
    } catch (error) {
      const errorMessage = getErrorMessage(error);

      renderError(el, {
        icon: '📊',
        title: 'Failed to load track 2',
        message: errorMessage
      });

      return;
    }

    if (track1.data.points.length === 0 || track2.data.points.length === 0) {
      renderError(el, {
        icon: '📊',
        title: 'Empty track data',
        message: 'One or both tracks contain no data points.'
      });

      return;
    }

    const chartContainer = el.createDiv("places-chart-container");
    const legendPosition = getLegendPosition(blockSettings.colorBy, blockSettings.legend);

    if (legendPosition === 'top') {
      this.addComparisonLegend(chartContainer, blockSettings, track1.data, track2.data);
    }

    const chartEl = chartContainer.createDiv("places-chart");

    chartEl.setCssProps({
      '--places-chart-height': blockSettings.height
    });

    try {
      const chart = this.chartService.createComparisonChart(chartEl, track1, track2, blockSettings, this.units);

      registerManagedChart(ctx, el, chartEl, chart);
      this.addComparisonStatsSection(chartContainer, track1, track2, blockSettings);

      if (legendPosition === 'bottom') {
        this.addComparisonLegend(chartContainer, blockSettings, track1.data, track2.data);
      }
    } catch (chartError) {
      logger.error("Comparison chart creation failed:", chartError);
      chartEl.remove();
      const errorMessage = getErrorMessage(chartError);

      renderError(chartContainer, {
        icon: '⚠️',
        title: 'Chart creation failed',
        message: errorMessage
      });
    }
  }

  private extractTrackName(setting: string, trackData: TrackData): string {
    if (trackData.metadata?.name) {
      return trackData.metadata.name;
    }

    let path = setting.trim();

    if (path.startsWith('"') && path.endsWith('"')) {
      path = path.slice(1, -1);
    }

    if (path.startsWith('[[') && path.endsWith(']]')) {
      path = path.slice(2, -2);
    }

    return getFileNameWithoutExtension(path, path, /\.(md|gpx|fit|csv|geojson|json)$/i);
  }

  private addStatsSection(container: HTMLElement, data: TrackData, blockSettings: NormalizedChartBlockSettings): void {
    const statsToShow = this.parseStatsToShow(blockSettings);

    this.renderStats(container, data, statsToShow);
  }

  private addLegend(container: HTMLElement, blockSettings: NormalizedChartBlockSettings, trackData: TrackData): void {
    if (blockSettings.colorBy === 'grade') {
      createGradeLegend(container);
    } else if (blockSettings.colorBy === 'elevation') {
      const elevations = trackData.points.map(p => p.elevationMeters);
      const range = getElevationRange(elevations);

      if (range) {
        createElevationLegend(container, range.min, range.max, this.units);
      }
    }
  }

  private addComparisonLegend(container: HTMLElement, blockSettings: NormalizedChartBlockSettings, track1: TrackData, track2: TrackData): void {
    if (blockSettings.colorBy === 'grade') {
      createGradeLegend(container);
    } else if (blockSettings.colorBy === 'elevation') {
      const elevations1 = track1.points.map(p => p.elevationMeters);
      const elevations2 = track2.points.map(p => p.elevationMeters);
      const range = getElevationRange([...elevations1, ...elevations2]);

      if (range) {
        createElevationLegend(container, range.min, range.max, this.units);
      }
    }
  }

  private parseStatsToShow(blockSettings: NormalizedChartBlockSettings): string[] {
    const statsString = blockSettings.stats;

    return statsString.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  }

  private renderStats(container: HTMLElement, data: TrackData, statsToShow: string[]): void {
    const statsEl = container.createDiv("places-stats-grid");

    const allStats = this.generateAllStats(data, statsToShow);

    allStats.forEach(stat => {
      const statEl = statsEl.createDiv("places-stat");

      statEl.createDiv("places-stat-label").textContent = stat.label;
      statEl.createDiv("places-stat-value").textContent = stat.value;
    });
  }

  private generateAllStats(data: TrackData, statsToShow: string[]): Array<{ label: string; value: string }> {
    const statGenerators = this.createStatGenerators(data);

    const generators = statsToShow.length === 0
      ? Object.values(statGenerators)
      : statsToShow.map(type => statGenerators[type]).filter(Boolean);

    return generators.flatMap(generator => generator());
  }

  private createStatGenerators(data: TrackData): Record<string, () => Array<{ label: string; value: string }>> {
    return {
      distance: () => [{
        label: "Distance",
        value: formatKmInSystem(data.metrics.distance, this.units)
      }],
      elevation: () => {
        if (!data.metrics.elevationGain && !data.metrics.maxElevation) return [];

        const netElevation = data.metrics.elevationGain - data.metrics.elevationLoss;

        return [
          { label: "Elevation Gain", value: formatMetersInSystem(data.metrics.elevationGain, this.units) },
          { label: "Elevation Loss", value: formatMetersInSystem(data.metrics.elevationLoss, this.units) },
          { label: "Min Elevation", value: formatMetersInSystem(data.metrics.minElevation || meters(0), this.units) },
          { label: "Max Elevation", value: formatMetersInSystem(data.metrics.maxElevation || meters(0), this.units) },
          { label: "Net Elevation", value: formatMetersInSystem(meters(netElevation), this.units) }
        ];
      },
      speed: () => this.formatSpeedStats(data),
      pace: () => this.formatPaceStats(data),
      points: () => [{ label: "Data Points", value: data.points.length.toString() }],
      time: () => this.formatTimeStats(data)
    };
  }

  private formatSpeedStats(data: TrackData): Array<{ label: string; value: string }> {
    const stats = [];

    if (data.metrics.averageSpeed) {
      stats.push({ label: "Average Speed", value: formatKphInSystem(data.metrics.averageSpeed, this.units) });
    }

    if (data.metrics.maxSpeed) {
      stats.push({ label: "Max Speed", value: formatKphInSystem(data.metrics.maxSpeed, this.units) });
    }

    return stats;
  }

  private formatPaceStats(data: TrackData): Array<{ label: string; value: string }> {
    const stats = [];

    if (data.metrics.averagePace) {
      stats.push({ label: "Average Pace", value: formatMinPerKmInSystem(data.metrics.averagePace, this.units) });
    }

    if (data.metrics.bestPace) {
      stats.push({ label: "Best Pace", value: formatMinPerKmInSystem(data.metrics.bestPace, this.units) });
    }

    return stats;
  }

  private formatTimeStats(data: TrackData): Array<{ label: string; value: string }> {
    const timePoints = data.points.filter(p => p.time);

    if (timePoints.length < 2) return [];

    const duration = (timePoints[timePoints.length - 1].time!.getTime() - timePoints[0].time!.getTime()) / 1000;

    return [
      { label: "Start Time", value: timePoints[0].time!.toLocaleTimeString() },
      { label: "End Time", value: timePoints[timePoints.length - 1].time!.toLocaleTimeString() },
      { label: "Duration", value: Utilities.formatDuration(duration, true, false) }
    ];
  }

  private addComparisonStatsSection(container: HTMLElement, track1: NamedTrack, track2: NamedTrack, blockSettings: NormalizedChartBlockSettings): void {
    const statsToShow = this.parseStatsToShow(blockSettings);

    const effectiveStats = statsToShow.length === 0
      ? ['distance', 'elevation', 'speed', 'pace', 'time']
      : statsToShow;

    const statsEl = container.createDiv("places-comparison-stats");

    const table = statsEl.createEl("table", { cls: "places-comparison-table" });

    const headerRow = table.createEl("thead").createEl("tr");

    headerRow.createEl("th", { text: "" }); // Metric name
    headerRow.createEl("th", { text: track1.name, cls: "places-track1-header" });
    headerRow.createEl("th", { text: track2.name, cls: "places-track2-header" });
    headerRow.createEl("th", { text: "Δ", cls: "places-delta-header" });

    const tbody = table.createEl("tbody");

    effectiveStats.forEach(statType => {
      this.addComparisonRows(tbody, statType, track1.data, track2.data);
    });
  }

  private addComparisonRows(tbody: HTMLElement, statType: string, data1: TrackData, data2: TrackData): void {
    switch (statType) {
      case 'distance':
        this.addComparisonRow(tbody, 'Distance',
          formatKmInSystem(data1.metrics.distance, this.units),
          formatKmInSystem(data2.metrics.distance, this.units),
          this.formatDistanceDelta(data1.metrics.distance, data2.metrics.distance)
        );
        break;

      case 'elevation':
        if (data1.metrics.elevationGain || data2.metrics.elevationGain) {
          this.addComparisonRow(tbody, 'Elevation Gain',
            formatMetersInSystem(data1.metrics.elevationGain, this.units),
            formatMetersInSystem(data2.metrics.elevationGain, this.units),
            this.formatElevationDelta(data1.metrics.elevationGain, data2.metrics.elevationGain)
          );
          this.addComparisonRow(tbody, 'Elevation Loss',
            formatMetersInSystem(data1.metrics.elevationLoss, this.units),
            formatMetersInSystem(data2.metrics.elevationLoss, this.units),
            this.formatElevationDelta(data1.metrics.elevationLoss, data2.metrics.elevationLoss)
          );
        }

        if (data1.metrics.maxElevation || data2.metrics.maxElevation) {
          this.addComparisonRow(tbody, 'Max Elevation',
            formatMetersInSystem(data1.metrics.maxElevation || meters(0), this.units),
            formatMetersInSystem(data2.metrics.maxElevation || meters(0), this.units),
            this.formatElevationDelta(data1.metrics.maxElevation || meters(0), data2.metrics.maxElevation || meters(0))
          );
        }

        break;

      case 'speed':
        if (data1.metrics.averageSpeed || data2.metrics.averageSpeed) {
          this.addComparisonRow(tbody, 'Avg Speed',
            data1.metrics.averageSpeed ? formatKphInSystem(data1.metrics.averageSpeed, this.units) : '-',
            data2.metrics.averageSpeed ? formatKphInSystem(data2.metrics.averageSpeed, this.units) : '-',
            this.formatSpeedDelta(data1.metrics.averageSpeed, data2.metrics.averageSpeed)
          );
        }

        if (data1.metrics.maxSpeed || data2.metrics.maxSpeed) {
          this.addComparisonRow(tbody, 'Max Speed',
            data1.metrics.maxSpeed ? formatKphInSystem(data1.metrics.maxSpeed, this.units) : '-',
            data2.metrics.maxSpeed ? formatKphInSystem(data2.metrics.maxSpeed, this.units) : '-',
            this.formatSpeedDelta(data1.metrics.maxSpeed, data2.metrics.maxSpeed)
          );
        }

        break;

      case 'pace':
        if (data1.metrics.averagePace || data2.metrics.averagePace) {
          this.addComparisonRow(tbody, 'Avg Pace',
            data1.metrics.averagePace ? formatMinPerKmInSystem(data1.metrics.averagePace, this.units) : '-',
            data2.metrics.averagePace ? formatMinPerKmInSystem(data2.metrics.averagePace, this.units) : '-',
            this.formatPaceDelta(data1.metrics.averagePace, data2.metrics.averagePace)
          );
        }

        if (data1.metrics.bestPace || data2.metrics.bestPace) {
          this.addComparisonRow(tbody, 'Best Pace',
            data1.metrics.bestPace ? formatMinPerKmInSystem(data1.metrics.bestPace, this.units) : '-',
            data2.metrics.bestPace ? formatMinPerKmInSystem(data2.metrics.bestPace, this.units) : '-',
            this.formatPaceDelta(data1.metrics.bestPace, data2.metrics.bestPace)
          );
        }

        break;

      case 'time': {
        const duration1 = this.calculateDuration(data1);
        const duration2 = this.calculateDuration(data2);

        if (duration1 !== null || duration2 !== null) {
          this.addComparisonRow(tbody, 'Duration',
            duration1 !== null ? Utilities.formatDuration(duration1, true, false) : '-',
            duration2 !== null ? Utilities.formatDuration(duration2, true, false) : '-',
            this.formatDurationDelta(duration1, duration2)
          );
        }

        break;
      }
    }
  }

  private addComparisonRow(tbody: HTMLElement, label: string, value1: string, value2: string, delta: string): void {
    const row = tbody.createEl("tr");

    row.createEl("td", { text: label, cls: "places-stat-label" });
    row.createEl("td", { text: value1, cls: "places-track1-value" });
    row.createEl("td", { text: value2, cls: "places-track2-value" });

    const deltaCell = row.createEl("td", { cls: "places-delta-value" });

    deltaCell.textContent = delta;

    if (delta.startsWith('+')) {
      deltaCell.addClass('places-delta-positive');
    } else if (delta !== '-' && delta.startsWith('-')) {
      deltaCell.addClass('places-delta-negative');
    }
  }

  private formatDistanceDelta(d1: Kilometers, d2: Kilometers): string {
    const delta = (d2 as number) - (d1 as number);

    if (Math.abs(delta) < 0.01) return '-';
    const sign = delta > 0 ? '+' : '-';

    return `${sign}${formatKmInSystem(Math.abs(delta) as Kilometers, this.units)}`;
  }

  private formatElevationDelta(e1: Meters, e2: Meters): string {
    const delta = (e2 as number) - (e1 as number);

    if (Math.abs(delta) < 1) return '-';
    const sign = delta > 0 ? '+' : '-';

    return `${sign}${formatMetersInSystem(meters(Math.abs(delta)), this.units)}`;
  }

  private formatSpeedDelta(s1: KilometersPerHour | undefined, s2: KilometersPerHour | undefined): string {
    if (!s1 || !s2) return '-';
    const delta = (s2 as number) - (s1 as number);

    if (Math.abs(delta) < 0.1) return '-';
    const sign = delta > 0 ? '+' : '-';

    return `${sign}${formatKphInSystem(Math.abs(delta) as KilometersPerHour, this.units)}`;
  }

  private formatPaceDelta(p1: MinutesPerKilometer | undefined, p2: MinutesPerKilometer | undefined): string {
    if (!p1 || !p2) return '-';
    const delta = (p2 as number) - (p1 as number);

    if (Math.abs(delta) < 0.1) return '-';
    // For pace, negative delta means faster (better)
    const sign = delta > 0 ? '+' : '-';
    const mins = Math.floor(Math.abs(delta));
    const secs = Math.round((Math.abs(delta) - mins) * 60);

    return `${sign}${mins}:${secs.toString().padStart(2, '0')}`;
  }

  private formatDurationDelta(d1: number | null, d2: number | null): string {
    if (d1 === null || d2 === null) return '-';
    const delta = d2 - d1;

    if (Math.abs(delta) < 1) return '-';
    const sign = delta > 0 ? '+' : '-';

    return `${sign}${Utilities.formatDuration(Math.abs(delta), true, false)}`;
  }

  private calculateDuration(data: TrackData): number | null {
    const timePoints = data.points.filter(p => p.time);

    if (timePoints.length < 2) return null;

    return (timePoints[timePoints.length - 1].time!.getTime() - timePoints[0].time!.getTime()) / 1000;
  }
}
