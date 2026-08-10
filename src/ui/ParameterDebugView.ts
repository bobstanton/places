import { scalarToString, serializeUnknown } from 'places-shared/utils';
import { QueryParameterDefinition, QueryParameterValue } from '../services/QueryParameters';
import { PreparedParameterDebug } from '../services/PlacesRenderPreparer';

export interface ParameterDebugViewInputs {
  definitions: QueryParameterDefinition[];
  values: Record<string, QueryParameterValue>;
  trace: PreparedParameterDebug;
}

const PANEL_CLASS = 'places-param-debug';

// The `debug: parameters` panel: current parameter values, every setting's
// text before and after {parameter.*} substitution, per-rule markerFilter
// results, and the metadata field names conditions can see. Rendered under
// the block (settings-trace styling) and replaced in place on refresh, and the
// trace follows control changes.
export function renderParameterDebugPanel(container: HTMLElement, inputs: ParameterDebugViewInputs): void {
  removeParameterDebugPanel(container);
  const section = container.createDiv({ cls: `places-settings-trace ${PANEL_CLASS}` });

  const header = section.createDiv({ cls: 'places-settings-trace-header' });
  header.createSpan({ cls: 'places-settings-trace-title', text: 'Parameters & filters' });

  renderParametersSection(section, inputs);
  renderSubstitutionsSection(section, inputs.trace);
  renderMarkerFilterSection(section, inputs.trace);

  if (inputs.trace.fieldNames.length > 0) {
    const fields = section.createDiv({ cls: 'places-param-debug-fields' });
    fields.createSpan({ cls: 'places-param-debug-label', text: 'Fields visible to conditions: ' });
    fields.createSpan({ text: inputs.trace.fieldNames.join(', ') });
  }
}

export function removeParameterDebugPanel(container: HTMLElement): void {
  container.querySelector(`:scope > .${PANEL_CLASS}`)?.remove();
}

function renderParametersSection(section: HTMLElement, inputs: ParameterDebugViewInputs): void {
  if (inputs.definitions.length === 0) return;

  const scroll = section.createDiv({ cls: 'places-settings-trace-scroll' });
  const table = scroll.createEl('table');
  const head = table.createEl('thead').createEl('tr');
  for (const column of ['Parameter', 'Type', 'Control', 'Value', 'Options']) {
    head.createEl('th', { text: column });
  }

  const body = table.createEl('tbody');
  for (const definition of inputs.definitions) {
    const value = inputs.values[definition.name];
    const row = body.createEl('tr');
    row.createEl('td', { text: definition.name, cls: 'places-settings-trace-key' });
    row.createEl('td', { text: definition.type });
    row.createEl('td', { text: definition.control });
    const isDefault = JSON.stringify(value) === JSON.stringify(definition.defaultValue);
    row.createEl('td', { text: `${displayValue(value)}${isDefault ? ' (default)' : ''}`, cls: 'places-settings-trace-resolved' });
    row.createEl('td', { text: describeOptions(definition) });
  }
}

function renderSubstitutionsSection(section: HTMLElement, trace: PreparedParameterDebug): void {
  if (trace.substitutions.length === 0) return;

  const scroll = section.createDiv({ cls: 'places-settings-trace-scroll' });
  const table = scroll.createEl('table');
  const head = table.createEl('thead').createEl('tr');
  for (const column of ['Setting', 'Written as', 'Ran as']) {
    head.createEl('th', { text: column });
  }

  const body = table.createEl('tbody');
  for (const entry of trace.substitutions) {
    const row = body.createEl('tr');
    row.createEl('td', { text: entry.setting, cls: 'places-settings-trace-key' });
    row.createEl('td', { cls: 'places-param-debug-text' }).createEl('code', { text: entry.before });
    row.createEl('td', { cls: 'places-param-debug-text places-settings-trace-resolved' }).createEl('code', { text: entry.after });
  }
}

function renderMarkerFilterSection(section: HTMLElement, trace: PreparedParameterDebug): void {
  const filter = trace.markerFilter;
  if (!filter) return;

  const scroll = section.createDiv({ cls: 'places-settings-trace-scroll' });
  const table = scroll.createEl('table');
  const head = table.createEl('thead').createEl('tr');
  head.createEl('th', { text: 'markerFilter rule' });
  head.createEl('th', { text: 'Matched' });

  const body = table.createEl('tbody');
  for (const rule of filter.rules) {
    const row = body.createEl('tr');
    row.createEl('td', { cls: 'places-param-debug-text' }).createEl('code', { text: rule.rule });
    row.createEl('td', { text: rule.valid ? `${rule.matched} of ${filter.total}` : 'invalid rule (not parsed)' });
  }

  const hidden = filter.total - filter.kept;
  section.createDiv({
    cls: 'places-param-debug-summary',
    text: `Showing ${filter.kept} of ${filter.total} places (${hidden} hidden${filter.live ? ', toggled live without re-querying' : ''}). A place is shown when any rule matches.`,
  });
}

function describeOptions(definition: QueryParameterDefinition): string {
  if (definition.options && definition.options.length > 0) {
    return definition.optionsQuery ? `${definition.options.join(', ')} (from optionsQuery)` : definition.options.join(', ');
  }
  return definition.optionsQuery ? '(from optionsQuery, resolved by the controls)' : '';
}

function displayValue(value: QueryParameterValue | undefined): string {
  if (value === undefined || value === null) return '(unset)';
  if (Array.isArray(value)) return value.length === 0 ? '(empty list)' : value.map(entry => scalarToString(entry)).join(', ');
  if (typeof value === 'string' && value === '') return '(empty)';
  // A range parameter is an object.
  return serializeUnknown(value);
}
