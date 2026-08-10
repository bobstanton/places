import { ColorSchemes } from "places-shared/worker-safe";

export class FrequencyVisualizationUtils {
  // colorScheme is a preset name (`yellow-to-red`, `blues`) or a custom list of hex colors.
  static getFrequencyColor(normalizedScore: number, colorScheme: string): string {
    return ColorSchemes.getHeatmapColor(normalizedScore, colorScheme);
  }

  static getLineWeight(normalizedScore: number): number {
    // Range from 2 to 8 pixels
    return 2 + (normalizedScore * 6);
  }

  static getLineOpacity(_normalizedScore: number): number {
    // Full opacity prevents color mixing from overlapping segments
    return 1.0;
  }
}
