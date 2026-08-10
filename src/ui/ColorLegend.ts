import { Meters, UnitsSystem, formatMetersInSystem } from 'places-shared/units';
import { GRADE_COLOR_BANDS, getElevationGradientCSS } from 'places-shared/track';

export type LegendPosition = 'top' | 'bottom' | null;

export function getLegendPosition(colorBy: string | undefined, legend: string): LegendPosition {
  if (legend === 'hidden') return null;
  if (colorBy !== 'elevation' && colorBy !== 'grade') return null;
  return legend as 'top' | 'bottom';
}

export function createGradeLegend(container: HTMLElement): HTMLElement {
  const legend = container.createDiv('places-color-legend places-grade-legend');
  legend.createSpan({ text: 'Grade:', cls: 'places-legend-title' });

  const bandsContainer = legend.createDiv('places-legend-bands');

  for (const band of GRADE_COLOR_BANDS) {
    const bandEl = bandsContainer.createDiv('places-legend-band');
    const colorBox = bandEl.createDiv('places-legend-color-box');
    colorBox.setCssProps({
      '--places-legend-color': band.color
    });
    bandEl.createSpan({ text: band.label, cls: 'places-legend-band-label' });
  }

  return legend;
}

export function createElevationLegend(container: HTMLElement, minElevation: Meters, maxElevation: Meters, units: UnitsSystem): HTMLElement {
  const legend = container.createDiv('places-color-legend places-elevation-legend');

  const minFormatted = formatMetersInSystem(minElevation, units);
  legend.createSpan({ text: minFormatted, cls: 'places-legend-label places-legend-low' });

  const gradientBar = legend.createDiv('places-legend-gradient');
  gradientBar.setCssProps({
    '--places-legend-gradient': getElevationGradientCSS()
  });

  const maxFormatted = formatMetersInSystem(maxElevation, units);
  legend.createSpan({ text: maxFormatted, cls: 'places-legend-label places-legend-high' });

  return legend;
}

export function getElevationRange(elevations: (Meters | undefined | null)[]): { min: Meters; max: Meters } | null {
  const valid = elevations.filter((e): e is Meters => e !== undefined && e !== null && !isNaN(e));
  if (valid.length === 0) return null;

  return {
    min: Math.min(...valid) as Meters,
    max: Math.max(...valid) as Meters
  };
}
