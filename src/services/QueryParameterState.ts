import { ParsedCodeBlock } from "./CodeBlockParser";
import { recordSourcePathRename, renamedSourcePathKeys, resolveCurrentSourcePath } from "./SourcePathRenames";
import { buildNoteSignature, resolveSettingsNoteProperties, settingsUseNoteProperties } from "./NoteProperties";
import { hashString36 } from "places-shared/utils";
import type { SharedSelection } from "places-shared/services";
import { QueryParameterDefinition, QueryParameterValue, buildParameterSignature, coerceQueryParameterValue, parseQueryParameterDefinitions, queryUsesParameters, reconcileQueryParameterValues, resolveQueryParameters, resolveSettingsParameters, settingsUseParameters } from "./QueryParameters";

function resolveParameterStateKey(stateKey: string): string {
  for (const oldPath of renamedSourcePathKeys()) {
    if (stateKey === `${oldPath}::note` || stateKey.startsWith(`${oldPath}:`)) {
      return `${resolveCurrentSourcePath(oldPath)}${stateKey.slice(oldPath.length)}`;
    }
  }
  return stateKey;
}

// One session-scoped observable key/value store behind both query-parameter
// values and shared selections. A stateKey groups a set of named values - a
// block's parameters under `<path>:<line>`, a note's parameters under
// `<path>::note`, or a note's selection channels under `<path>::selection` -
// and listeners fire per (stateKey, name). Values are UI state only, never
// written to the note; a plugin reload starts empty.
class ObservableSessionStore {
  private records = new Map<string, Record<string, unknown>>();
  private listeners = new Map<string, Set<(value: unknown) => void>>();

  private listenerKey(stateKey: string, name: string): string {
    return `${stateKey}${name}`;
  }

  private notify(stateKey: string, name: string, value: unknown): void {
    for (const listener of this.listeners.get(this.listenerKey(stateKey, name)) ?? []) listener(value);
  }

  getRecord(stateKey: string): Record<string, unknown> | undefined {
    return this.records.get(stateKey);
  }

  // Replace a whole record without notifying - reconciliation, not a value edit.
  setRecord(stateKey: string, record: Record<string, unknown>): void {
    this.records.set(stateKey, record);
  }

  get(stateKey: string, name: string): unknown {
    return this.records.get(stateKey)?.[name];
  }

  set(stateKey: string, name: string, value: unknown): void {
    const record = this.records.get(stateKey) ?? {};
    record[name] = value;
    this.records.set(stateKey, record);
    this.notify(stateKey, name, value);
  }

  // Remove a named value (notifying undefined); drops the record when it empties.
  delete(stateKey: string, name: string): void {
    const record = this.records.get(stateKey);
    if (record && name in record) {
      delete record[name];
      if (Object.keys(record).length === 0) this.records.delete(stateKey);
    }
    this.notify(stateKey, name, undefined);
  }

  subscribe(stateKey: string, name: string, listener: (value: unknown) => void): () => void {
    const key = this.listenerKey(stateKey, name);
    const listeners = this.listeners.get(key) ?? new Set<(value: unknown) => void>();
    listeners.add(listener);
    this.listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(key);
    };
  }

  // Re-key every record and listener whose stateKey now resolves elsewhere (a note rename).
  migrate(resolveKey: (stateKey: string) => string): void {
    for (const [stateKey, record] of [...this.records]) {
      const resolved = resolveKey(stateKey);
      if (resolved === stateKey) continue;
      this.records.delete(stateKey);
      this.records.set(resolved, { ...record, ...this.records.get(resolved) });
    }
    for (const [listenerKey, listeners] of [...this.listeners]) {
      const separator = listenerKey.indexOf('');
      if (separator < 0) continue;
      const stateKey = listenerKey.slice(0, separator);
      const resolved = resolveKey(stateKey);
      if (resolved === stateKey) continue;
      const migratedKey = `${resolved}${listenerKey.slice(separator)}`;
      const merged = this.listeners.get(migratedKey) ?? new Set<(value: unknown) => void>();
      for (const listener of listeners) merged.add(listener);
      this.listeners.delete(listenerKey);
      this.listeners.set(migratedKey, merged);
    }
  }
}

// The store behind query-parameter values and shared selections.
const sessionStore = new ObservableSessionStore();

// Session-scoped parameter values per code block, keyed by source path and
// section line like MapStateManager's map view state. Note-scoped values
// (declared in `places-parameters` blocks) use NoteParameterRegistry's
// `<sourcePath>::note` key; selections share the same store under
// `<sourcePath>::selection` (see SharedSelectionService). Values are UI state,
// never written to the note; a plugin reload starts from declared defaults.
export class QueryParameterState {
  // The state key grouping a block's parameter values. A `blockSignature` (the
  // block's raw source) keys the values to the block's *content* rather than its
  // line position: editing text above the block - which shifts its lineStart
  // and would otherwise orphan the stored values under a stale `<path>:<line>`
  // key - keeps the same key. Every consumer (render, refresh, control strip)
  // then resolves to one record, and a line shift cannot make a refresh
  // read different values than the live controls. Callers without a signature
  // (viewport-style line keys) fall back to `<path>:<line>`.
  static getStateKey(sourcePath: string | undefined, lineStart: number | undefined, blockSignature?: string): string | null {
    if (!sourcePath) return null;
    const path = resolveCurrentSourcePath(sourcePath);
    if (blockSignature !== undefined) return `${path}:sig:${hashString36(blockSignature)}`;
    if (lineStart === undefined) return null;
    return `${path}:${lineStart}`;
  }

  // Defaults overlaid with any stored values that still fit the definitions.
  static reconcile(stateKey: string | null, definitions: QueryParameterDefinition[]): Record<string, QueryParameterValue> {
    const resolvedKey = stateKey ? resolveParameterStateKey(stateKey) : null;
    const stored = resolvedKey ? sessionStore.getRecord(resolvedKey) as Record<string, QueryParameterValue> | undefined : undefined;
    const values = reconcileQueryParameterValues(definitions, stored);
    if (resolvedKey) {
      sessionStore.setRecord(resolvedKey, values);
    }
    return values;
  }

  static setValue(stateKey: string | null, name: string, value: QueryParameterValue): void {
    if (!stateKey) return;
    sessionStore.set(resolveParameterStateKey(stateKey), name, value);
  }

  static subscribe(stateKey: string | null, name: string, listener: (value: QueryParameterValue | undefined) => void): () => void {
    if (!stateKey) return () => {};
    return sessionStore.subscribe(resolveParameterStateKey(stateKey), name, value => listener(value as QueryParameterValue | undefined));
  }

  // The stored values as-is, without reconciling against definitions.
  static peek(stateKey: string | null): Record<string, QueryParameterValue> | undefined {
    return stateKey ? sessionStore.getRecord(resolveParameterStateKey(stateKey)) as Record<string, QueryParameterValue> | undefined : undefined;
  }

  // A note-scoped value reconciled against its declared definition - the value
  // a consuming query would actually use (coerced, clamped, defaulted). Returns
  // the raw stored value when no `places-parameters` block declares the name.
  static resolveNoteValue(sourcePath: string, name: string): QueryParameterValue | undefined {
    const stored = this.peek(NoteParameterRegistry.noteStateKey(sourcePath))?.[name];
    const definition = NoteParameterRegistry.definitionsFor(sourcePath).find(entry => entry.name === name);
    if (!definition) return stored;
    return coerceQueryParameterValue(definition, stored) ?? definition.defaultValue;
  }

  static migrateSourcePath(oldPath: string, newPath: string): void {
    recordSourcePathRename(oldPath, newPath);
    sessionStore.migrate(resolveParameterStateKey);
  }
}

// Session-scoped typed selection channels shared by Places and extensions.
// Backed by the same ObservableSessionStore as query parameters, under a
// `<sourcePath>::selection` state key with one entry per channel, and both share
// one subscription model and one rename migration.
export class SharedSelectionService {
  private stateKey(sourcePath: string): string {
    return `${resolveCurrentSourcePath(sourcePath)}::selection`;
  }

  get(sourcePath: string, channel?: string): SharedSelection | undefined {
    return sessionStore.get(this.stateKey(sourcePath), channel || 'primary') as SharedSelection | undefined;
  }

  publish(sourcePath: string, selection: SharedSelection | undefined, channel?: string): void {
    const stateKey = this.stateKey(sourcePath);
    const name = channel || 'primary';
    if (selection) sessionStore.set(stateKey, name, selection);
    else sessionStore.delete(stateKey, name);
  }

  subscribe(sourcePath: string, handler: (selection: SharedSelection | undefined) => void, channel?: string): () => void {
    return sessionStore.subscribe(this.stateKey(sourcePath), channel || 'primary', value => handler(value as SharedSelection | undefined));
  }
}

// Session play/pause state per parameter, letting auto-advancing controls resume
// after data blocks re-render their strip on every value change.
export class QueryParameterPlayState {
  private static playing: Set<string> = new Set();

  static isPlaying(stateKey: string | null, name: string): boolean {
    return stateKey !== null && this.playing.has(`${resolveParameterStateKey(stateKey)}${name}`);
  }

  static setPlaying(stateKey: string | null, name: string, playing: boolean): void {
    if (stateKey === null) return;
    const key = `${resolveParameterStateKey(stateKey)}${name}`;
    if (playing) this.playing.add(key);
    else this.playing.delete(key);
  }
}

// Session collapsed/expanded state per control strip. The strip is rebuilt
// whenever cascading options re-resolve or the block re-renders, and the flag
// cannot live in the strip's own closure without popping back open mid-use.
// Absent until the user toggles: the block's declared initial state wins until
// then.
export class QueryParameterStripState {
  private static collapsed = new Map<string, boolean>();

  static isCollapsed(stateKey: string | null, fallback: boolean): boolean {
    if (stateKey === null) return fallback;
    return this.collapsed.get(resolveParameterStateKey(stateKey)) ?? fallback;
  }

  static setCollapsed(stateKey: string | null, collapsed: boolean): void {
    if (stateKey === null) return;
    this.collapsed.set(resolveParameterStateKey(stateKey), collapsed);
  }
}

interface NoteParameterBlock {
  raw: unknown;
  token: object;
}

// Raw `queryParameters:` declarations from `places-parameters` blocks, per
// note. Every parameter-consuming block in the note resolves against these
// note-scoped definitions in addition to its own; block-local declarations
// shadow note-scoped ones by name.
export class NoteParameterRegistry {
  private static blocks: Map<string, Map<number, NoteParameterBlock>> = new Map();

  static noteStateKey(sourcePath: string): string {
    return `${resolveCurrentSourcePath(sourcePath)}::note`;
  }

  // Returns a token identifying this registration; unregister requires it, letting a re-render's fresh registration survive the old element's unload.
  static register(sourcePath: string, lineStart: number, raw: unknown): object {
    sourcePath = resolveCurrentSourcePath(sourcePath);
    const token = {};
    const byLine = this.blocks.get(sourcePath) ?? new Map<number, NoteParameterBlock>();
    byLine.set(lineStart, { raw, token });
    this.blocks.set(sourcePath, byLine);
    return token;
  }

  static unregister(sourcePath: string, lineStart: number, token: object): void {
    sourcePath = resolveCurrentSourcePath(sourcePath);
    const byLine = this.blocks.get(sourcePath);
    if (byLine?.get(lineStart)?.token !== token) return;
    byLine.delete(lineStart);
    if (byLine.size === 0) this.blocks.delete(sourcePath);
  }

  // Parsed note-scoped definitions in block order; a duplicate name keeps the first declaration.
  static definitionsFor(sourcePath: string | undefined): QueryParameterDefinition[] {
    const byLine = sourcePath ? this.blocks.get(resolveCurrentSourcePath(sourcePath)) : undefined;
    if (!byLine) return [];

    const definitions: QueryParameterDefinition[] = [];
    const seen = new Set<string>();
    for (const lineStart of [...byLine.keys()].sort((a, b) => a - b)) {
      for (const definition of parseQueryParameterDefinitions(byLine.get(lineStart)!.raw).definitions) {
        if (seen.has(definition.name)) continue;
        seen.add(definition.name);
        definitions.push(definition);
      }
    }
    return definitions;
  }

  // Names among `names` that an EARLIER `places-parameters` block in the note
  // already declares (a lower lineStart). definitionsFor keeps the first
  // declaration, and these names in the block at `lineStart` are silently
  // ignored - the caller surfaces them to make the collision visible.
  static conflictingNamesFor(sourcePath: string, lineStart: number, names: string[]): string[] {
    const byLine = this.blocks.get(resolveCurrentSourcePath(sourcePath));
    if (!byLine) return [];

    const earlierNames = new Set<string>();
    for (const otherLine of byLine.keys()) {
      if (otherLine >= lineStart) continue;
      for (const definition of parseQueryParameterDefinitions(byLine.get(otherLine)!.raw).definitions) {
        earlierNames.add(definition.name);
      }
    }
    return names.filter(name => earlierNames.has(name));
  }

  static migrateSourcePath(oldPath: string, newPath: string): void {
    const oldBlocks = this.blocks.get(oldPath);
    if (!oldBlocks) return;
    const resolvedNewPath = resolveCurrentSourcePath(newPath);
    const newBlocks = this.blocks.get(resolvedNewPath) ?? new Map<number, NoteParameterBlock>();
    for (const [lineStart, block] of oldBlocks) {
      if (!newBlocks.has(lineStart)) newBlocks.set(lineStart, block);
    }
    this.blocks.delete(oldPath);
    this.blocks.set(resolvedNewPath, newBlocks);
  }
}

// Atomically move parameter definitions and UI values when Obsidian renames a note.
export function migrateQueryParameterSourcePath(oldPath: string, newPath: string): void {
  NoteParameterRegistry.migrateSourcePath(oldPath, newPath);
  QueryParameterState.migrateSourcePath(oldPath, newPath);
}

export interface BlockParameterTransformResult {
  // Signature of the effective parameter values; '' when the block uses none.
  parameterSignature: string;
  // The same errors handed to onErrors. Returned as well so a caller that did not
  // own the transform can still report them (see PlacesRenderPreparer's coalescing).
  parameterErrors?: string[];
}

// Build the block transform used by both the initial render and the refresh
// path: parses `queryParameters:` fresh from the just-parsed block (definition
// edits are honored on refresh), reconciles stored values, and
// substitutes `{parameter.*}` into the block's settings in place - the query
// with SQL escaping, every other setting (overlays, directions, isochrones,
// radius, ...) verbatim. `{this.*}` passes through to VaultQuery untouched.
//
// `readNoteProperties` enables `{note.*}`: the containing note's frontmatter is
// substituted first, and a frontmatter value may itself reference a parameter.
// Query settings are excluded from that pass - see NoteProperties.
//
// With `sourcePath`, note-scoped parameters from `places-parameters` blocks
// join the substitution context (block-local names shadow them); their values
// come from the note store and their controls belong to the declaring block.
//
// `resolveOptions` (resolveOptionsQueries bound to VaultQuery) runs only when
// a block-local optionsQuery-backed enum has no usable default or stored
// value - without it the first render would substitute '' and fail whatever
// consumed the value. Later runs find a stored value and skip the query.
export function createBlockParameterTransform(stateKey: string | null, onErrors?: (errors: string[]) => void, resolveOptions?: (definitions: QueryParameterDefinition[]) => Promise<string[]>, sourcePath?: string, readNoteProperties?: () => Record<string, unknown>): (parsedBlock: ParsedCodeBlock) => Promise<BlockParameterTransformResult> {
  return async (parsedBlock: ParsedCodeBlock): Promise<BlockParameterTransformResult> => {
    const sql = typeof parsedBlock.settings.query === 'string' ? parsedBlock.settings.query : undefined;
    const usesNoteProperties = Boolean(readNoteProperties) && settingsUseNoteProperties(parsedBlock.settings);
    // Note properties resolve before the definitions are parsed: a `{note.*}`
    // in a control's label, default, options or range is part of the definition
    // every consumer sees - the strip renders the substituted label and the
    // reconciled value starts from the substituted default. They also resolve
    // before parameters, and a frontmatter value may itself carry a
    // {parameter.*} reference; the reverse would let a control value expand
    // into a frontmatter read.
    const noteErrors: string[] = [];
    let noteSignature = '';
    if (usesNoteProperties && readNoteProperties) {
      const resolvedNote = await resolveSettingsNoteProperties(parsedBlock.settings, readNoteProperties());
      noteErrors.push(...resolvedNote.errors);
      parsedBlock.settings = resolvedNote.settings;
      noteSignature = buildNoteSignature(resolvedNote.used);
    }

    const { definitions, errors } = parseQueryParameterDefinitions(parsedBlock.settings.queryParameters);
    const localNames = new Set(definitions.map(definition => definition.name));
    const noteDefinitions = NoteParameterRegistry.definitionsFor(sourcePath).filter(definition => !localNames.has(definition.name));
    if (definitions.length === 0 && noteDefinitions.length === 0 && !queryUsesParameters(sql) && !settingsUseParameters(parsedBlock.settings) && !usesNoteProperties) {
      if (errors.length > 0) onErrors?.(errors);
      return { parameterSignature: '', parameterErrors: errors };
    }

    const allErrors = [...errors, ...noteErrors];
    if (resolveOptions) {
      const stored = QueryParameterState.peek(stateKey);
      // Raw stored check, not coercion: optionsQuery-backed parameters accept
      // any string before their options are known, and coercion cannot tell a
      // usable stored value from the absent one. '' is the unusable parse-time
      // default itself.
      const needsOptions = definitions.some(definition => definition.type === 'enum' && definition.optionsQuery && definition.defaultValue === '' && (stored?.[definition.name] === undefined || stored[definition.name] === ''));
      if (needsOptions) {
        allErrors.push(...await resolveOptions(definitions));
      }
    }

    const values = QueryParameterState.reconcile(stateKey, definitions);
    // Note values are read without stamping: the declaring places-parameters
    // block owns that store's lifecycle.
    const noteValues = sourcePath ? reconcileQueryParameterValues(noteDefinitions, QueryParameterState.peek(NoteParameterRegistry.noteStateKey(sourcePath))) : {};
    const combinedDefinitions = [...noteDefinitions, ...definitions];
    const combinedValues = { ...noteValues, ...values };

    const resolvedSettings = await resolveSettingsParameters(parsedBlock.settings, combinedDefinitions, combinedValues);
    allErrors.push(...resolvedSettings.errors);
    parsedBlock.settings = resolvedSettings.settings;

    if (sql) {
      const resolvedSql = await resolveQueryParameters(sql, combinedDefinitions, combinedValues);
      allErrors.push(...resolvedSql.errors);
      parsedBlock.settings.query = resolvedSql.sql;
    }

    if (allErrors.length > 0) onErrors?.(allErrors);
    // The signature feeds the render fingerprint, and a frontmatter edit has to
    // change it or the block would reuse its previous render.
    const parameterSignature = buildParameterSignature(combinedDefinitions, combinedValues);
    return { parameterErrors: allErrors, parameterSignature: noteSignature ? `${parameterSignature}\u0001note:${noteSignature}` : parameterSignature };
  };
}
