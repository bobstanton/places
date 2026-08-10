export class ColorUtilities {
  static normalizeHexColor(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const hex = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
    return /^#[0-9a-f]{6}$/i.test(hex) ? hex : null;
  }

  static parseHexColorList(value: string): string[] {
    return value
      .split(/[,\n]/)
      .map((part) => this.normalizeHexColor(part))
      .filter((part): part is string => part !== null);
  }

  static hexToRgb(hex: string): { r: number; g: number; b: number } {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
      r: parseInt(result[1], 16),
      g: parseInt(result[2], 16),
      b: parseInt(result[3], 16)
    } : { r: 0, g: 0, b: 0 };
  }

  static rgbToHex(r: number, g: number, b: number): string {
    return '#' + [r, g, b].map(x => {
      const hex = x.toString(16);
      return hex.length === 1 ? '0' + hex : hex;
    }).join('');
  }

  static hexToRgba(hex: string, alpha: number): string {
    const rgb = this.hexToRgb(hex);
    return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
  }

  // color accepts rgba(), rgb(), or hex; alpha runs 0-1. An rgba() input returns unchanged.
  static convertColorToRgba(color: string, alpha: number): string {
    if (color.startsWith('rgba')) {
      return color;
    }

    if (color.startsWith('rgb(')) {
      const rgbValues = color.match(/\d+/g);
      if (rgbValues && rgbValues.length === 3) {
        return `rgba(${rgbValues[0]}, ${rgbValues[1]}, ${rgbValues[2]}, ${alpha})`;
      }
    }

    if (color.startsWith('#')) {
      return this.hexToRgba(color, alpha);
    }

    return color;
  }

  // Colors are hex; `ratio` runs 0 (color1) to 1 (color2).
  static interpolateColor(color1: string, color2: string, ratio: number): string {
    const c1 = this.hexToRgb(color1);
    const c2 = this.hexToRgb(color2);

    const r = Math.round(c1.r + (c2.r - c1.r) * ratio);
    const g = Math.round(c1.g + (c2.g - c1.g) * ratio);
    const b = Math.round(c1.b + (c2.b - c1.b) * ratio);

    return this.rgbToHex(r, g, b);
  }
}
