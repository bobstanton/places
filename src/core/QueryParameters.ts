import { PlaceholderResolver } from 'placeholder-resolver/dist/PlaceholderResolver.js';
import { SimpleContextProvider } from 'placeholder-resolver/dist/SimpleContextProvider.js';
import { formatSqlSequence } from 'placeholder-resolver/dist/helpers.js';
import { getErrorMessage, scalarToString } from 'places-shared/utils';
import { parseNamedCoordinate } from 'places-shared/geo';

export type QueryParameterType = 'int' | 'float' | 'string' | 'date' | 'datetime' | 'time' | 'boolean' | 'enum' | 'list' | 'location';
export type QueryParameterControl = 'slider' | 'range' | 'number' | 'text' | 'combobox' | 'dropdown' | 'segmented' | 'toggle' | 'date' | 'datetime' | 'time' | 'multiselect' | 'location' | 'stops' | 'custom';
export type QueryParameterScale = 'linear' | 'log';

export interface QueryParameterRange {
  min: number;
  max: number;
}

export type QueryParameterValue = number | string | boolean | string[] | QueryParameterRange;

export interface QueryParameterDefinition {
  name: string;
  type: QueryParameterType;
  control: QueryParameterControl;
  label: string;
  defaultValue: QueryParameterValue;
  min?: number;
  max?: number;
  step?: number;
  scale?: QueryParameterScale;
  showValue?: boolean;
  width?: string;
  options?: string[];
  optionRows?: Array<Record<string, unknown>>;
  optionsQuery?: string;
  play?: number;
  derivedDefault?: boolean;
  derivedAllDefault?: boolean;
  render?: string;
  mount?: string;
  showOnMap?: boolean;
  icon?: string;
  icons?: string[];
}

export interface QueryParameterMapMarker {
  parameterName: string;
  label: string;
  token: string;
  icon: string;
  index: number;
}

export interface ParsedQueryParameters {
  definitions: QueryParameterDefinition[];
  errors: string[];
}

const PARAMETER_NAME_PATTERN = /^[A-Za-z_]\w*$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
const TIME_PATTERN = /^\d{2}:\d{2}(:\d{2})?$/;

function containsParameterPlaceholder(value: string): boolean {
  return value.includes('{parameter.') || value.includes('{parameter[');
}

const VALID_TYPES = new Set<QueryParameterType>(['int', 'float', 'string', 'date', 'datetime', 'time', 'boolean', 'enum', 'list', 'location']);
const VALID_CONTROLS = new Set<QueryParameterControl>(['slider', 'range', 'number', 'text', 'combobox', 'dropdown', 'segmented', 'toggle', 'date', 'datetime', 'time', 'multiselect', 'location', 'stops', 'custom']);
const NUMERIC_TYPES = new Set<QueryParameterType>(['int', 'float']);
const PLAYABLE_CONTROLS = new Set<QueryParameterControl>(['slider', 'dropdown', 'segmented', 'custom']);
const DEFAULT_PLAY_INTERVAL_MS = 1000;
const MIN_PLAY_INTERVAL_MS = 100;
const PARAMETER_HELPERS_NAMESPACE = '__placesParameterHelpers';

export function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

export function queryUsesParameters(sql: string | undefined): boolean {
  return Boolean(sql && containsParameterPlaceholder(sql));
}

export function isQueryParameterRange(value: unknown): value is QueryParameterRange {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as QueryParameterRange).min === 'number'
    && typeof (value as QueryParameterRange).max === 'number';
}

export function parseQueryParameterDefinitions(raw: unknown): ParsedQueryParameters {
  const errors: string[] = [];
  const definitions: QueryParameterDefinition[] = [];

  if (raw === undefined || raw === null) {
    return { definitions, errors };
  }

  const entries = Array.isArray(raw) ? raw : [raw];
  const seenNames = new Set<string>();

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push('Each queryParameters entry must be a mapping with at least a name.');
      continue;
    }

    const record = entry as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name.trim() : '';

    if (!PARAMETER_NAME_PATTERN.test(name)) {
      errors.push(`Invalid parameter name "${scalarToString(record.name)}". Use letters, digits and underscores, starting with a letter.`);
      continue;
    }

    if (seenNames.has(name)) {
      errors.push(`Duplicate parameter name "${name}".`);
      continue;
    }

    const type = normalizeType(record.type);

    if (!type) {
      errors.push(`Parameter "${name}": unknown type "${scalarToString(record.type)}". Supported: ${[...VALID_TYPES].join(', ')}.`);
      continue;
    }

    const { min, max } = parseRange(record);
    const step = toFiniteNumber(record.step);
    const scale = parseScale(record.scale);

    if (record.scale !== undefined && scale === undefined) {
      errors.push(`Parameter "${name}": scale must be linear or log.`);
      continue;
    }

    const showValue = parseOptionalBoolean(record.showValue);

    if (record.showValue !== undefined && showValue === undefined) {
      errors.push(`Parameter "${name}": showValue must be true or false.`);
      continue;
    }

    const width = parseCssLength(record.width);

    if (record.width !== undefined && width === undefined) {
      errors.push(`Parameter "${name}": width must be a positive CSS length such as 240px, 18rem, 30ch or 100%.`);
    }

    const options = parseOptions(record.options);
    const optionsQuery = typeof record.optionsQuery === 'string' && record.optionsQuery.trim() ? record.optionsQuery.trim() : undefined;
    const markerIcon = parseOptionalText(record.icon);
    const markerIcons = parseOptions(record.icons);
    const parsedShowOnMap = parseOptionalBoolean(record.showOnMap);

    if (record.showOnMap !== undefined && parsedShowOnMap === undefined) {
      errors.push(`Parameter "${name}": showOnMap must be true or false.`);
      continue;
    }

    if (record.icon !== undefined && markerIcon === undefined) {
      errors.push(`Parameter "${name}": icon must be non-empty text.`);
      continue;
    }

    const render = parseScriptField(record.render);
    const mount = parseScriptField(record.mount);

    const control = render && (record.control === undefined || record.control === null || record.control === '')
      ? 'custom'
      : normalizeControl(record.control, type, min, max, Boolean(options || optionsQuery));

    if (!control) {
      errors.push(`Parameter "${name}": unknown control "${scalarToString(record.control)}". Supported: ${[...VALID_CONTROLS].join(', ')}.`);
      continue;
    }

    if ((type === 'enum' || (type === 'list' && control !== 'stops')) && (!options || options.length === 0) && !optionsQuery) {
      errors.push(`Parameter "${name}": ${type} parameters need an options list or an optionsQuery.`);
      continue;
    }

    const controlError = validateControlForType(name, control, type, min, max, Boolean(optionsQuery));

    if (controlError) {
      errors.push(controlError);
      continue;
    }

    if (scale && control !== 'range') {
      errors.push(`Parameter "${name}": scale needs control: range.`);
      continue;
    }

    if (showValue !== undefined && control !== 'range') {
      errors.push(`Parameter "${name}": showValue needs control: range.`);
      continue;
    }

    if (control === 'range' && optionsQuery && (min !== undefined || max !== undefined)) {
      errors.push(`Parameter "${name}": a range with an optionsQuery takes its min and max from the query; drop the declared ones.`);
      continue;
    }

    const showOnMap = parsedShowOnMap ?? Boolean(markerIcon || markerIcons?.length);

    if (showOnMap && type !== 'location' && control !== 'stops') {
      errors.push(`Parameter "${name}": showOnMap is supported for location parameters and list parameters using control: stops.`);
      continue;
    }

    if (control === 'custom' && !render) {
      errors.push(`Parameter "${name}": control: custom needs a render script returning the control's HTML.`);
      continue;
    }

    if (control !== 'custom' && (render || mount)) {
      errors.push(`Parameter "${name}": render and mount need control: custom.`);
      continue;
    }

    if (control === 'custom' && mount && !render) {
      errors.push(`Parameter "${name}": mount needs a render script to wire.`);
      continue;
    }

    let play: number | undefined;

    if (record.play !== undefined && record.play !== false) {
      const interval = record.play === true ? DEFAULT_PLAY_INTERVAL_MS : toFiniteNumber(record.play);

      if (interval === undefined || interval < MIN_PLAY_INTERVAL_MS) {
        errors.push(`Parameter "${name}": play must be true or an interval in milliseconds (${MIN_PLAY_INTERVAL_MS} or more).`);
        continue;
      }

      if (!PLAYABLE_CONTROLS.has(control)) {
        errors.push(`Parameter "${name}": play requires a slider, dropdown, segmented, or custom control.`);
        continue;
      }

      play = interval;
    }

    const definition: QueryParameterDefinition = {
      name,
      type,
      control,
      label: typeof record.label === 'string' && record.label.trim() ? record.label.trim() : name,
      defaultValue: false,
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
      ...(step !== undefined ? { step } : {}),
      ...(scale ? { scale } : {}),
      ...(showValue === false ? { showValue: false } : {}),
      ...(width !== undefined ? { width } : {}),
      ...(options ? { options } : {}),
      ...(optionsQuery ? { optionsQuery } : {}),
      ...(play !== undefined ? { play } : {}),
      ...(render ? { render } : {}),
      ...(mount ? { mount } : {}),
      ...(showOnMap ? { showOnMap: true } : {}),
      ...(markerIcon ? { icon: markerIcon } : {}),
      ...(markerIcons ? { icons: markerIcons } : {}),
    };

    if (definition.type === 'list' && typeof record.default === 'string' && record.default.trim().toLowerCase() === 'all') {
      definition.defaultValue = [...(definition.options ?? [])];
      definition.derivedAllDefault = true;
    } else {
      definition.defaultValue = resolveDefaultValue(definition, record.default);

      if (control === 'range' && optionsQuery && record.default === undefined) {
        definition.derivedDefault = true;
      }
    }

    definitions.push(definition);
    seenNames.add(name);
  }

  return { definitions, errors };
}

export function buildQueryParameterMapMarkers(definitions: readonly QueryParameterDefinition[], values: Record<string, QueryParameterValue>): QueryParameterMapMarker[] {
  const markers: QueryParameterMapMarker[] = [];

  for (const definition of definitions) {
    if (!definition.showOnMap) continue;
    const value = values[definition.name] ?? definition.defaultValue;
    const tokens = Array.isArray(value)
      ? value.map(entry => scalarToString(entry).trim()).filter(Boolean)
      : [scalarToString(value).trim()].filter(Boolean);

    tokens.forEach((token, index) => {
      markers.push({
        parameterName: definition.name,
        label: definition.label,
        token,
        icon: definition.icons?.[index] ?? definition.icon ?? '',
        index,
      });
    });
  }

  return markers;
}

export function coerceQueryParameterValue(definition: QueryParameterDefinition, raw: unknown): QueryParameterValue | undefined {
  if (definition.control === 'range') {
    return coerceRangeValue(definition, raw);
  }

  switch (definition.type) {
    case 'int':
    case 'float': {
      const value = toFiniteNumber(raw);

      if (value === undefined) return undefined;
      const clamped = clamp(value, definition.min, definition.max);

      return definition.type === 'int' ? Math.round(clamped) : clamped;
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true' || raw === 1) return true;
      if (raw === 'false' || raw === 0) return false;

      return undefined;
    }
    case 'date': {
      if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
        return raw.toISOString().slice(0, 10);
      }

      const value = typeof raw === 'string' ? raw.trim() : '';

      return ISO_DATE_PATTERN.test(value) ? value : undefined;
    }
    case 'datetime': {
      if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
        return toLocalDateTimeString(raw);
      }

      const value = typeof raw === 'string' ? raw.trim() : '';

      if (ISO_DATETIME_PATTERN.test(value)) return value;

      return ISO_DATE_PATTERN.test(value) ? `${value}T00:00` : undefined;
    }
    case 'time': {
      const value = typeof raw === 'string' ? raw.trim() : '';

      return TIME_PATTERN.test(value) ? value : undefined;
    }
    case 'enum': {
      const value = scalarToString(raw);

      return isAllowedOption(definition, value) ? value : undefined;
    }
    case 'list': {
      if (!Array.isArray(raw)) return undefined;

      if (definition.control === 'stops') {
        return raw.map(item => scalarToString(item).trim()).filter(Boolean);
      }

      return raw.map(item => scalarToString(item)).filter(item => isAllowedOption(definition, item));
    }
    case 'string':
      return raw === undefined || raw === null ? undefined : scalarToString(raw);
    case 'location': {
      const value = typeof raw === 'string' ? raw.trim() : '';

      if (value === '') return undefined;
      const coordinate = parseNamedCoordinate(value);

      if (!coordinate) return undefined;
      const formatted = `${coordinate.latitude}, ${coordinate.longitude}`;

      return coordinate.name ? `${coordinate.name}: ${formatted}` : formatted;
    }
  }
}

function isAllowedOption(definition: QueryParameterDefinition, value: string): boolean {
  if (definition.optionsQuery && (!definition.options || definition.options.length === 0)) {
    return true;
  }

  return definition.options?.includes(value) ?? false;
}

function coerceRangeValue(definition: QueryParameterDefinition, raw: unknown): QueryParameterRange | undefined {
  let low: number | undefined;
  let high: number | undefined;

  if (isQueryParameterRange(raw)) {
    low = raw.min;
    high = raw.max;
  } else if (Array.isArray(raw) && raw.length >= 2) {
    low = toFiniteNumber(raw[0]);
    high = toFiniteNumber(raw[1]);
  } else if (typeof raw === 'string' && raw.includes(',')) {
    const parts = raw.split(',');

    low = toFiniteNumber(parts[0]);
    high = toFiniteNumber(parts[1]);
  }

  if (low === undefined || high === undefined) return undefined;
  if (low > high) [low, high] = [high, low];

  const round = definition.type === 'int' ? Math.round : (value: number) => value;

  return {
    min: round(clamp(low, definition.min, definition.max)),
    max: round(clamp(high, definition.min, definition.max)),
  };
}

export async function resolveQueryParameters(sql: string, definitions: QueryParameterDefinition[], values: Record<string, QueryParameterValue>): Promise<{ sql: string; errors: string[] }> {
  const resolver = new PlaceholderResolver(new SimpleContextProvider(buildParameterContext(definitions, values, 'sql')), {
    prefix: 'parameter',
    helpersName: PARAMETER_HELPERS_NAMESPACE,
    escapeValue: escapeSqlLiteral,
    formatArray: formatSqlSequence,
  });

  const result = await resolver.resolveWithDetails(sql);
  const errors = result.diagnostics.map(diagnostic =>
    diagnostic.kind === 'unresolved-placeholder'
      ? `Query references ${diagnostic.placeholder} but no such parameter is declared under queryParameters.`
      : `Failed to resolve ${diagnostic.placeholder}: ${diagnostic.message ?? 'unknown error'}`
  );

  return { sql: result.result, errors };
}

export async function resolveSettingsParameters(settings: Record<string, unknown>, definitions: QueryParameterDefinition[], values: Record<string, QueryParameterValue>): Promise<{ settings: Record<string, unknown>; errors: string[] }> {
  const context = buildParameterContext(definitions, values, 'verbatim');
  const resolver = new PlaceholderResolver(new SimpleContextProvider(context), {
    prefix: 'parameter',
    helpersName: PARAMETER_HELPERS_NAMESPACE,
    formatArray: items => items.map(item => scalarToString(item)).join(', '),
  });

  const errors: string[] = [];
  const resolved: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(settings)) {
    resolved[key] = key === 'query' || key === 'queryParameters' ? value : await resolveSettingValue(value, key, resolver, context, errors);
  }

  return { settings: resolved, errors };
}

const WHOLE_ITEM_PLACEHOLDER_PATTERN = /^\{parameter\.([A-Za-z_]\w*)\}$/;

function expandListItem(item: string, context: Record<string, unknown>): string[] | undefined {
  const match = item.trim().match(WHOLE_ITEM_PLACEHOLDER_PATTERN);

  if (!match) return undefined;
  const value = context[match[1]];

  return Array.isArray(value) ? value.map(entry => scalarToString(entry)) : undefined;
}

async function resolveSettingValue(value: unknown, path: string, resolver: PlaceholderResolver, context: Record<string, unknown>, errors: string[]): Promise<unknown> {
  if (typeof value === 'string') {
    if (!containsParameterPlaceholder(value)) return value;
    const result = await resolver.resolveWithDetails(value);

    for (const diagnostic of result.diagnostics) {
      errors.push(diagnostic.kind === 'unresolved-placeholder'
        ? `The ${path} setting references ${diagnostic.placeholder} but no such parameter is declared under queryParameters.`
        : `Failed to resolve ${diagnostic.placeholder} in ${path}: ${diagnostic.message ?? 'unknown error'}`);
    }

    return result.result;
  }

  if (Array.isArray(value)) {
    const resolvedItems: unknown[] = [];

    for (const item of value) {
      const expansion = typeof item === 'string' ? expandListItem(item, context) : undefined;

      if (expansion) {
        for (const entry of expansion) {
          resolvedItems.push(await resolveSettingValue(entry, path, resolver, context, errors));
        }

        continue;
      }

      resolvedItems.push(await resolveSettingValue(item, path, resolver, context, errors));
    }

    return resolvedItems;
  }

  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const resolved: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      resolved[key] = await resolveSettingValue(entry, `${path}.${key}`, resolver, context, errors);
    }

    return resolved;
  }

  return value;
}

export function settingsUseParameters(value: unknown): boolean {
  if (typeof value === 'string') return containsParameterPlaceholder(value);
  if (Array.isArray(value)) return value.some(settingsUseParameters);
  if (value && typeof value === 'object' && !(value instanceof Date)) return Object.values(value).some(settingsUseParameters);

  return false;
}

export function buildParameterSignature(definitions: QueryParameterDefinition[], values: Record<string, QueryParameterValue>): string {
  return definitions.map(definition => `${definition.name}=${JSON.stringify(coerceQueryParameterValue(definition, values[definition.name]) ?? definition.defaultValue)}`).join('\u0001');
}

function buildParameterContext(definitions: QueryParameterDefinition[], values: Record<string, QueryParameterValue>, mode: 'sql' | 'verbatim'): Record<string, unknown> {
  const context: Record<string, unknown> = {};

  for (const definition of definitions) {
    const value = coerceQueryParameterValue(definition, values[definition.name]) ?? definition.defaultValue;

    context[definition.name] = mode === 'sql' && typeof value === 'boolean' ? (value ? 1 : 0) : value;
  }

  return context;
}

export function reconcileQueryParameterValues(definitions: QueryParameterDefinition[], stored: Record<string, QueryParameterValue> | undefined): Record<string, QueryParameterValue> {
  const values: Record<string, QueryParameterValue> = {};

  for (const definition of definitions) {
    const restored = stored ? coerceQueryParameterValue(definition, stored[definition.name]) : undefined;

    values[definition.name] = restored ?? definition.defaultValue;
  }

  return values;
}

const OPTION_LIMIT = 500;

export async function resolveOptionsQueries(
  definitions: QueryParameterDefinition[], runQuery: (sql: string) => Promise<unknown[]>, stored?: Record<string, QueryParameterValue>, prepareQuery?: (sql: string) => string,
): Promise<string[]> {
  const errors: string[] = [];
  const earlier: QueryParameterDefinition[] = [];
  const values: Record<string, QueryParameterValue> = {};

  for (const definition of definitions) {
    if (!definition.optionsQuery) {
      earlier.push(definition);
      values[definition.name] = coerceQueryParameterValue(definition, stored?.[definition.name]) ?? definition.defaultValue;
      continue;
    }

    try {
      let sql = prepareQuery ? prepareQuery(definition.optionsQuery) : definition.optionsQuery;

      if (queryUsesParameters(sql)) {
        const substituted = await resolveQueryParameters(sql, earlier, values);
        const laterNames = new Set(definitions.slice(definitions.indexOf(definition)).map(d => d.name));

        errors.push(...substituted.errors.map(error => {
          const referenced = error.match(/\{parameter\.([A-Za-z_]\w*)[.}]/)?.[1];
          const detail = referenced !== undefined && laterNames.has(referenced)
            ? `references {parameter.${referenced}}, but an optionsQuery only resolves parameters declared earlier in the list`
            : error;

          return `Parameter "${definition.name}": optionsQuery: ${detail}`;
        }));
        sql = substituted.sql;
      }

      const rows = await runQuery(sql);

      if (definition.control === 'range') {
        applyRangeLimits(definition, rows);
        earlier.push(definition);
        values[definition.name] = coerceQueryParameterValue(definition, stored?.[definition.name]) ?? definition.defaultValue;
        continue;
      }

      if (definition.control === 'custom') {
        definition.optionRows = rows.slice(0, OPTION_LIMIT).map(row => ({ ...(row as Record<string, unknown>) }));
      }

      const seen = new Set<string>();
      const options: string[] = [];

      for (const row of rows) {
        const first = firstColumnValue(row);

        if (first === undefined || first === null) continue;
        const value = scalarToString(first);

        if (!value || seen.has(value)) continue;
        seen.add(value);
        options.push(value);
        if (options.length >= OPTION_LIMIT) break;
      }

      if (options.length > 0) {
        definition.options = options;

        if (definition.type === 'enum' && (definition.defaultValue === '' || (definition.derivedDefault && !options.includes(definition.defaultValue as string)))) {
          definition.defaultValue = options[0];
          definition.derivedDefault = true;
        }

        if (definition.derivedAllDefault) {
          definition.defaultValue = [...options];
        }
      }
    } catch (error) {
      errors.push(`Parameter "${definition.name}": optionsQuery failed: ${getErrorMessage(error)}`);
    }

    if (!definition.options) {
      definition.options = [];
    }

    earlier.push(definition);
    values[definition.name] = coerceQueryParameterValue(definition, stored?.[definition.name]) ?? definition.defaultValue;
  }

  return errors;
}

function applyRangeLimits(definition: QueryParameterDefinition, rows: unknown[]): void {
  let min: number | undefined;
  let max: number | undefined;

  for (const row of rows) {
    const value = toFiniteNumber(firstColumnValue(row));

    if (value === undefined) continue;
    min = min === undefined ? value : Math.min(min, value);
    max = max === undefined ? value : Math.max(max, value);
  }

  if (min === undefined || max === undefined) return;
  const round = definition.type === 'int' ? Math.round : (value: number) => value;

  definition.min = round(min);
  definition.max = round(max);

  if (definition.derivedDefault) {
    definition.defaultValue = { min: definition.min, max: definition.max };
  }
}

export function parameterDependentOptionNames(definitions: QueryParameterDefinition[]): string[] {
  return definitions.filter(definition => queryUsesParameters(definition.optionsQuery)).map(definition => definition.name);
}

function firstColumnValue(row: unknown): unknown {
  if (row && typeof row === 'object' && !Array.isArray(row)) {
    const values = Object.values(row as Record<string, unknown>);

    return values.length > 0 ? values[0] : undefined;
  }

  return Array.isArray(row) ? row[0] : row;
}

function parseScale(raw: unknown): QueryParameterScale | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const scale = scalarToString(raw).trim().toLowerCase();

  return scale === 'linear' || scale === 'log' ? scale : undefined;
}

function normalizeType(raw: unknown): QueryParameterType | null {
  if (raw === undefined || raw === null || raw === '') return 'string';
  const type = scalarToString(raw).trim().toLowerCase();

  if (type === 'integer' || type === 'number') return 'int';
  if (type === 'multiselect' || type === 'multi') return 'list';

  return VALID_TYPES.has(type as QueryParameterType) ? type as QueryParameterType : null;
}

function parseScriptField(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;

  return raw.trim() ? raw : undefined;
}

function normalizeControl(raw: unknown, type: QueryParameterType, min: number | undefined, max: number | undefined, hasOptions: boolean): QueryParameterControl | null {
  if (raw === undefined || raw === null || raw === '') {
    return defaultControlForType(type, min, max, hasOptions);
  }

  const control = scalarToString(raw).trim().toLowerCase();

  if (control === 'calendar') return 'date';
  if (control === 'select') return 'dropdown';
  if (control === 'buttons') return 'segmented';

  return VALID_CONTROLS.has(control as QueryParameterControl) ? control as QueryParameterControl : null;
}

function defaultControlForType(type: QueryParameterType, min: number | undefined, max: number | undefined, hasOptions: boolean): QueryParameterControl {
  switch (type) {
    case 'int':
    case 'float':
      return min !== undefined && max !== undefined ? 'slider' : 'number';
    case 'boolean':
      return 'toggle';
    case 'date':
      return 'date';
    case 'datetime':
      return 'datetime';
    case 'time':
      return 'time';
    case 'enum':
      return 'dropdown';
    case 'list':
      return 'multiselect';
    case 'location':
      return 'location';
    case 'string':
      return hasOptions ? 'combobox' : 'text';
  }
}

function validateControlForType(name: string, control: QueryParameterControl, type: QueryParameterType, min: number | undefined, max: number | undefined, hasOptionsQuery: boolean): string | null {
  const numeric = NUMERIC_TYPES.has(type);

  if (control === 'range' && (!numeric || ((min === undefined || max === undefined) && !hasOptionsQuery))) {
    return `Parameter "${name}": range needs a numeric type with min and max (or range), or an optionsQuery supplying them.`;
  }

  if (control === 'slider' && (!numeric || min === undefined || max === undefined)) {
    return `Parameter "${name}": slider needs a numeric type with min and max (or range).`;
  }

  if (control === 'number' && !numeric) {
    return `Parameter "${name}": number control needs an int or float type.`;
  }

  if (control === 'toggle' && type !== 'boolean') {
    return `Parameter "${name}": toggle needs a boolean type.`;
  }

  if ((control === 'dropdown' || control === 'segmented') && type !== 'enum') {
    return type === 'list'
      ? `Parameter "${name}": ${control} picks a single value, so it needs an enum type. For selecting multiple values from a list, use control: multiselect.`
      : `Parameter "${name}": ${control} needs an enum type.`;
  }

  if (control === 'multiselect' && type !== 'list') {
    return `Parameter "${name}": multiselect needs a list type.`;
  }

  if (control === 'stops' && type !== 'list') {
    return `Parameter "${name}": stops needs a list type.`;
  }

  if (control === 'combobox' && type !== 'string') {
    return `Parameter "${name}": combobox needs a string type (options are suggestions, not restrictions).`;
  }

  if (control === 'date' && type !== 'date') {
    return `Parameter "${name}": date control needs a date type.`;
  }

  if (control === 'datetime' && type !== 'datetime') {
    return `Parameter "${name}": datetime control needs a datetime type.`;
  }

  if (control === 'time' && type !== 'time') {
    return `Parameter "${name}": time control needs a time type.`;
  }

  if (control === 'location' && type !== 'location') {
    return `Parameter "${name}": location control needs a location type.`;
  }

  if (type === 'location' && control !== 'location') {
    return `Parameter "${name}": location parameters use the location control.`;
  }

  return null;
}

function parseRange(record: Record<string, unknown>): { min?: number; max?: number } {
  let min = toFiniteNumber(record.min);
  let max = toFiniteNumber(record.max);

  if ((min === undefined || max === undefined) && record.range !== undefined) {
    const parts = Array.isArray(record.range)
      ? record.range
      : scalarToString(record.range).split(',').map(part => part.trim());

    min ??= toFiniteNumber(parts[0]);
    max ??= toFiniteNumber(parts[1]);
  }

  if (min !== undefined && max !== undefined && min > max) {
    [min, max] = [max, min];
  }

  return { min, max };
}

function parseOptions(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const values = Array.isArray(raw) ? raw : scalarToString(raw).split(',');
  const options = values.map(value => scalarToString(value).trim()).filter(Boolean);

  return options.length > 0 ? options : undefined;
}

function parseOptionalText(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

function parseOptionalBoolean(raw: unknown): boolean | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw === 'boolean') return raw;

  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();

    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }

  return undefined;
}

function resolveDefaultValue(definition: QueryParameterDefinition, raw: unknown): QueryParameterValue {
  const coerced = raw === undefined ? undefined : coerceQueryParameterValue(definition, raw);

  if (coerced !== undefined) return coerced;

  if (definition.control === 'range') {
    return { min: definition.min ?? 0, max: definition.max ?? 100 };
  }

  switch (definition.type) {
    case 'int':
    case 'float':
      return definition.min ?? 0;
    case 'boolean':
      return false;
    case 'date':
      return toLocalDateTimeString(new Date()).slice(0, 10);
    case 'datetime':
      return toLocalDateTimeString(new Date());
    case 'time':
      return toLocalDateTimeString(new Date()).slice(11, 16);
    case 'enum':
      return definition.options?.[0] ?? '';
    case 'list':
      return [];
    case 'string':
    case 'location':
      return '';
  }
}

function toLocalDateTimeString(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toFiniteNumber(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;

  if (typeof raw === 'string' && raw.trim() !== '') {
    const value = Number(raw.trim());

    return Number.isFinite(value) ? value : undefined;
  }

  return undefined;
}

function parseCssLength(raw: unknown): string | undefined {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 0 ? `${raw}px` : undefined;
  }

  if (typeof raw !== 'string') {
    return undefined;
  }

  const value = raw.trim();

  if (/^(?:[1-9]\d*(?:\.\d+)?|0?\.\d+)(?:px|rem|em|ch|%|vw|vh|vmin|vmax)$/i.test(value)) {
    return value;
  }

  return undefined;
}

function clamp(value: number, min: number | undefined, max: number | undefined): number {
  if (min !== undefined && value < min) return min;
  if (max !== undefined && value > max) return max;

  return value;
}
