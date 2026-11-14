import { type ParsedCodeBlock, parseCodeBlock } from './settings/CodeBlockParser';

function stripMarkerKeys(settings: Record<string, unknown>): void {
  delete settings.fromTemplate;
  delete settings.defaultTemplate;
}

export function optsOutOfDefaultTemplate(settings: Record<string, unknown>): boolean {
  const value = settings.defaultTemplate;

  return value === false || String(value).trim().toLowerCase() === 'false';
}

function toNames(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(toNames);
  }

  if (typeof value === "string" || typeof value === "number") {
    return String(value).split(",").map(name => stripWikiLink(name)).filter(name => name.length > 0);
  }

  return [];
}

function stripWikiLink(value: string): string {
  const trimmed = value.trim();

  return (trimmed.match(/^\[\[(.+?)\]\]$/u)?.[1] ?? trimmed).trim();
}

export function collectTemplateNames(settings: Record<string, unknown>): string[] {
  return toNames(settings.fromTemplate);
}

export function mergeBlockTemplates(parsedBlock: ParsedCodeBlock, templateBodies: readonly string[]): string[] {
  const blockOwnSettings = { ...parsedBlock.settings };

  stripMarkerKeys(blockOwnSettings);

  const ignoredChainedReferences: string[] = [];
  let cascaded: Record<string, unknown> = {};

  for (const body of templateBodies) {
    const parsed = parseCodeBlock(body);
    const settings = { ...parsed.settings };

    ignoredChainedReferences.push(...collectTemplateNames(settings));
    stripMarkerKeys(settings);
    cascaded = { ...cascaded, ...settings };
  }

  parsedBlock.settings = { ...cascaded, ...blockOwnSettings };

  return ignoredChainedReferences;
}
