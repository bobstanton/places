import { BlockSyntaxError, parseCodeBlockYaml } from "places-shared/settings";
export interface ParsedCodeBlock {
  settings: Record<string, unknown>;
}

export { BlockSyntaxError } from "places-shared/settings";

export function parseCodeBlock(source: string, options?: { colonTextKeys?: readonly string[] }): ParsedCodeBlock {
  return { settings: parseCodeBlockYaml(source, options) };
}

export function mergeCodeBlockSettings<T extends object>(parsed: ParsedCodeBlock, defaultSettings: T): T & Record<string, unknown> {
  return {
    ...defaultSettings,
    ...parsed.settings,
  };
}

export function optionalStringSetting(settings: Record<string, unknown>, key: string): string | undefined {
  const value = settings[key];

  if (value === undefined || value === null) return undefined;

  if (typeof value !== "string") {
    throw new BlockSyntaxError(`The "${key}" setting must be text.`, undefined, key);
  }

  return value;
}
