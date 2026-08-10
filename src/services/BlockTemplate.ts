import { ParsedCodeBlock, parseCodeBlock } from "./CodeBlockParser";

function stripMarkerKeys(settings: Record<string, unknown>): void {
  delete settings.fromTemplate;
}

function toNames(value: unknown): string[] {
  // `[[Name]]` is a nested flow sequence to YAML: an unquoted wikilink
  // arrives here already unwrapped and nested; a quoted one arrives as a
  // string still carrying its brackets.
  if (Array.isArray(value)) {
    return value.flatMap(toNames);
  }
  if (typeof value === "string" || typeof value === "number") {
    return String(value).split(",").map(name => stripWikiLink(name)).filter(name => name.length > 0);
  }
  return [];
}

// Unwrap `[[Note#Heading]]` to `Note#Heading`; anything else passes through.
function stripWikiLink(value: string): string {
  const trimmed = value.trim();
  return (trimmed.match(/^\[\[(.+?)\]\]$/u)?.[1] ?? trimmed).trim();
}

// Ordered template references a block's `fromTemplate` makes. The key accepts
// one reference, a comma-separated string, or a YAML list, written as a
// wikilink or a bare note name.
export function collectTemplateNames(settings: Record<string, unknown>): string[] {
  return toNames(settings.fromTemplate);
}

// Templates apply in list order - each overrides the ones before it - and the
// block's own keys win over all of them (shallow per-key). Mutates
// `parsedBlock` in place.
//
// An empty list strips the marker key. A `fromTemplate` inside a template
// body is ignored (templates do not chain) and its references are returned for
// the caller to report.
export function mergeBlockTemplates(parsedBlock: ParsedCodeBlock, templateBodies: readonly string[]): string[] {
  const blockOwnSettings = { ...parsedBlock.settings };
  stripMarkerKeys(blockOwnSettings);

  const ignoredChainedReferences: string[] = [];
  let cascaded: Record<string, unknown> = {};
  let cascadedEmbedded: string | undefined;
  for (const body of templateBodies) {
    const parsed = parseCodeBlock(body);
    const settings = { ...parsed.settings };
    ignoredChainedReferences.push(...collectTemplateNames(settings));
    stripMarkerKeys(settings);
    cascaded = { ...cascaded, ...settings };
    if (parsed.embeddedPlaces !== undefined) {
      cascadedEmbedded = parsed.embeddedPlaces;
    }
  }

  // Embedded places: block's own if present, otherwise the last template that
  // defined any.
  parsedBlock.settings = { ...cascaded, ...blockOwnSettings };
  if (parsedBlock.embeddedPlaces === undefined && cascadedEmbedded !== undefined) {
    parsedBlock.embeddedPlaces = cascadedEmbedded;
  }
  return ignoredChainedReferences;
}
