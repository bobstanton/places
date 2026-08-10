import { Chart, LineController, LineElement, PointElement, LinearScale, Filler, Legend, Tooltip, Title, Decimation, ChartDataset, type ChartOptions } from 'chart.js';
import { clamp } from "places-shared/utils";
import { TrackPoint, TrackData } from "./TrackDataService";
import { UnitsSystem, km, meters, kph, minPerKm, Meters, convertDistance, convertElevation, convertSpeed, convertPace, getDistanceUnit, getElevationUnit, getSpeedUnit, getPaceLabel, formatKmInSystem, formatMetersInSystem, Kilometers } from "places-shared/units";
import { NormalizedChartBlockSettings , type MetricWindow } from "places-shared/settings";
import { GradeCalculator } from "places-shared/geo";
import { ColorSchemes } from "places-shared/track";
import { ColorUtilities } from './ColorUtilities';

Chart.register(LineController, LineElement, PointElement, LinearScale, Filler, Legend, Tooltip, Title, Decimation);

export interface NamedTrack {
  data: TrackData;
  name: string;
}

interface ChartConfig {
  datasets: string[];
  xAxis: string;
  isTime: boolean;
}

const COMPARISON_COLORS = {
  TRACK1: '#2196f3',
  TRACK2: '#ff9800'
};

interface ChartRenderData {
  points: TrackPoint[];
  xAxisDisplay: number[];  // Pre-converted to display units (or time ms)
  grades: number[];
  gradeWindow: MetricWindow;
  config: ChartConfig;
  units: UnitsSystem;
  fillArea: boolean;
  smoothing: boolean;
  showPoints: boolean;
  showGrid: boolean;
}

const CHART_STYLES = {
  FILL_OPACITY: {
    GRADE_BACKGROUND: 0.25,
    ELEVATION_DEFAULT: 0.2,
    ELEVATION_GRADIENT: 0.3,
    GRADE_SEGMENT: 0.6
  },
  LINE: {
    WIDTH: 2,
    TENSION_SMOOTH: 0.4,
    TENSION_NONE: 0
  },
  POINT: {
    RADIUS: 3,
    HOVER_RADIUS: 6,
    BORDER_WIDTH: 2
  }
};

export class ChartService {

  createChart(chartEl: HTMLElement, data: TrackData, blockSettings: NormalizedChartBlockSettings, units: UnitsSystem, onPointHover?: (point: TrackPoint) => void, onPointClick?: (point: TrackPoint) => void): Chart {
    chartEl.empty();

    const canvas = chartEl.createEl("canvas");
    const ctx = canvas.getContext("2d");

    if (!ctx) {
      throw new Error("Failed to get canvas context");
    }

    const renderData = this.prepareRenderData(data.points, blockSettings, units);

    if (renderData.config.isTime) {
      const hasTimeData = renderData.points.some(p => p.time !== undefined);
      if (!hasTimeData) {
        throw new Error(
          `Chart type '${blockSettings.chartType}' requires timestamp data, but this track has none. ` +
          `Use '${blockSettings.chartType.replace('-time', '')}' for a distance-based chart instead.`
        );
      }
    }
    if (renderData.config.datasets.includes('speed') || renderData.config.datasets.includes('pace')) {
      const hasSpeedData = renderData.points.some(p => p.speedKph !== undefined);
      if (!hasSpeedData) {
        throw new Error(
          `Chart type '${blockSettings.chartType}' requires speed data derived from timestamps, but this track has no timestamps.`
        );
      }
    }

    const datasets: ChartDataset[] = [];
    const yAxes: Record<string, unknown> = {};

    renderData.config.datasets.forEach((datasetType, index) => {
      const yAxisId = index === 0 ? 'y' : `y${index}`;
      const isSecondary = index > 0;

      if (datasetType === 'elevation') {
        datasets.push(this.createElevationDataset(renderData, blockSettings));
        yAxes[yAxisId] = this.createElevationYAxis(renderData, units);
      } else if (datasetType === 'grade') {
        datasets.push(this.createGradeDataset(renderData, blockSettings, yAxisId));
        yAxes[yAxisId] = this.createGradeYAxis(renderData, isSecondary);
      } else if (datasetType === 'speed') {
        datasets.push(this.createSpeedDataset(renderData, blockSettings, yAxisId));
        yAxes[yAxisId] = this.createSpeedYAxis(renderData, isSecondary, units);
      } else if (datasetType === 'pace') {
        datasets.push(this.createPaceDataset(renderData, blockSettings, yAxisId));
        yAxes[yAxisId] = this.createPaceYAxis(renderData, isSecondary, units);
      }
    });

    const gradeColoringPlugin = {
      id: 'gradeColoring',
      afterDatasetsDraw: (chart: Chart) => {
        if (renderData.config.datasets.includes('elevation') && renderData.fillArea && blockSettings.colorBy === 'grade') {
          this.drawGradeSegments(chart, renderData);
        }
      }
    };

    return new Chart(ctx, {
      type: 'line',
      data: { datasets: datasets as ChartDataset<'line'>[] },
      options: {
        ...this.createChartOptions(data, blockSettings, renderData, yAxes),
        ...(onPointHover ? {
          onHover: (_event, elements) => {
            const index = elements[0]?.index;
            if (index !== undefined) onPointHover(renderData.points[index]);
          },
          onClick: (_event, elements) => {
            const index = elements[0]?.index;
            if (index !== undefined) (onPointClick ?? onPointHover)(renderData.points[index]);
          },
        } : {}),
      },
      plugins: [gradeColoringPlugin]
    });
  }

  createComparisonChart(chartEl: HTMLElement, track1: NamedTrack, track2: NamedTrack, blockSettings: NormalizedChartBlockSettings, units: UnitsSystem): Chart {
    chartEl.empty();

    const canvas = chartEl.createEl("canvas");
    const ctx = canvas.getContext("2d");

    if (!ctx) {
      throw new Error("Failed to get canvas context");
    }

    const fillArea = blockSettings.fillArea;
    const smoothing = blockSettings.smoothing;
    const showPoints = blockSettings.showPoints;
    const showGrid = blockSettings.showGrid;

    const maxDistanceKm = Math.max(Number(track1.data.metrics.distance), Number(track2.data.metrics.distance));
    const maxDistanceDisplay = convertDistance(km(maxDistanceKm), units);

    const numSamples = clamp(Math.round(maxDistanceDisplay * 10), 100, 500);
    const intervalDisplay = maxDistanceDisplay / numSamples;

    const resampled1 = this.resampleTrackToIntervals(track1.data.points, numSamples, intervalDisplay, units);
    const resampled2 = this.resampleTrackToIntervals(track2.data.points, numSamples, intervalDisplay, units);

    const datasets: ChartDataset[] = [
      {
        label: track1.name,
        data: resampled1,
        fill: fillArea,
        tension: smoothing ? CHART_STYLES.LINE.TENSION_SMOOTH : CHART_STYLES.LINE.TENSION_NONE,
        borderWidth: CHART_STYLES.LINE.WIDTH,
        pointRadius: showPoints ? CHART_STYLES.POINT.RADIUS : 0,
        pointHoverRadius: CHART_STYLES.POINT.HOVER_RADIUS,
        pointBorderWidth: CHART_STYLES.POINT.BORDER_WIDTH,
        borderColor: COMPARISON_COLORS.TRACK1,
        pointBackgroundColor: COMPARISON_COLORS.TRACK1,
        backgroundColor: fillArea ? ColorUtilities.hexToRgba(COMPARISON_COLORS.TRACK1, 0.15) : 'transparent',
        order: 2
      },
      {
        label: track2.name,
        data: resampled2,
        fill: fillArea,
        tension: smoothing ? CHART_STYLES.LINE.TENSION_SMOOTH : CHART_STYLES.LINE.TENSION_NONE,
        borderWidth: CHART_STYLES.LINE.WIDTH,
        pointRadius: showPoints ? CHART_STYLES.POINT.RADIUS : 0,
        pointHoverRadius: CHART_STYLES.POINT.HOVER_RADIUS,
        pointBorderWidth: CHART_STYLES.POINT.BORDER_WIDTH,
        borderColor: COMPARISON_COLORS.TRACK2,
        pointBackgroundColor: COMPARISON_COLORS.TRACK2,
        backgroundColor: fillArea ? ColorUtilities.hexToRgba(COMPARISON_COLORS.TRACK2, 0.15) : 'transparent',
        order: 1
      }
    ];

    const elevUnit = getElevationUnit(units).abbreviation;
    const distUnit = getDistanceUnit(units).abbreviation;

    return new Chart(ctx, {
      type: 'line',
      data: { datasets: datasets as ChartDataset<'line'>[] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: 'index',
          intersect: false,
        },
        plugins: {
          title: {
            display: !!blockSettings.title,
            text: blockSettings.title || 'Track Comparison',
            font: {
              size: blockSettings.fontSize + 2
            }
          },
          legend: {
            display: true,
            position: 'top'
          },
          tooltip: {
            callbacks: {
              title: (context: unknown[]) => {
                const item = context[0] as { parsed: { x: number | null } };
                const xValue = item.parsed.x ?? 0;
                return `Distance: ${xValue.toFixed(2)} ${distUnit}`;
              },
              label: (context: unknown) => {
                const item = context as { dataset: { label?: string }; parsed: { y: number | null } };
                return `${item.dataset.label}: ${(item.parsed.y ?? 0).toFixed(0)} ${elevUnit}`;
              }
            }
          }
        },
        scales: {
          x: {
            type: 'linear',
            display: true,
            title: {
              display: true,
              text: `Distance (${distUnit})`
            },
            grid: {
              display: showGrid
            },
            ticks: {
              color: blockSettings.axisColor,
              font: {
                size: blockSettings.fontSize
              },
              stepSize: Number(this.calculateStepSize(km(maxDistanceKm), units))
            },
            min: 0,
            max: maxDistanceDisplay,
          },
          y: {
            type: 'linear',
            display: true,
            position: 'left',
            title: {
              display: true,
              text: `Elevation (${getElevationUnit(units).abbreviation})`
            },
            grid: {
              display: showGrid
            }
          }
        }
      }
    });
  }

  private prepareRenderData(points: TrackPoint[], blockSettings: NormalizedChartBlockSettings, units: UnitsSystem): ChartRenderData {
    const config = this.parseChartType(blockSettings.chartType);

    const gradeWindow = blockSettings.gradeWindow;

    const grades = points.map((_, index) =>
      GradeCalculator.calculateRollingGrade(points, index, gradeWindow)
    );

    const xAxisDisplay = config.isTime
      ? points.map(p => p.time?.getTime() || 0)
      : points.map(p => convertDistance(km(p.distanceKm), units));

    return {
      points,
      xAxisDisplay,
      grades,
      gradeWindow,
      config,
      units,
      fillArea: blockSettings.fillArea,
      smoothing: blockSettings.smoothing,
      showPoints: blockSettings.showPoints,
      showGrid: blockSettings.showGrid
    };
  }

  private createElevationDataset(renderData: ChartRenderData, blockSettings: NormalizedChartBlockSettings): ChartDataset {
    const color = blockSettings.elevationColor;
    const colorBy = blockSettings.colorBy;

    let backgroundColor: string | ((context: unknown) => string | CanvasGradient) = 'transparent';
    if (renderData.fillArea) {
      if (colorBy === 'grade') {
        backgroundColor = ColorUtilities.hexToRgba(color, CHART_STYLES.FILL_OPACITY.GRADE_BACKGROUND);
      } else if (colorBy === 'elevation') {
        backgroundColor = this.createElevationGradient(renderData.points);
      } else {
        backgroundColor = ColorUtilities.hexToRgba(color, CHART_STYLES.FILL_OPACITY.ELEVATION_DEFAULT);
      }
    }

    return {
      label: 'Elevation',
      data: renderData.points.map((point, index) => ({
        x: renderData.xAxisDisplay[index],
        y: convertElevation(point.elevationMeters || meters(0), renderData.units)
      })),
      fill: renderData.fillArea,
      tension: renderData.smoothing ? CHART_STYLES.LINE.TENSION_SMOOTH : CHART_STYLES.LINE.TENSION_NONE,
      borderWidth: CHART_STYLES.LINE.WIDTH,
      pointRadius: renderData.showPoints ? CHART_STYLES.POINT.RADIUS : 0,
      pointHoverRadius: CHART_STYLES.POINT.HOVER_RADIUS,
      pointBorderWidth: CHART_STYLES.POINT.BORDER_WIDTH,
      borderColor: color,
      pointBackgroundColor: color,
      backgroundColor: backgroundColor,
      order: 2
    };
  }

  private createGradeDataset(renderData: ChartRenderData, blockSettings: NormalizedChartBlockSettings, yAxisId: string): ChartDataset {
    const color = blockSettings.gradeColor;

    return {
      label: 'Grade',
      data: renderData.points.map((_, index) => ({
        x: renderData.xAxisDisplay[index],
        y: renderData.grades[index]
      })),
      fill: false,
      tension: renderData.smoothing ? CHART_STYLES.LINE.TENSION_SMOOTH : CHART_STYLES.LINE.TENSION_NONE,
      borderWidth: CHART_STYLES.LINE.WIDTH,
      order: 1,
      pointRadius: renderData.showPoints ? CHART_STYLES.POINT.RADIUS : 0,
      pointHoverRadius: CHART_STYLES.POINT.HOVER_RADIUS,
      pointBorderWidth: CHART_STYLES.POINT.BORDER_WIDTH,
      yAxisID: yAxisId,
      borderColor: color,
      pointBackgroundColor: color,
      borderDash: [8, 4]
    };
  }

  private createSpeedDataset(renderData: ChartRenderData, blockSettings: NormalizedChartBlockSettings, yAxisId: string): ChartDataset {
    const color = blockSettings.speedColor;
    return this.createGenericDataset(renderData, blockSettings, {
      label: 'Speed',
      valueExtractor: (point) => convertSpeed(point.speedKph || kph(0), renderData.units),
      color,
      yAxisId
    });
  }

  private createPaceDataset(renderData: ChartRenderData, blockSettings: NormalizedChartBlockSettings, yAxisId: string): ChartDataset {
    const color = blockSettings.paceColor;
    return this.createGenericDataset(renderData, blockSettings, {
      label: 'Pace',
      valueExtractor: (point) => convertPace(point.paceMinPerKm || minPerKm(0), renderData.units),
      color,
      yAxisId
    });
  }

  private createGenericDataset(
    renderData: ChartRenderData,
    _blockSettings: NormalizedChartBlockSettings,
    config: {
      label: string;
      valueExtractor: (point: TrackPoint) => number;
      color: string;
      yAxisId: string;
    }
  ): ChartDataset {
    return {
      label: config.label,
      data: renderData.points.map((point, index) => ({
        x: renderData.xAxisDisplay[index],
        y: config.valueExtractor(point)
      })),
      fill: false,
      tension: renderData.smoothing ? CHART_STYLES.LINE.TENSION_SMOOTH : CHART_STYLES.LINE.TENSION_NONE,
      borderWidth: CHART_STYLES.LINE.WIDTH,
      pointRadius: renderData.showPoints ? CHART_STYLES.POINT.RADIUS : 0,
      pointHoverRadius: CHART_STYLES.POINT.HOVER_RADIUS,
      pointBorderWidth: CHART_STYLES.POINT.BORDER_WIDTH,
      yAxisID: config.yAxisId,
      borderColor: config.color,
      pointBackgroundColor: config.color
    };
  }

  private createElevationYAxis(renderData: ChartRenderData, units: UnitsSystem): unknown {
    return this.createGenericYAxis({
      title: `Elevation (${getElevationUnit(units).abbreviation})`,
      isSecondary: false,
      showGrid: renderData.showGrid
    });
  }

  private createSpeedYAxis(renderData: ChartRenderData, isSecondary: boolean, units: UnitsSystem): unknown {
    return this.createGenericYAxis({
      title: `Speed (${getSpeedUnit(units).abbreviation})`,
      isSecondary,
      showGrid: renderData.showGrid
    });
  }

  private createGradeYAxis(renderData: ChartRenderData, isSecondary: boolean): unknown {
    return this.createGenericYAxis({
      title: 'Grade (%)',
      isSecondary,
      showGrid: renderData.showGrid
    });
  }

  private createPaceYAxis(renderData: ChartRenderData, isSecondary: boolean, units: UnitsSystem): unknown {
    return this.createGenericYAxis({
      title: getPaceLabel(units),
      isSecondary,
      showGrid: renderData.showGrid,
      reverse: true
    });
  }

  private createGenericYAxis(config: {
    title: string;
    isSecondary: boolean;
    showGrid: boolean;
    reverse?: boolean;
  }): unknown {
    return {
      type: 'linear',
      display: true,
      position: config.isSecondary ? 'right' : 'left',
      title: {
        display: true,
        text: config.title
      },
      grid: {
        display: config.isSecondary ? false : config.showGrid
      },
      ...(config.reverse ? { reverse: true } : {})
    };
  }

  private createChartOptions(data: TrackData, blockSettings: NormalizedChartBlockSettings, renderData: ChartRenderData, yAxes: Record<string, unknown>): ChartOptions<'line'> {
    const { points, config, units } = renderData;

    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false,
      },
      plugins: {
        title: {
          display: !!blockSettings.title,
          text: blockSettings.title || '',
          font: {
            size: blockSettings.fontSize + 2
          }
        },
        legend: {
          display: config.datasets.length > 1,
          position: 'top'
        },
        tooltip: {
          callbacks: {
            title: (context: Array<{ dataIndex: number }>) => {
              const point = points[context[0].dataIndex];
              return config.isTime && point.time
                ? point.time.toLocaleTimeString()
                : `Distance: ${formatKmInSystem(point.distanceKm, units)}`;
            },
            afterTitle: (context: Array<{ dataIndex: number }>) => {
              const index = context[0].dataIndex;
              const point = points[index];
              const info: string[] = [];

              if (config.isTime && point.elevationMeters !== undefined) {
                info.push(`Elevation: ${formatMetersInSystem(point.elevationMeters, units)}`);
              } else if (point.time) {
                info.push(`Time: ${point.time.toLocaleTimeString()}`);
              }

              if (config.datasets.includes('elevation') && index > 0) {
                info.push(`Grade: ${renderData.grades[index].toFixed(1)}%`);
              }

              return info.join('\n');
            }
          }
        },
        decimation: {
          enabled: true,
          algorithm: 'lttb',
          samples: 1000,
          threshold: 1000
        }
      },
      scales: {
        x: {
          type: 'linear',
          display: true,
          title: {
            display: true,
            text: config.isTime ? 'Time' : `Distance (${getDistanceUnit(units).abbreviation})`
          },
          grid: {
            display: renderData.showGrid
          },
          ticks: {
            color: blockSettings.axisColor,
            font: {
              size: blockSettings.fontSize
            },
            ...(config.isTime && {
              callback: function(value: number | string) {
                return new Date(value).toLocaleTimeString(undefined, {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit'
                });
              }
            }),
            ...(!config.isTime && { stepSize: this.calculateStepSize(data.metrics.distance, units) })
          },
          min: config.isTime ? (points[0]?.time?.getTime() || 0) : 0,
          max: config.isTime ? (points[points.length - 1]?.time?.getTime() || 0) : convertDistance(data.metrics.distance, units),
        },
        ...yAxes
      }
    };
  }

  private calculateStepSize(totalDistanceInKm: Kilometers, units: UnitsSystem): number {
    const distanceDisplay = convertDistance(totalDistanceInKm, units);

    if (distanceDisplay <= 1) return 0.1;
    if (distanceDisplay <= 5) return 0.5;
    if (distanceDisplay <= 10) return 1;
    if (distanceDisplay <= 50) return 5;
    if (distanceDisplay <= 100) return 10;
    return 20;
  }

  private parseChartType(chartType: string): ChartConfig {
    switch (chartType.toLowerCase()) {
      case 'elevation':
        return { datasets: ['elevation'], xAxis: 'distance', isTime: false };
      case 'elevation-grade':
        return { datasets: ['elevation', 'grade'], xAxis: 'distance', isTime: false };
      case 'elevation-time':
        return { datasets: ['elevation'], xAxis: 'time', isTime: true };
      case 'speed':
        return { datasets: ['speed'], xAxis: 'distance', isTime: false };
      case 'speed-time':
        return { datasets: ['speed'], xAxis: 'time', isTime: true };
      case 'pace':
        return { datasets: ['pace'], xAxis: 'distance', isTime: false };
      case 'pace-time':
        return { datasets: ['pace'], xAxis: 'time', isTime: true };
      case 'grade':
        return { datasets: ['grade'], xAxis: 'distance', isTime: false };
      default:
        return { datasets: ['elevation'], xAxis: 'distance', isTime: false };
    }
  }

  private createElevationGradient(points: TrackPoint[]): (context: unknown) => CanvasGradient | string {
    return (context: unknown) => {
      const ctx = context as { chart: { ctx: CanvasRenderingContext2D; chartArea: { left: number; right: number; top: number; bottom: number } | undefined } };
      const chart = ctx.chart;
      const {ctx: canvasCtx, chartArea} = chart;

      if (!chartArea) {
        return 'rgba(33, 150, 243, 0.2)';
      }

      const gradient = canvasCtx.createLinearGradient(chartArea.left, 0, chartArea.right, 0);

      let minElevation = (points[0].elevationMeters || 0) as number;
      let maxElevation = minElevation;
      for (let i = 1; i < points.length; i++) {
        const e = (points[i].elevationMeters || 0) as number;
        if (e < minElevation) minElevation = e;
        if (e > maxElevation) maxElevation = e;
      }

      // Distance-based positions match the chart x-axis.
      const totalDistance = points.length > 0 ? (points[points.length - 1].distanceKm as number) : 0;

      const maxStops = 100;
      const step = points.length > maxStops ? Math.floor(points.length / maxStops) : 1;

      for (let i = 0; i < points.length; i += step) {
        const position = totalDistance > 0
          ? (points[i].distanceKm as number) / totalDistance
          : i / Math.max(1, points.length - 1);
        const elevation = points[i].elevationMeters ?? meters(0);
        const color = ColorSchemes.getElevationColor(elevation, minElevation as Meters, maxElevation as Meters);
        const colorWithAlpha = ColorUtilities.convertColorToRgba(color, CHART_STYLES.FILL_OPACITY.ELEVATION_GRADIENT);
        gradient.addColorStop(position, colorWithAlpha);
      }

      // Include the last point to reach position 1.0.
      if (step > 1) {
        const lastIdx = points.length - 1;
        const lastPos = totalDistance > 0 ? (points[lastIdx].distanceKm as number) / totalDistance : 1;
        const lastElev = points[lastIdx].elevationMeters ?? meters(0);
        const lastColor = ColorSchemes.getElevationColor(lastElev, minElevation as Meters, maxElevation as Meters);
        gradient.addColorStop(lastPos, ColorUtilities.convertColorToRgba(lastColor, CHART_STYLES.FILL_OPACITY.ELEVATION_GRADIENT));
      }

      return gradient;
    };
  }

  private drawGradeSegments(chart: Chart, renderData: ChartRenderData): void {
    const ctx = chart.ctx;
    const chartArea = chart.chartArea;
    const meta = chart.getDatasetMeta(0);

    if (!meta || !meta.data || meta.data.length < 2) return;

    ctx.save();

    for (let i = 1; i < renderData.points.length; i++) {
      const grade = renderData.grades[i];
      const color = ColorSchemes.getGradeColor(grade);
      const colorWithAlpha = ColorUtilities.convertColorToRgba(color, CHART_STYLES.FILL_OPACITY.GRADE_SEGMENT);

      const prevPoint = meta.data[i - 1];
      const currPoint = meta.data[i];

      if (!prevPoint || !currPoint) continue;

      const x1 = prevPoint.x;
      const x2 = currPoint.x;
      const y1 = prevPoint.y;
      const y2 = currPoint.y;
      const bottomY = chartArea.bottom;

      ctx.fillStyle = colorWithAlpha;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.lineTo(x2, bottomY);
      ctx.lineTo(x1, bottomY);
      ctx.closePath();
      ctx.fill();
    }

    ctx.restore();
  }

  private resampleTrackToIntervals(points: TrackPoint[], numSamples: number, intervalDisplay: number, units: UnitsSystem): Array<{ x: number; y: number }> {
    if (points.length === 0) return [];

    const result: Array<{ x: number; y: number }> = [];
    const trackMaxDistanceDisplay = convertDistance(km(points[points.length - 1].distanceKm), units);

    const pointsDisplay = points.map(p => ({
      x: convertDistance(km(p.distanceKm), units),
      y: convertElevation(p.elevationMeters || meters(0), units)
    }));

    let pointIndex = 0;

    for (let i = 0; i <= numSamples; i++) {
      const targetX = i * intervalDisplay;

      if (targetX > trackMaxDistanceDisplay) break;

      while (pointIndex < pointsDisplay.length - 1 && pointsDisplay[pointIndex + 1].x < targetX) {
        pointIndex++;
      }

      if (pointIndex >= pointsDisplay.length - 1) {
        result.push({ x: targetX, y: pointsDisplay[pointsDisplay.length - 1].y });
      } else {
        const p1 = pointsDisplay[pointIndex];
        const p2 = pointsDisplay[pointIndex + 1];
        const t = (targetX - p1.x) / (p2.x - p1.x || 1);
        const interpolatedY = p1.y + t * (p2.y - p1.y);
        result.push({ x: targetX, y: interpolatedY });
      }
    }

    return result;
  }
}
