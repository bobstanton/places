import { ParsedCodeBlock } from 'places/core';
import { recordSourcePathRename, renamedSourcePathKeys, resolveCurrentSourcePath, sourcePathStatePrefix } from "./SourcePathRenames";
import { buildNoteSignature, resolveSettingsNoteProperties, settingsUseNoteProperties } from "./NoteProperties";
import { hashString36 } from "places-shared/utils";
import type { SharedSelection } from "places-shared/obsidian/services";
import { QueryParameterDefinition, QueryParameterValue, buildParameterSignature, buildQueryParameterMapMarkers, coerceQueryParameterValue, parseQueryParameterDefinitions, queryUsesParameters, reconcileQueryParameterValues, resolveQueryParameters, resolveSettingsParameters, settingsUseParameters, type QueryParameterMapMarker } from "places/core";

const renamedStateKeys = new Map<string, string>();

function resolveParameterStateKey(stateKey: string): string {
  const renamed = renamedStateKeys.get(stateKey);

  if (renamed) return renamed;

  for (const oldPath of renamedSourcePathKeys()) {
    if (stateKey === `${oldPath}::note` || stateKey.startsWith(`${oldPath}:`)) {
      return `${resolveCurrentSourcePath(oldPath)}${stateKey.slice(oldPath.length)}`;
    }
  }

  return stateKey;
}

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
      const currentKey = this.listenerKey(resolveParameterStateKey(stateKey), name);
      const currentListeners = this.listeners.get(currentKey);

      currentListeners?.delete(listener);
      if (currentListeners?.size === 0) this.listeners.delete(currentKey);
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
const uiStore = new ObservableSessionStore();

export class QueryParameterState {
  static getStateKey(sourcePath: string | undefined, lineStart: number | undefined, blockSignature?: string): string | null {
    if (!sourcePath) return null;
    const path = sourcePathStatePrefix(sourcePath);

    if (blockSignature !== undefined) return `${path}:sig:${hashString36(blockSignature)}`;
    if (lineStart === undefined) return null;

    return `${path}:${lineStart}`;
  }

  static reconcile(stateKey: string | null, definitions: QueryParameterDefinition[]): Record<string, QueryParameterValue> {
    const resolvedKey = stateKey ? resolveParameterStateKey(stateKey) : null;
    const stored = resolvedKey ? sessionStore.getRecord(resolvedKey) as Record<string, QueryParameterValue> | undefined : undefined;
    const values = reconcileQueryParameterValues(definitions, stored);

    if (resolvedKey) {
      sessionStore.setRecord(resolvedKey, resolvedKey.endsWith('::note') ? { ...stored, ...values } : values);
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
    if (oldPath === newPath) return;
    const oldPrefix = sourcePathStatePrefix(oldPath);

    recordSourcePathRename(oldPath, newPath);
    const newPrefix = sourcePathStatePrefix(newPath);
    const moveKey = (key: string): string => key.startsWith(`${oldPrefix}:`) ? `${newPrefix}${key.slice(oldPrefix.length)}` : key;

    for (const [key, target] of renamedStateKeys) {
      const moved = moveKey(target);

      if (key === moved) renamedStateKeys.delete(key);
      else renamedStateKeys.set(key, moved);
    }

    const migrateKey = (key: string): string => {
      const moved = moveKey(key);

      if (moved !== key) {
        renamedStateKeys.delete(moved);
        renamedStateKeys.set(key, moved);
      }

      return moved;
    };

    sessionStore.migrate(migrateKey);
    uiStore.migrate(migrateKey);
  }
}

export class SharedSelectionService {
  private stateKey(sourcePath: string): string {
    return `${sourcePathStatePrefix(sourcePath)}::selection`;
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

export class QueryParameterPlayState {
  static isPlaying(stateKey: string | null, name: string): boolean {
    return stateKey !== null && uiStore.get(resolveParameterStateKey(stateKey), `playing:${name}`) === true;
  }

  static setPlaying(stateKey: string | null, name: string, playing: boolean): void {
    if (stateKey === null) return;
    const key = resolveParameterStateKey(stateKey);

    if (playing) uiStore.set(key, `playing:${name}`, true);
    else uiStore.delete(key, `playing:${name}`);
  }
}

export class QueryParameterStripState {
  static isCollapsed(stateKey: string | null, fallback: boolean): boolean {
    if (stateKey === null) return fallback;

    return (uiStore.get(resolveParameterStateKey(stateKey), 'collapsed') as boolean | undefined) ?? fallback;
  }

  static setCollapsed(stateKey: string | null, collapsed: boolean): void {
    if (stateKey === null) return;
    uiStore.set(resolveParameterStateKey(stateKey), 'collapsed', collapsed);
  }
}

interface NoteParameterBlock {
  raw: unknown;
  token: object;
}

export class NoteParameterRegistry {
  private static blocks: Map<string, Map<number, NoteParameterBlock>> = new Map();

  static noteStateKey(sourcePath: string): string {
    return `${sourcePathStatePrefix(sourcePath)}::note`;
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

export function migrateQueryParameterSourcePath(oldPath: string, newPath: string): void {
  QueryParameterState.migrateSourcePath(oldPath, newPath);
  NoteParameterRegistry.migrateSourcePath(oldPath, newPath);
}

export interface BlockParameterTransformResult {
  parameterSignature: string;
  parameterErrors?: string[];
  parameterMarkers?: QueryParameterMapMarker[];
}

export function createBlockParameterTransform(stateKey: string | null, onErrors?: (errors: string[]) => void, resolveOptions?: (definitions: QueryParameterDefinition[]) => Promise<string[]>, sourcePath?: string, readNoteProperties?: () => Record<string, unknown>): (parsedBlock: ParsedCodeBlock) => Promise<BlockParameterTransformResult> {
  return async (parsedBlock: ParsedCodeBlock): Promise<BlockParameterTransformResult> => {
    const sql = typeof parsedBlock.settings.query === 'string' ? parsedBlock.settings.query : undefined;
    const usesNoteProperties = Boolean(readNoteProperties) && settingsUseNoteProperties(parsedBlock.settings);
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
      const needsOptions = definitions.some(definition => definition.optionsQuery && (
        (definition.type === 'enum' && definition.defaultValue === '' && (stored?.[definition.name] === undefined || stored[definition.name] === ''))
        || ((definition.derivedAllDefault || definition.derivedDefault) && stored?.[definition.name] === undefined)
      ));

      if (needsOptions) {
        allErrors.push(...await resolveOptions(definitions));
      }
    }

    const values = QueryParameterState.reconcile(stateKey, definitions);
    const noteValues = sourcePath ? reconcileQueryParameterValues(noteDefinitions, QueryParameterState.peek(NoteParameterRegistry.noteStateKey(sourcePath))) : {};
    const combinedDefinitions = [...noteDefinitions, ...definitions];
    const combinedValues = { ...noteValues, ...values };
    const parameterMarkers = buildQueryParameterMapMarkers(combinedDefinitions, combinedValues);

    const resolvedSettings = await resolveSettingsParameters(parsedBlock.settings, combinedDefinitions, combinedValues);

    allErrors.push(...resolvedSettings.errors);
    parsedBlock.settings = resolvedSettings.settings;

    if (sql) {
      const resolvedSql = await resolveQueryParameters(sql, combinedDefinitions, combinedValues);

      allErrors.push(...resolvedSql.errors);
      parsedBlock.settings.query = resolvedSql.sql;
    }

    if (allErrors.length > 0) onErrors?.(allErrors);
    const parameterSignature = buildParameterSignature(combinedDefinitions, combinedValues);

    return {
      parameterErrors: allErrors,
      parameterMarkers,
      parameterSignature: noteSignature ? `${parameterSignature}\u0001note:${noteSignature}` : parameterSignature,
    };
  };
}
