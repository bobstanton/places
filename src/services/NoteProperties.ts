import { App, normalizePath } from 'obsidian';
import { PlaceholderResolver, SimpleContextProvider } from 'placeholder-resolver';
import { serializeUnknown } from "places-shared/utils";

// `{note.*}` - the containing note's frontmatter, substituted into a block's
// settings.
//
// One property can then drive several blocks in the same note: a trip note's
// `Location` and `StartDate` feeding a map, a weather block and a tide block
// without retyping them into each.
//
// Deliberately a separate prefix from `{this.*}`, which is already taken twice
// over: VaultQuery resolves it against the current note inside SQL, and Places
// resolves it against the *place*, feature, route or waypoint inside the label
// templates (`labelTemplate`, `waypointLabelTemplate`, `legLabelTemplate`, the
// track label positions). A `this`-prefixed pass over all settings would
// consume those templates before their own resolvers ever saw them.
//
// Query languages are left alone: `query`, `optionsQuery`, `dataview` and the
// nested `routes[].query` keep their own `{this.*}` handling, and raw
// frontmatter text has no business being spliced into SQL unescaped.
//
// `queryParameters` declarations ARE substituted into, unlike the
// `{parameter.*}` pass which must skip them to avoid reading itself. A note
// property can therefore supply a control's `label`, `default`, or `options`.

const NOTE_PREFIX = 'note';
// Keys whose value is a query. Matched by key name at any depth: the
// top-level `query`/`dataview` and `directions[].routes[].query` are all
// covered by one rule.
const QUERY_KEYS = new Set(['query', 'optionsQuery', 'dataview']);

export interface ResolvedNoteProperties {
  settings: Record<string, unknown>;
  errors: string[];
  // Properties actually referenced, for a change in one to re-render the block.
  used: Record<string, string>;
}

export function containsNotePlaceholder(value: string): boolean {
  return value.includes('{note.') || value.includes('{note[');
}

// True when any setting references `{note.*}`; drives whether resolution runs at all.
export function settingsUseNoteProperties(settings: Record<string, unknown>): boolean {
  const scan = (value: unknown, key: string | undefined): boolean => {
    if (key !== undefined && QUERY_KEYS.has(key)) return false;
    if (typeof value === 'string') return containsNotePlaceholder(value);
    if (Array.isArray(value)) return value.some(item => scan(item, key));

    if (value && typeof value === 'object') {
      return Object.entries(value as Record<string, unknown>).some(([childKey, child]) => scan(child, childKey));
    }

    return false;
  };

  return scan(settings, undefined);
}

// The note's frontmatter, or an empty record when it has none.
export function readNoteProperties(app: App, sourcePath: string | undefined): Record<string, unknown> {
  if (!sourcePath) return {};

  try {
    const file = app.vault.getFileByPath(normalizePath(sourcePath));

    if (!file) return {};

    return app.metadataCache.getFileCache(file)?.frontmatter ?? {};
  } catch {
    return {};
  }
}

// YAML gives an unquoted `StartDate: 2027-01-01` as a Date. Rendering it with
// String() would produce "Wed Jan 01 2027 ..." - useless to every date setting
// that consumes it - and dates format back to what the user wrote.
function formatNoteValue(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const pad = (part: number) => String(part).padStart(2, '0');
    const date = `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
    const hasTime = value.getHours() || value.getMinutes() || value.getSeconds();

    return hasTime ? `${date}T${pad(value.getHours())}:${pad(value.getMinutes())}` : date;
  }

  if (Array.isArray(value)) return value.map(item => formatNoteValue(item)).join(', ');

  // A nested YAML map serializes as JSON rather than the "[object Object]" a
  // bare String() would produce - unhelpful in a substituted setting either way,
  // but the JSON at least shows which property was misused.
  return serializeUnknown(value);
}

// Every `{note...}` placeholder in a setting value, whatever form it takes.
const NOTE_PLACEHOLDER_PATTERN = new RegExp(`\\{${NOTE_PREFIX}[.[][^{}]*\\}`, 'g');

// Whether a setting value reads this property, for the used map behind the
// render signature. The plain `{note.Name}` form is not the only one the
// resolver accepts - the bracket form (`{note["Trip Name"]}`, the only way to
// name a property containing a space) and expressions (`{note.Days * 2}`)
// resolve too, and matching the dotted form alone would leave a block that
// uses them blind to a change in the property it consumed.
function referencesProperty(value: string, name: string): boolean {
  const references = value.match(NOTE_PLACEHOLDER_PATTERN);

  if (!references) return false;
  const nameInPlaceholder = new RegExp(`(^|[^\\w])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w])`);

  return references.some(reference => nameInPlaceholder.test(reference));
}

// Substitute `{note.*}` across a block's settings in place of a copy.
// Unresolved references are left verbatim and reported, matching how an
// undeclared `{parameter.*}` is handled.
export async function resolveSettingsNoteProperties(settings: Record<string, unknown>, properties: Record<string, unknown>): Promise<ResolvedNoteProperties> {
  const context: Record<string, unknown> = {};

  for (const [name, value] of Object.entries(properties)) {
    context[name] = formatNoteValue(value);
  }

  const resolver = new PlaceholderResolver(new SimpleContextProvider(context), {
    prefix: NOTE_PREFIX,
    formatArray: items => items.map(item => formatNoteValue(item)).join(', '),
  });

  const errors: string[] = [];
  const used: Record<string, string> = {};

  const resolveValue = async (value: unknown, path: string): Promise<unknown> => {
    if (typeof value === 'string') {
      if (!containsNotePlaceholder(value)) return value;
      const result = await resolver.resolveWithDetails(value);

      for (const diagnostic of result.diagnostics) {
        errors.push(diagnostic.kind === 'unresolved-placeholder'
          ? `The ${path} setting references ${diagnostic.placeholder} but this note has no such property.`
          : `Failed to resolve ${diagnostic.placeholder} in ${path}: ${diagnostic.message ?? 'unknown error'}`);
      }

      for (const name of Object.keys(context)) {
        if (referencesProperty(value, name)) used[name] = String(context[name]);
      }

      return result.result;
    }

    if (Array.isArray(value)) {
      const items: unknown[] = [];

      for (const item of value) items.push(await resolveValue(item, path));

      return items;
    }

    if (value && typeof value === 'object') {
      const resolvedEntries: Record<string, unknown> = {};

      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        resolvedEntries[key] = QUERY_KEYS.has(key) ? child : await resolveValue(child, key);
      }

      return resolvedEntries;
    }

    return value;
  };

  const resolved: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(settings)) {
    resolved[key] = QUERY_KEYS.has(key) ? value : await resolveValue(value, key);
  }

  return { settings: resolved, errors, used };
}

// Signature of the note values a block consumed, for render fingerprinting.
export function buildNoteSignature(used: Record<string, string>): string {
  const names = Object.keys(used).sort();

  return names.length === 0 ? '' : names.map(name => `${name}=${used[name]}`).join('');
}
