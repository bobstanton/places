import { serializeUnknown } from "places-shared/utils";

export class TemplateService {
  static replaceSimple(template: string, values: Record<string, string>): string {
    return Object.entries(values).reduce(
      (result, [key, value]) => result.replace(new RegExp(`\\{${key}\\}`, 'g'), value || ''),
      template
    );
  }

  static replaceDollar(template: string, values: Record<string, unknown>, originalValues: Map<string, string>): string {
    return Object.entries(values).reduce((result, [key, value]) => {
      const placeholder = `\${${key}}`;
      if (result.includes(placeholder)) {
        const valueStr = serializeUnknown(value);
        const finalValue = valueStr.trim() ? valueStr : (originalValues.get(key) || "");
        return result.replace(placeholder, finalValue);
      }
      return result;
    }, template);
  }

  static extractPlaceholders(template: string): string[] {
    const dollarPlaceholders = template.match(/\$\{(\w+)\}/g)?.map(p => p.slice(2, -1)) || [];
    const simplePlaceholders = template.match(/\{(\w+)\}/g)?.map(p => p.slice(1, -1)) || [];
    return [...new Set([...dollarPlaceholders, ...simplePlaceholders])];
  }

  static extractValues(template: string, input: string): Map<string, string> {
    const result = new Map<string, string>();

    const placeholderRegex = /\$\{(\w+)\}/g;
    const placeholders: Array<{name: string; start: number; end: number}> = [];
    let match;
    while ((match = placeholderRegex.exec(template)) !== null) {
      placeholders.push({
        name: match[1],
        start: match.index,
        end: match.index + match[0].length
      });
    }

    if (placeholders.length === 0) return result;

    let regexPattern = "^";
    let lastEnd = 0;

    for (const ph of placeholders) {
      const literal = template.substring(lastEnd, ph.start);
      regexPattern += this.escapeRegex(literal);
      regexPattern += "(.+?)";
      lastEnd = ph.end;
    }

    const trailingLiteral = template.substring(lastEnd);
    regexPattern += this.escapeRegex(trailingLiteral);
    regexPattern += "$";

    const regex = new RegExp(regexPattern);
    const inputMatch = input.match(regex);

    if (inputMatch) {
      for (let i = 0; i < placeholders.length; i++) {
        result.set(placeholders[i].name, inputMatch[i + 1]);
      }
    } else if (placeholders.length > 0) {
      result.set(placeholders[0].name, input);
    }

    return result;
  }

  private static escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
