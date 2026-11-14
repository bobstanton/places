import type * as GeoJSON from 'geojson';
import { formatKmInSystem, formatMetersInSystem, meters, type UnitsSystem } from 'places-shared/units';
import { DistanceCalculator, ElevationAccumulator } from 'places-shared/geo';
import { KNOWN_PLACE_CONTEXT_KEYS, toTitleCaseFrontmatterKey } from 'places-shared/map';

export { KNOWN_PLACE_CONTEXT_KEYS, toTitleCaseFrontmatterKey } from 'places-shared/map';

export function applyContextOverrides(context: Record<string, unknown>, overrides: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(overrides)) {
    if (KNOWN_PLACE_CONTEXT_KEYS.has(key)) continue;
    context[key] = value;
    context[key.toLowerCase()] = value;
    context[key.replace(/\s+/g, '_').toLowerCase()] = value;
    context[toTitleCaseFrontmatterKey(key)] = value;
  }
}

export function segmentLabelValues(line: GeoJSON.Position[], index: number, total: number, units: UnitsSystem): Record<string, unknown> {
  const distanceKm = DistanceCalculator.calculatePolylineDistanceKm(
    line.map(position => ({ latitude: position[1] ?? 0, longitude: position[0] ?? 0 })),
  );
  const elevation = new ElevationAccumulator();
  let min = Infinity;
  let max = -Infinity;

  for (const position of line) {
    const value = position[2];

    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    elevation.add(value);
    min = Math.min(min, value);
    max = Math.max(max, value);
  }

  const hasElevation = Number.isFinite(min);

  return {
    'Distance': formatKmInSystem(distanceKm, units),
    'Total Points': line.length,
    'Segment': index + 1,
    'Segment Count': total,
    'Elevation Gain': hasElevation && elevation.gainM > 0 ? formatMetersInSystem(meters(elevation.gainM), units) : '',
    'Elevation Loss': hasElevation && elevation.lossM > 0 ? formatMetersInSystem(meters(elevation.lossM), units) : '',
    'Min Elevation': hasElevation ? formatMetersInSystem(meters(min), units) : '',
    'Max Elevation': hasElevation ? formatMetersInSystem(meters(max), units) : '',
    'Duration': '',
    'Moving Time': '',
    'Average Speed': '',
    'Average Pace': '',
    'Max Speed': '',
    'Best Pace': '',
    'Start Time': '',
    'End Time': '',
  };
}
