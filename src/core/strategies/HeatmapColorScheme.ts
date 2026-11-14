import { DEFAULT_DENSITY_COLOR_SCHEME } from "places-shared/track";

export function resolveEffectiveHeatmapColorScheme(isHeatmapLayer: boolean, colorScheme: string, colorSchemeExplicit: boolean): string {
  return isHeatmapLayer && !colorSchemeExplicit ? DEFAULT_DENSITY_COLOR_SCHEME : colorScheme;
}
