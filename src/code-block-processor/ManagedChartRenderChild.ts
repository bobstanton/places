import { MarkdownPostProcessorContext, MarkdownRenderChild } from "obsidian";
import type { Chart } from "chart.js";

const activeCharts = new WeakMap<HTMLElement, ManagedChartRenderChild>();

class ManagedChartRenderChild extends MarkdownRenderChild {
  private disposed = false;

  constructor(
    containerEl: HTMLElement,
    private readonly ownerEl: HTMLElement,
    private readonly chart: Chart,
    private readonly cleanup?: () => void,
  ) {
    super(containerEl);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.chart.destroy();
    this.cleanup?.();
    if (activeCharts.get(this.ownerEl) === this) {
      activeCharts.delete(this.ownerEl);
    }
  }

  onunload(): void {
    this.dispose();
  }
}

export function disposeManagedChart(ownerEl: HTMLElement): void {
  activeCharts.get(ownerEl)?.dispose();
}

export function registerManagedChart(
  ctx: MarkdownPostProcessorContext,
  ownerEl: HTMLElement,
  chartEl: HTMLElement,
  chart: Chart,
  cleanup?: () => void,
): void {
  disposeManagedChart(ownerEl);
  const child = new ManagedChartRenderChild(chartEl, ownerEl, chart, cleanup);
  activeCharts.set(ownerEl, child);
  ctx.addChild(child);
}
