import { BlockSyntaxError, parseCodeBlockYaml } from "places-shared/settings";
export interface ParsedCodeBlock {
  settings: Record<string, unknown>;
  embeddedPlaces?: string;
}

export { BlockSyntaxError } from "places-shared/settings";

// Parse Places code block settings once at the boundary.
//
// Places accepts a small amount of shorthand that is awkward in raw YAML:
// plain multiline SQL queries, bare wikilinks, unquoted template expressions,
// and style rules containing YAML-sensitive tokens such as `!` and `#`.
// Normalize that shorthand into valid YAML, then parse once.
export function parseCodeBlock(source: string, options?: { colonTextKeys?: readonly string[] }): ParsedCodeBlock {
  const { settingsText, embeddedPlaces } = splitEmbeddedPlaces(source);
  const normalizedSettingsText = normalizePlacesYaml(settingsText);

  if (normalizedSettingsText.trim()) {
    return { settings: parseCodeBlockYaml(normalizedSettingsText, { originalSource: source, colonTextKeys: options?.colonTextKeys }), embeddedPlaces };
  }

  return {
    settings: {},
    embeddedPlaces,
  };
}

// Keeps the parsed values' types.
export function mergeCodeBlockSettings<T extends object>(parsed: ParsedCodeBlock, defaultSettings: T): T & Record<string, unknown> {
  return {
    ...defaultSettings,
    ...parsed.settings,
    ...(parsed.embeddedPlaces !== undefined ? { embeddedPlaces: parsed.embeddedPlaces } : {}),
  };
}

// Read a setting whose public syntax is textual, rejecting structured YAML.
export function optionalStringSetting(settings: Record<string, unknown>, key: string): string | undefined {
  const value = settings[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new BlockSyntaxError(`The "${key}" setting must be text.`, undefined, key);
  }
  return value;
}

export function splitEmbeddedPlaces(source: string): { settingsText: string; embeddedPlaces?: string } {
  const normalizedLineEndings = source.replace(/\r\n/g, "\n");
  const normalizedInput = normalizedLineEndings.startsWith("---\n") ? "\n" + normalizedLineEndings : normalizedLineEndings;
  const parts = normalizedInput.split("\n---\n");
  return {
    settingsText: parts[0] ?? "",
    embeddedPlaces: parts.length > 1 ? parts.slice(1).join("\n---\n") : undefined,
  };
}

// Parse the line-oriented records that follow a Places block's `---` separator.
export function parseEmbeddedPlaceProperties(source: string | undefined): Array<Record<string, string>> {
  if (!source?.trim()) return [];
  return source.split(/^---$/m)
    .map(block => block.trim())
    .filter(Boolean)
    .map(block => {
      const properties: Record<string, string> = {};
      for (const line of block.split('\n')) {
        const colonIndex = line.indexOf(':');
        if (colonIndex < 0) continue;
        const key = line.slice(0, colonIndex).trim().toLowerCase();
        const value = line.slice(colonIndex + 1).trim();
        if (key && value) properties[key] = value;
      }
      return properties;
    });
}

function stripCommentOnlyLines(input: string): string {
  return input
    .split("\n")
    .filter(line => !line.trim().startsWith("#"))
    .join("\n");
}

function normalizePlacesYaml(input: string): string {
  return protectYamlListScalars(protectYamlBareScalars(protectYamlWikilinks(protectYamlStyleRuleTags(convertPlainMultilineScalars(insertOptionalKeyColonSpacing(stripCommentOnlyLines(input)))))));
}

function insertOptionalKeyColonSpacing(input: string): string {
  return input
    .split("\n")
    .map(line => line.replace(/^(\s*(?:-\s*)?[A-Za-z]\w*):(?=\S)/, "$1: "))
    .join("\n");
}

function protectYamlWikilinks(input: string): string {
  return input
    .split("\n")
    .map(line => {
      // Both `key: [[Link]]` and `- [[Link]]`. The generic scalar handling
      // further down also quotes wikilinks, but reads whitespace-then-`#` as a
      // trailing comment; quoting a whole-value link here keeps a heading
      // containing ` #` (`[[Note#Part #2]]`) intact.
      const wikilinkValue = line.match(/^(\s*(?:[A-Za-z]\w*:\s*|-\s+))(\[\[[^\]]+\]\])(\s*(?:#.*)?)$/);
      if (!wikilinkValue) {
        return line;
      }

      return `${wikilinkValue[1]}${JSON.stringify(wikilinkValue[2])}${wikilinkValue[3]}`;
    })
    .join("\n");
}

function protectYamlStyleRuleTags(input: string): string {
  const styleRuleKeys = new Set(["iconStyles", "labelStyles"]);
  let currentKey: string | null = null;

  return input
    .split("\n")
    .map(line => {
      const topLevelKey = line.match(/^([A-Za-z]\w*):\s*(?:#.*)?$/);
      if (topLevelKey) {
        currentKey = topLevelKey[1];
        return line;
      }

      if (!currentKey || !styleRuleKeys.has(currentKey)) {
        return line;
      }

      const styleRule = line.match(/^(\s*-\s*)(.*=>.*)$/);
      if (!styleRule) {
        return line;
      }

      return `${styleRule[1]}${JSON.stringify(styleRule[2])}`;
    })
    .join("\n");
}

function protectYamlBareScalars(input: string): string {
  // The optional `- ` prefix covers the first key of a list entry
  // (`- path: {parameter.track}`); continuation lines match without it.
  return input
    .split("\n")
    .map(line => {
      const valueLine = line.match(/^(\s*(?:-\s+)?[A-Za-z]\w*:\s*)(.*)$/);
      if (valueLine && isBareHexColorScalar(valueLine[2])) {
        return `${valueLine[1]}${JSON.stringify(valueLine[2].trim())}`;
      }
      // Brace-led values quote whole: the generic comment stripping below
      // would truncate an expression like {parameter.on ? "#f00" : "#00f"}
      // at the hex color's #.
      if (valueLine && valueLine[2].trimStart().startsWith("{")) {
        return `${valueLine[1]}${JSON.stringify(valueLine[2].trim())}`;
      }

      // A trailing comment starts at whitespace-then-`#`, as in YAML itself. A
      // bare `#` mid-value is value text - `[[Styles#Category]], [[Base]]`
      // must reach the wikilink check whole, not cut at the heading marker.
      const scalar = line.match(/^(\s*(?:-\s+)?[A-Za-z]\w*:\s*)(\S.*?)(\s+#.*|\s*)$/);
      if (!scalar) {
        return line;
      }

      const value = scalar[2].trim();
      if (!needsQuotedYamlScalar(value)) {
        return line;
      }

      return `${scalar[1]}${JSON.stringify(value)}${scalar[3]}`;
    })
    .join("\n");
}

function protectYamlListScalars(input: string): string {
  return input
    .split("\n")
    .map(line => {
      const valueLine = line.match(/^(\s*-\s+)(.*)$/);
      if (valueLine && isBareHexColorScalar(valueLine[2])) {
        return `${valueLine[1]}${JSON.stringify(valueLine[2].trim())}`;
      }
      // Brace-led list items quote whole; see protectYamlBareScalars.
      if (valueLine && valueLine[2].trimStart().startsWith("{")) {
        return `${valueLine[1]}${JSON.stringify(valueLine[2].trim())}`;
      }

      // Whitespace-then-`#` starts a comment; see protectYamlBareScalars.
      const listScalar = line.match(/^(\s*-\s+)(\S.*?)(\s+#.*|\s*)$/);
      if (!listScalar) {
        return line;
      }

      const value = listScalar[2].trim();
      if (!needsQuotedYamlScalar(value)) {
        return line;
      }

      return `${listScalar[1]}${JSON.stringify(value)}${listScalar[3]}`;
    })
    .join("\n");
}

function needsQuotedYamlScalar(value: string): boolean {
  if (!value) return false;
  if (/^["']/.test(value)) return false;
  if (/^[>|]/.test(value)) return false;
  // A leading YAML indicator (tag `!`, anchor `&`, alias `*`, reserved `@`/`` ` ``)
  // is not scalar text - a negated condition like `!tag:foo` or `!Favorite` in a
  // `visible:` value would otherwise fail as an unresolved YAML tag.
  if (/^[!&*@`]/.test(value)) return true;
  // A wikilink needs quoting (`[[A]], [[B]]` is not valid YAML), but `[[` also
  // opens a NESTED FLOW SEQUENCE - a GeoJSON ring in a `within` filter reads
  // `[[-75.77, 41.25], [-75.53, 41.25], ...]`. Quoting on the prefix alone
  // turned such a ring into a string. A wikilink target cannot contain
  // brackets: one bracket-free `[[...]]` is required to call it a link, and it
  // is looked for outside quotes only. A flow sequence whose entries are already
  // quoted links (`["[[A]]", "[[B]]"]`, how a stops list declares its default)
  // is valid YAML, and quoting it whole delivered the list as one string.
  if (/\[\[[^[\]]+\]\]/.test(withoutQuotedSpans(value))) return true;
  return value.startsWith("{") || /^#[0-9a-fA-F]{3,8}\b/.test(value);
}

// The value with quoted spans blanked out: a scan sees only text YAML itself would read as syntax.
function withoutQuotedSpans(value: string): string {
  return value.replace(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'/g, '');
}

function isBareHexColorScalar(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /^["']/.test(trimmed)) return false;
  return /^#[0-9a-fA-F]{3,8}\b/.test(trimmed) || /,\s*#[0-9a-fA-F]{3,8}\b/.test(trimmed);
}

function convertPlainMultilineScalars(input: string): string {
  const lines = input.replace(/\r\n/g, "\n").split("\n").map(line => line.trim() ? line.replace(/[ \t]+$/g, "") : "");
  const output: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const scalarStart = line.match(/^([A-Za-z]\w*):[ \t]+(.+)$/);
    if (!scalarStart || /^[>|]/.test(scalarStart[2].trim())) {
      output.push(line);
      index++;
      continue;
    }

    const continuationLines: string[] = [];
    let nextIndex = index + 1;
    while (nextIndex < lines.length) {
      const nextLine = lines[nextIndex];
      const trimmed = nextLine.trim();

      if (!trimmed) {
        nextIndex++;
        continue;
      }

      if (trimmed.startsWith("#")) {
        nextIndex++;
        continue;
      }

      if (/^[A-Za-z]\w*\s*:/.test(nextLine)) {
        break;
      }

      if (!/^\s+\S/.test(nextLine)) {
        break;
      }

      continuationLines.push(nextLine.trim());
      nextIndex++;
    }

    if (continuationLines.some(Boolean)) {
      output.push(`${scalarStart[1]}: |`);
      output.push(`  ${scalarStart[2]}`);
      for (const continuationLine of continuationLines) {
        output.push(continuationLine ? `  ${continuationLine}` : "");
      }
      index = nextIndex;
      continue;
    }

    output.push(line);
    index++;
  }

  return output.join("\n");
}
