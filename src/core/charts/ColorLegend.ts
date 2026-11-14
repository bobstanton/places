import { formatMetersInSystem, Meters, UnitsSystem } from 'places-shared/units';
import { getElevationGradientCSS, GRADE_COLOR_BANDS } from 'places-shared/track';
import { createDiv, createSpan, setCssProperties } from 'places-shared/utils';

export type LegendPosition = 'top' | 'bottom' | null;

export function getLegendPosition(colorBy: string | undefined, legend: string): LegendPosition {
  if (legend === 'hidden') return null;
  if (colorBy !== 'elevation' && colorBy !== 'grade') return null;

  return legend as 'top' | 'bottom';
}

export function createGradeLegend(container: HTMLElement): HTMLElement {
  const legend = createDiv(container, 'places-color-legend places-grade-legend');

  createSpan(legend, { text: 'Grade:', cls: 'places-legend-title' });

  const bandsContainer = createDiv(legend, 'places-legend-bands');

  for (const band of GRADE_COLOR_BANDS) {
    const bandEl = createDiv(bandsContainer, 'places-legend-band');
    const colorBox = createDiv(bandEl, 'places-legend-color-box');

    setCssProperties(colorBox, {
      '--places-legend-color': band.color
    });
    createSpan(bandEl, { text: band.label, cls: 'places-legend-band-label' });
  }

  return legend;
}

export function createElevationLegend(container: HTMLElement, minElevation: Meters, maxElevation: Meters, units: UnitsSystem): HTMLElement {
  const legend = createDiv(container, 'places-color-legend places-elevation-legend');

  const minFormatted = formatMetersInSystem(minElevation, units);

  createSpan(legend, { text: minFormatted, cls: 'places-legend-label places-legend-low' });

  const gradientBar = createDiv(legend, 'places-legend-gradient');

  setCssProperties(gradientBar, {
    '--places-legend-gradient': getElevationGradientCSS()
  });

  const maxFormatted = formatMetersInSystem(maxElevation, units);

  createSpan(legend, { text: maxFormatted, cls: 'places-legend-label places-legend-high' });

  return legend;
}

export function getElevationRange(elevations: Iterable<Meters | undefined | null>): { min: Meters; max: Meters } | null {
  let min: Meters | undefined;
  let max: Meters | undefined;

  for (const elevation of elevations) {
    if (elevation == null || !Number.isFinite(elevation)) continue;
    if (min === undefined || elevation < min) min = elevation;
    if (max === undefined || elevation > max) max = elevation;
  }

  return min === undefined || max === undefined ? null : { min, max };
}
