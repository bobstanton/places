export function resolveEffectiveHeatmapColorScheme(
  isHeatmapLayer: boolean,
  colorScheme: string,
  colorSchemeExplicit: boolean,
): string {
  return isHeatmapLayer && !colorSchemeExplicit ? "heat" : colorScheme;
}
