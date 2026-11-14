import { MapPlace } from "places-shared/overlay";
import { getErrorMessage } from "places-shared/utils";
import { createPlaceLabelResolver } from "./PlaceLabelTemplate";
import { labelInputSignature, type LabelResultCache } from './LabelResultCache';
import { LoopYieldController } from 'places/core/strategies';

export interface LabelTemplateResult {
  successCount: number;
  errors: LabelTemplateError[];
}

export interface LabelTemplateError {
  placeName: string;
  filePath?: string;
  message: string;
}

export interface PlaceLabelOutcome {
  error?: LabelTemplateError;
  templateError?: boolean;
}

class LabelTemplateService {
  // An unclosed brace is not a placeholder.
  private readonly placeholderRegex = /\{(this\.[^}]+|h\.[^}]+)\}/;

  // Property names are not validated against an allowlist: any frontmatter key
  // is a valid reference; the resolver reports genuinely unresolved tokens.
  validateTemplate(template: string): string[] {
    const errors: string[] = [];

    if (!template) {
      return errors;
    }

    const cleanTemplate = this.stripQuotes(template);

    if (!cleanTemplate) {
      return errors;
    }

    const openBraces = (cleanTemplate.match(/\{/g) || []).length;
    const closeBraces = (cleanTemplate.match(/\}/g) || []).length;

    if (openBraces !== closeBraces) {
      errors.push(`Mismatched braces: ${openBraces} opening '{' and ${closeBraces} closing '}'`);
    }

    const unclosedPattern = /\{(this\.|h\.)[^}]*$/;

    if (unclosedPattern.test(cleanTemplate)) {
      errors.push('Unclosed template expression - missing closing "}"');
    }

    return errors;
  }

  async processTemplate(template: string, place: MapPlace, cache?: LabelResultCache<string>): Promise<string> {
    if (!template || !this.placeholderRegex.test(template)) {
      return place.name;
    }

    const key = cache ? labelInputSignature(place, [template]) : undefined;
    const cached = cache?.get(key);

    if (cached !== undefined) return cached;
    const result = (await createPlaceLabelResolver(place).resolve(template)).trim();

    if (!result) {
      throw new Error('Template produced empty result');
    }

    if (key) cache?.set(key, result);

    return result;
  }

  async processPlaces(places: MapPlace[], template: string, cache?: LabelResultCache<string>, onResult?: (place: MapPlace, outcome: PlaceLabelOutcome) => void): Promise<LabelTemplateResult> {
    const result: LabelTemplateResult = {
      successCount: 0,
      errors: [],
    };

    const cleanTemplate = this.stripQuotes(template);

    if (!cleanTemplate || !this.placeholderRegex.test(cleanTemplate)) {
      result.successCount = places.length;
      if (onResult) for (const place of places) onResult(place, {});

      return result;
    }

    const validationErrors = this.validateTemplate(cleanTemplate);

    if (validationErrors.length > 0) {
      const error: LabelTemplateError = {
        placeName: '(template validation)',
        message: validationErrors.join('; '),
      };

      result.errors.push(error);
      if (onResult) for (const place of places) onResult(place, { error, templateError: true });

      return result;
    }

    const usable = cache?.admits(places.length) === false ? undefined : cache;
    const loop = new LoopYieldController({ batchSize: Infinity, maxIntervalMs: 8 });

    for (let index = 0; index < places.length; index++) {
      const place = places[index];

      if (!place.originalName) {
        place.originalName = place.name;
      }

      try {
        place.name = await this.processTemplate(cleanTemplate, place, usable);
        result.successCount++;
        onResult?.(place, {});
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        const templateError: LabelTemplateError = {
          placeName: place.originalName || place.name,
          filePath: place.filePath,
          message: errorMessage,
        };

        place.name = place.originalName || place.name;
        result.errors.push(templateError);
        onResult?.(place, { error: templateError });
      }

      await loop.yieldIfNeeded(index + 1);
    }

    return result;
  }

  private stripQuotes(value: string): string {
    if (!value) return value;
    const trimmed = value.trim();
    const quote = trimmed[0];

    if (trimmed.length >= 2 && (quote === '"' || quote === "'") && trimmed[trimmed.length - 1] === quote) {
      return trimmed.slice(1, -1);
    }

    return trimmed;
  }
}

let labelTemplateServiceInstance: LabelTemplateService | null = null;

export function getLabelTemplateService(): LabelTemplateService {
  if (!labelTemplateServiceInstance) {
    labelTemplateServiceInstance = new LabelTemplateService();
  }

  return labelTemplateServiceInstance;
}
