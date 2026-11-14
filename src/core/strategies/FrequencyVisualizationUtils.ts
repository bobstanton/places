import { ColorSchemes } from "places-shared/worker-safe";

export class FrequencyVisualizationUtils {
  static getFrequencyColor(normalizedScore: number, colorScheme: string): string {
    return ColorSchemes.getHeatmapColor(normalizedScore, colorScheme);
  }

  static getLineWeight(normalizedScore: number): number {
    return 2 + (normalizedScore * 6);
  }

  static getLineOpacity(_normalizedScore: number): number {
    return 1.0;
  }
}
