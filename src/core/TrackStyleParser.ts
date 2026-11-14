import colorNames from 'color-name';
import type { MapPlace } from 'places-shared/place';
import { TRACK_COLOR_BY_MODES, type TrackColorBy } from 'places-shared/track';
import { scalarToString } from 'places-shared/utils';

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

export class TrackStyleParser {
  static parseStylePart(stylePart: string): ParsedTrackStyle | null {
    const trimmed = stylePart.trim();

    if (!trimmed) return null;

    const result: ParsedTrackStyle = {};
    const tokens = trimmed.split(/\s+/);

    for (const rawToken of tokens) {
      const token = rawToken.toLowerCase();

      if (token === 'solid' || token === 'dashed') {
        result.style = token;
        continue;
      }

      if (/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(token) || this.isNamedColor(token)) {
        result.color = token;
        continue;
      }

      const num = Number(token);

      if (Number.isFinite(num)) {
        if (result.weight !== undefined) {
          if (result.opacity !== undefined || num < 0 || num > 1) return null;
          result.opacity = num;
        } else {
          if (num <= 0) return null;
          result.weight = num;
        }

        continue;
      }

      return null;
    }

    if (result.weight === undefined && result.style === undefined && result.color === undefined) {
      return null;
    }

    return result;
  }

  static parseTrackStyle(value: string): ParsedTrackStyleResult | null {
    if (!value || typeof value !== 'string') return null;

    const parts = value.split(';').map(p => p.trim()).filter(p => p.length > 0);

    if (parts.length === 0 || parts.length > 2) return null;

    const main = this.parseStylePart(parts[0]);

    if (!main) return null;

    const result: ParsedTrackStyleResult = {
      main,
      hasOutline: parts.length > 1
    };

    if (parts.length > 1) {
      const outline = this.parseStylePart(parts[1]);

      if (!outline) return null;
      result.outline = outline;
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
        if (parsed.outline.style !== undefined) place.trackOutlineStyle = parsed.outline.style;

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
    }
  }

  static applyStyles(place: MapPlace, trackStyleValue: unknown, trackColorByValue: unknown): void {
    if (trackStyleValue) {
      const parsed = this.parseTrackStyle(scalarToString(trackStyleValue));

      if (!parsed) throw new Error('track.style must use "weight solid|dashed color [opacity]", optionally followed by "; outline style". Width must be positive and opacity between 0 and 1.');
      this.applyToMapPlace(place, parsed);
      this.applyMainColorToOverlayFeatures(place, parsed);
    }

    if (typeof trackColorByValue === 'string') {
      const normalized = trackColorByValue.toLowerCase().trim();

      if (normalized && !(TRACK_COLOR_BY_MODES as readonly string[]).includes(normalized)) {
        throw new Error(`track.colorBy must be one of: ${TRACK_COLOR_BY_MODES.join(', ')}.`);
      }

      if (normalized) place.trackColorBy = normalized as TrackColorBy;
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
    return str === 'transparent' || Object.prototype.hasOwnProperty.call(colorNames, str.toLowerCase());
  }
}
