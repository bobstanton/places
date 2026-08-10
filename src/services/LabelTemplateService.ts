import { MapPlace } from "places-shared/overlay";
import { getErrorMessage } from "places-shared/utils";
import { createPlaceLabelResolver } from "./PlaceLabelTemplate";

export interface LabelTemplateResult {
  successCount: number;
  errors: LabelTemplateError[];
}

export interface LabelTemplateError {
  placeName: string;
  filePath?: string;
  message: string;
}

// A wrapper around the shared place-label resolver, adding the two things the
// map surfaces need: original names preserved for recovery, and per-place
// errors collected for display under the block. The template surface (helpers,
// properties, expression support) is documented in `places-style-help` and not
// restated here.
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

  // Returns the original name when the template is empty or has no placeholders; throws when processing fails.
  async processTemplate(template: string, place: MapPlace): Promise<string> {
    if (!template || !this.placeholderRegex.test(template)) {
      return place.name;
    }

    const result = (await createPlaceLabelResolver(place).resolve(template)).trim();

    if (!result) {
      throw new Error('Template produced empty result');
    }

    return result;
  }

  // Preserves original names in place.originalName; mutates `places` in place.
  async processPlaces(places: MapPlace[], template: string): Promise<LabelTemplateResult> {
    const result: LabelTemplateResult = {
      successCount: 0,
      errors: [],
    };

    const cleanTemplate = this.stripQuotes(template);

    if (!cleanTemplate || !this.placeholderRegex.test(cleanTemplate)) {
      result.successCount = places.length;
      return result;
    }

    const validationErrors = this.validateTemplate(cleanTemplate);
    if (validationErrors.length > 0) {
      result.errors.push({
        placeName: '(template validation)',
        message: validationErrors.join('; '),
      });
      return result;
    }

    const outcomes = await Promise.all(places.map(async place => {
      if (!place.originalName) {
        place.originalName = place.name;
      }

      try {
        place.name = await this.processTemplate(cleanTemplate, place);
        return undefined;
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        const templateError: LabelTemplateError = {
          placeName: place.originalName || place.name,
          filePath: place.filePath,
          message: errorMessage,
        };
        place.name = place.originalName || place.name;
        return templateError;
      }
    }));

    result.errors = outcomes.filter((error): error is LabelTemplateError => error !== undefined);
    result.successCount = places.length - result.errors.length;

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
