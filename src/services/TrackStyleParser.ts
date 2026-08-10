import { MapPlace } from "places-shared/overlay";
import type { TrackColorBy } from "places-shared/track";
import { scalarToString } from "places-shared/utils";

const VALID_COLOR_BY: TrackColorBy[] = ['none', 'elevation', 'grade', 'speed', 'pace'];

export interface ParsedTrackStyle {
  weight?: number;
  style?: 'solid' | 'dashed';
  color?: string;
  opacity?: number;
}

export interface ParsedTrackStyleResult {
  main: ParsedTrackStyle;
  outline?: ParsedTrackStyle;
  hasOutline: boolean;
}

// `weight style color [opacity]`, semicolon-separated; the second part is the outline.
//   "4 dashed #39e657"
//   "4 dashed #39e657 0.8"
//   "4 dashed #39e657; 8 solid #000000 0.3"
export class TrackStyleParser {

  static parseStylePart(stylePart: string): ParsedTrackStyle | null {
    const trimmed = stylePart.trim();
    if (!trimmed) return null;

    const result: ParsedTrackStyle = {};
    const tokens = trimmed.split(/\s+/);

    for (const token of tokens) {
      if (token === 'solid' || token === 'dashed') {
        result.style = token;
        continue;
      }

      if (token.startsWith('#') || this.isNamedColor(token)) {
        result.color = token;
        continue;
      }

      const num = parseFloat(token);
      if (!isNaN(num)) {
        // A second number after the weight is opacity
        if (result.weight !== undefined) {
          result.opacity = num;
        } else {
          result.weight = num;
        }
        continue;
      }
    }

    if (result.weight === undefined && result.style === undefined && result.color === undefined) {
      return null;
    }

    return result;
  }

  static parseTrackStyle(value: string): ParsedTrackStyleResult | null {
    if (!value || typeof value !== 'string') return null;

    const parts = value.split(';').map(p => p.trim()).filter(p => p.length > 0);

    if (parts.length === 0) return null;

    const main = this.parseStylePart(parts[0]);
    if (!main) return null;

    const result: ParsedTrackStyleResult = {
      main,
      hasOutline: parts.length > 1
    };

    if (parts.length > 1) {
      const outline = this.parseStylePart(parts[1]);
      if (outline) {
        result.outline = outline;
      }
    }

    return result;
  }

  static applyToMapPlace(place: MapPlace, parsed: ParsedTrackStyleResult): void {
    if (parsed.main.color !== undefined) {
      place.trackColor = parsed.main.color;
    }
    if (parsed.main.weight !== undefined) {
      place.trackWeight = parsed.main.weight;
    }
    if (parsed.main.opacity !== undefined) {
      place.trackOpacity = parsed.main.opacity;
    }
    if (parsed.main.style !== undefined) {
      place.trackStyle = parsed.main.style;
    }

    if (parsed.hasOutline) {
      place.trackOutline = true;

      if (parsed.outline) {
        if (parsed.outline.color !== undefined) {
          place.trackOutlineColor = parsed.outline.color;
        }
        if (parsed.outline.weight !== undefined) {
          place.trackOutlineWeight = parsed.outline.weight;
        }
        if (parsed.outline.opacity !== undefined) {
          place.trackOutlineOpacity = parsed.outline.opacity;
        }
      }
    } else {
      // Explicit no outline when only main style is specified
      place.trackOutline = false;
    }
  }

  static applyFrontmatterStyling(place: MapPlace, trackStyleValue: unknown, trackColorByValue: unknown): void {
    if (trackStyleValue) {
      const parsed = this.parseTrackStyle(scalarToString(trackStyleValue));
      if (parsed) {
        this.applyToMapPlace(place, parsed);
        // Stamp the color onto the overlay's line features too: every render path resolves
        // `line-color` as coalesce(feature.stroke, style.color).
        this.applyMainColorToOverlayFeatures(place, parsed);
      }
    }
    if (typeof trackColorByValue === 'string') {
      const normalized = trackColorByValue.toLowerCase().trim();
      if ((VALID_COLOR_BY as string[]).includes(normalized)) {
        place.trackColorBy = normalized as TrackColorBy;
      }
    }
  }

  private static applyMainColorToOverlayFeatures(place: MapPlace, parsed: ParsedTrackStyleResult): void {
    const geojson = place.overlay?.geojson;
    if (!geojson || !('features' in geojson) || !Array.isArray(geojson.features)) return;
    const { color, weight, opacity } = parsed.main;
    if (color === undefined && weight === undefined && opacity === undefined) return;

    for (const feature of geojson.features) {
      const geomType = feature.geometry?.type;
      if (geomType !== 'LineString' && geomType !== 'MultiLineString') continue;
      const props: Record<string, unknown> = { ...(feature.properties ?? {}) };
      if (color !== undefined) props.stroke = color;
      if (weight !== undefined) props['stroke-width'] = weight;
      if (opacity !== undefined) props['stroke-opacity'] = opacity;
      feature.properties = props;
    }
  }

  private static isNamedColor(str: string): boolean {
    const namedColors = [
      'black', 'white', 'red', 'green', 'blue', 'yellow', 'orange', 'purple',
      'pink', 'cyan', 'magenta', 'gray', 'grey', 'brown', 'navy', 'teal',
      'olive', 'maroon', 'aqua', 'lime', 'silver', 'fuchsia'
    ];
    return namedColors.includes(str.toLowerCase());
  }
}
