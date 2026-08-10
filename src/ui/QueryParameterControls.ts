import { AbstractInputSuggest, App, DropdownComponent, SliderComponent, TextComponent, ToggleComponent, setIcon, setTooltip } from 'obsidian';
import { QueryParameterDefinition, QueryParameterValue, coerceQueryParameterValue, isQueryParameterRange } from '../services/QueryParameters';
import { QueryParameterPlayState, QueryParameterStripState } from '../services/QueryParameterState';
import { scalarToString } from 'places-shared/utils';
import { renderCustomParameter } from './CustomParameterControl';

export type QueryParameterControlsPosition = 'above' | 'below' | 'floating';
export type QueryParameterControlsLayout = 'horizontal' | 'vertical';

// `queryParametersPosition` as written in a block; anything unrecognized renders below.
export function normalizeQueryParameterPosition(raw: unknown): QueryParameterControlsPosition {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return value === 'above' || value === 'floating' ? value : 'below';
}

// `queryParametersLayout` as written in a block; anything unrecognized flows horizontally.
export function normalizeQueryParameterLayout(raw: unknown): QueryParameterControlsLayout {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return value === 'vertical' ? value : 'horizontal';
}

export interface QueryParameterControlsOptions {
  app: App;
  definitions: QueryParameterDefinition[];
  values: Record<string, QueryParameterValue>;
  position: QueryParameterControlsPosition;
  // Controls flow along a row (default) or stack one per line.
  layout?: QueryParameterControlsLayout;
  // Initial collapsed state. Declaring it makes a non-floating strip collapsible; floating strips always are.
  collapsed?: boolean;
  // Session key for play-state persistence across strip re-renders.
  stateKey?: string | null;
  // Called with the coerced value whenever a control changes; the caller owns debouncing.
  onChange: (name: string, value: QueryParameterValue) => void;
}

export interface RenderedQueryParameterControls {
  strip: HTMLElement;
  // Updates a control's displayed value after an external state change (map click, selection action). No onChange fires.
  setDisplayValue: (name: string, value: QueryParameterValue) => void;
  // Stops timers owned by the controls; call before removing or replacing the strip.
  dispose: () => void;
}

// A control's programmatic display updater; undefined when the control cannot reflect external values.
type DisplaySetter = (value: QueryParameterValue) => void;

// Controls are built from Obsidian's own setting components (or
// platform-native inputs where Obsidian has none), and follow the active
// theme. Every element carries classes and data
// attributes (`data-param-name`, `data-param-type`, `data-param-control`) for
// restyling with CSS snippets or the block's `css:` setting.
export function renderQueryParameterControls(host: HTMLElement, options: QueryParameterControlsOptions): RenderedQueryParameterControls {
  const strip = host.createDiv({ cls: `places-query-params places-query-params-${options.position} places-query-params-${options.layout ?? 'horizontal'}` });
  const cleanups: Array<() => void> = [];
  const setters = new Map<string, DisplaySetter>();

  // A floating strip overlays the map and is always collapsible; the other
  // positions only take up layout space and become collapsible when the block
  // asks for it by declaring an initial state.
  if (options.position === 'floating' || options.collapsed !== undefined) {
    renderCollapseToggle(strip, options.layout ?? 'horizontal', options.stateKey ?? null, options.collapsed ?? false);
  }

  for (const definition of options.definitions) {
    const item = strip.createDiv({ cls: `places-query-param places-query-param-${definition.control}` });
    item.setAttr('data-param-name', definition.name);
    item.setAttr('data-param-type', definition.type);
    item.setAttr('data-param-control', definition.control);
    if (definition.width) {
      item.addClass('places-query-param-custom-width');
      item.style.setProperty('--places-query-param-width', definition.width);
      if (/^(?:\d+(?:\.\d+)?|\.\d+)%$/.test(definition.width)) {
        item.addClass('places-query-param-percentage-width');
      }
    }

    renderParameterLabel(item, definition.label);

    let currentValue = options.values[definition.name] ?? definition.defaultValue;
    // Returns the value that was accepted, or undefined when the input was unusable.
    const report = (raw: unknown): QueryParameterValue | undefined => {
      const value = coerceQueryParameterValue(definition, raw);
      if (value === undefined) return undefined;
      currentValue = value;
      options.onChange(definition.name, value);
      return value;
    };

    const initial = currentValue;
    let setter: DisplaySetter | undefined;

    switch (definition.control) {
      case 'slider':
        setter = renderSlider(item, definition, initial, report);
        break;
      case 'range':
        renderRange(item, definition, initial, report);
        break;
      case 'number':
        setter = renderNumber(item, definition, initial, report);
        break;
      case 'text':
      case 'location':
        setter = renderText(item, definition, initial, report);
        break;
      case 'combobox':
        setter = renderCombobox(options.app, item, definition, initial, report);
        break;
      case 'dropdown':
        setter = renderDropdown(item, definition, initial, report);
        break;
      case 'segmented':
        setter = renderSegmented(item, definition, initial, report);
        break;
      case 'toggle':
        setter = renderToggle(item, initial, report);
        break;
      case 'multiselect':
        renderMultiselect(item, definition, initial, report);
        break;
      case 'stops':
        setter = renderStops(options.app, item, definition, initial, report);
        break;
      case 'date':
        setter = renderTemporalInput(item, 'date', scalarToString(initial), report);
        break;
      case 'datetime':
        setter = renderDateTimeInput(item, scalarToString(initial), report);
        break;
      case 'time':
        setter = renderTemporalInput(item, 'time', scalarToString(initial), report);
        break;
      case 'custom':
        setter = renderCustomParameter({ item, definition, initial, report, cleanups });
        break;
    }

    if (setter) {
      setters.set(definition.name, value => {
        currentValue = value;
        setter(value);
      });
    }

    if (definition.play !== undefined && setter) {
      renderPlayButton(item, definition, options.stateKey ?? null, () => currentValue, value => {
        setter(value);
        report(value);
      }, cleanups);
    }
  }

  return {
    strip,
    setDisplayValue: (name, value) => setters.get(name)?.(value),
    dispose: () => {
      for (const cleanup of cleanups) cleanup();
    },
  };
}

function renderParameterLabel(item: HTMLElement, label: string): void {
  const match = label.match(/^(.*?)\s+\(([^()]+)\)$/);
  const labelEl = item.createSpan({ cls: 'places-query-param-label' });
  labelEl.createSpan({ text: match?.[1] ?? label });
  if (match) {
    labelEl.createSpan({ cls: 'places-query-param-label-context', text: match[2] });
  }
}

// Collapse toggle for a control strip. Collapsed, the strip is just this
// button - the parameters and any error rows hide through CSS, keeping every
// control and its state alive. The flag persists per state key across strip
// rebuilds and block re-renders.
function renderCollapseToggle(strip: HTMLElement, layout: QueryParameterControlsLayout, stateKey: string | null, initialCollapsed: boolean): void {
  const button = strip.createEl('button', { cls: 'clickable-icon places-query-param-collapse', attr: { type: 'button' } });
  // Vertical strips fold upward, horizontal ones back toward their left edge.
  const collapseIcon = layout === 'vertical' ? 'chevron-up' : 'chevron-left';

  const apply = (collapsed: boolean): void => {
    strip.toggleClass('is-collapsed', collapsed);
    setIcon(button, collapsed ? 'sliders-horizontal' : collapseIcon);
    button.setAttr('aria-expanded', String(!collapsed));
    const label = collapsed ? 'Show parameters' : 'Hide parameters';
    button.setAttr('aria-label', label);
    setTooltip(button, label, { placement: 'top' });
  };

  apply(QueryParameterStripState.isCollapsed(stateKey, initialCollapsed));
  button.addEventListener('click', () => {
    const collapsed = !strip.hasClass('is-collapsed');
    QueryParameterStripState.setCollapsed(stateKey, collapsed);
    apply(collapsed);
  });
}

// Play/pause button for auto-advancing controls. Sliders step from min to max
// and wrap; dropdowns and segmented controls cycle their options. The playing
// flag persists in session state, and data blocks that re-render their strip on
// every value change keep playing. A detached strip (reading view scrolled
// away) holds its value and resumes on reattach.
function renderPlayButton(item: HTMLElement, definition: QueryParameterDefinition, stateKey: string | null, getValue: () => QueryParameterValue, applyValue: (value: QueryParameterValue) => void, cleanups: Array<() => void>): void {
  const button = item.createEl('button', { cls: 'clickable-icon places-query-param-play', attr: { type: 'button', 'aria-label': `Play or pause ${definition.label}` } });
  setTooltip(button, `Play or pause ${definition.label}`, { placement: 'top' });
  let timer: number | null = null;

  const stop = (): void => {
    if (timer === null) return;
    window.clearInterval(timer);
    timer = null;
    setIcon(button, 'play');
    button.removeClass('is-active');
  };

  const start = (): void => {
    if (timer !== null) return;
    setIcon(button, 'pause');
    button.addClass('is-active');
    timer = window.setInterval(() => {
      if (!button.isConnected) return;
      applyValue(advancePlayValue(definition, getValue()));
    }, definition.play);
  };

  setIcon(button, 'play');
  button.addEventListener('click', () => {
    const playing = timer === null;
    QueryParameterPlayState.setPlaying(stateKey, definition.name, playing);
    if (playing) start();
    else stop();
  });

  if (QueryParameterPlayState.isPlaying(stateKey, definition.name)) {
    start();
  }
  cleanups.push(stop);
}

function advancePlayValue(definition: QueryParameterDefinition, current: QueryParameterValue): QueryParameterValue {
  // Step a numeric-range custom control like a slider; cycle one with options
  // like a dropdown.
  const stepsNumerically = definition.control === 'slider'
    || (definition.control === 'custom' && (definition.options?.length ?? 0) === 0);
  if (stepsNumerically) {
    const min = definition.min ?? 0;
    const max = definition.max ?? 100;
    const step = definition.step ?? (definition.type === 'float' ? 0.1 : 1);
    const base = typeof current === 'number' ? current : min;
    const next = base + step;
    if (next > max + 1e-9) return min;
    const precision = Math.max(0, (String(step).split('.')[1] ?? '').length);
    return Number(next.toFixed(precision));
  }

  const cycle = definition.options ?? [];
  if (cycle.length === 0) return current;
  const index = cycle.indexOf(scalarToString(current));
  return cycle[(index + 1) % cycle.length];
}

function renderSlider(item: HTMLElement, definition: QueryParameterDefinition, initial: QueryParameterValue, report: (raw: unknown) => void): DisplaySetter {
  const hitArea = item.createDiv({ cls: 'places-query-param-slider-hit-area' });
  const min = definition.min ?? 0;
  const max = definition.max ?? 100;
  const step = definition.step ?? (definition.type === 'float' ? 0.1 : 1);
  const slider = new SliderComponent(hitArea)
    .setLimits(min, max, step)
    .setValue(Number(initial))
    .onChange(report);
  slider.sliderEl.addClass('places-query-param-input');

  // Keep the theme's normal range-input appearance while making the empty
  // vertical space around it clickable as part of the control.
  hitArea.addEventListener('click', event => {
    if (event.target === slider.sliderEl || max <= min) return;
    const bounds = hitArea.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    const stepped = min + Math.round(((min + ratio * (max - min)) - min) / step) * step;
    const precision = Math.max(0, (String(step).split('.')[1] ?? '').length);
    const value = Number(Math.max(min, Math.min(max, stepped)).toFixed(precision));
    slider.setValue(value);
    report(value);
  });

  return value => {
    slider.setValue(Number(value));
  };
}

// Dual-ended range: two overlapping native range inputs. The track comes from
// the lower input; both thumbs stay interactive via pointer-events on the
// thumb pseudo-elements (see styles.css). Thumbs cannot cross.
function renderRange(item: HTMLElement, definition: QueryParameterDefinition, initial: QueryParameterValue, report: (raw: unknown) => void): void {
  const start = isQueryParameterRange(initial) ? initial : { min: definition.min ?? 0, max: definition.max ?? 100 };
  const valueLabel = item.createSpan({ cls: 'places-query-param-value', text: `${start.min}-${start.max}` });

  const track = item.createDiv({ cls: 'places-query-param-range-track' });
  const limitMin = definition.min ?? 0;
  const limitMax = definition.max ?? 100;
  const step = String(definition.step ?? (definition.type === 'float' ? 0.1 : 1));
  const attrs = { type: 'range', min: String(limitMin), max: String(limitMax), step };

  const lowInput = track.createEl('input', { cls: 'places-query-param-input places-query-param-range-low', attr: attrs });
  const highInput = track.createEl('input', { cls: 'places-query-param-input places-query-param-range-high', attr: attrs });
  lowInput.value = String(start.min);
  highInput.value = String(start.max);

  const updateTrack = (low: number, high: number): void => {
    const span = limitMax - limitMin;
    const lowPercent = span > 0 ? ((low - limitMin) / span) * 100 : 0;
    const highPercent = span > 0 ? ((high - limitMin) / span) * 100 : 100;
    track.style.setProperty('--places-query-range-low', `${Math.max(0, Math.min(100, lowPercent))}%`);
    track.style.setProperty('--places-query-range-high', `${Math.max(0, Math.min(100, highPercent))}%`);
  };

  const update = (): void => {
    let low = Number(lowInput.value);
    let high = Number(highInput.value);
    if (low > high) {
      [low, high] = [high, low];
      lowInput.value = String(low);
      highInput.value = String(high);
    }
    valueLabel.setText(`${low}-${high}`);
    updateTrack(low, high);
    report({ min: low, max: high });
  };

  updateTrack(start.min, start.max);
  lowInput.addEventListener('input', update);
  highInput.addEventListener('input', update);
}

function renderNumber(item: HTMLElement, definition: QueryParameterDefinition, initial: QueryParameterValue, report: (raw: unknown) => void): DisplaySetter {
  const text = new TextComponent(item)
    .setValue(scalarToString(initial))
    .onChange(report);
  text.inputEl.type = 'number';
  text.inputEl.addClass('places-query-param-input');
  if (definition.min !== undefined) text.inputEl.min = String(definition.min);
  if (definition.max !== undefined) text.inputEl.max = String(definition.max);
  if (definition.step !== undefined) text.inputEl.step = String(definition.step);
  return value => { text.setValue(scalarToString(value)); };
}

function renderText(item: HTMLElement, definition: QueryParameterDefinition, initial: QueryParameterValue, report: (raw: unknown) => void): DisplaySetter {
  const text = new TextComponent(item)
    .setValue(scalarToString(initial))
    .onChange(report);
  text.inputEl.addClass('places-query-param-input');
  if (definition.control === 'location') {
    text.inputEl.placeholder = 'Name: latitude, longitude';
  }
  return value => { text.setValue(scalarToString(value)); };
}

class QueryParameterSuggest extends AbstractInputSuggest<string> {
  constructor(app: App, input: HTMLInputElement, private readonly options: readonly string[]) {
    super(app, input);
  }

  protected getSuggestions(query: string): string[] {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return [...this.options];

    const matches = this.options.filter(option => option.toLocaleLowerCase().includes(needle));
    return matches.sort((left, right) => {
      const leftStarts = left.toLocaleLowerCase().startsWith(needle);
      const rightStarts = right.toLocaleLowerCase().startsWith(needle);
      return Number(rightStarts) - Number(leftStarts);
    });
  }

  renderSuggestion(value: string, el: HTMLElement): void {
    el.setText(value);
  }
}

// Free text with Obsidian's native keyboard-accessible suggestion popover.
function renderCombobox(app: App, item: HTMLElement, definition: QueryParameterDefinition, initial: QueryParameterValue, report: (raw: unknown) => void): DisplaySetter {
  const text = new TextComponent(item)
    .setValue(scalarToString(initial))
    .onChange(report);
  text.inputEl.addClass('places-query-param-input');

  const suggest = new QueryParameterSuggest(app, text.inputEl, definition.options ?? []);
  suggest.onSelect(value => {
    text.setValue(value);
    report(value);
    suggest.close();
  });
  return value => { text.setValue(scalarToString(value)); };
}

function renderDropdown(item: HTMLElement, definition: QueryParameterDefinition, initial: QueryParameterValue, report: (raw: unknown) => void): DisplaySetter {
  const dropdown = new DropdownComponent(item);
  for (const option of definition.options ?? []) {
    dropdown.addOption(option, option);
  }
  dropdown.setValue(scalarToString(initial)).onChange(report);
  dropdown.selectEl.addClass('places-query-param-input');
  return value => { dropdown.setValue(scalarToString(value)); };
}

function renderSegmented(item: HTMLElement, definition: QueryParameterDefinition, initial: QueryParameterValue, report: (raw: unknown) => void): DisplaySetter {
  const group = item.createDiv({ cls: 'places-query-param-segments' });
  const buttons = new Map<string, HTMLButtonElement>();

  const activate = (option: string): void => {
    for (const [, candidate] of buttons) candidate.removeClass('is-active');
    buttons.get(option)?.addClass('is-active');
  };

  for (const option of definition.options ?? []) {
    const button = group.createEl('button', { text: option, cls: 'places-query-param-segment', attr: { type: 'button' } });
    buttons.set(option, button);
    button.addEventListener('click', () => {
      activate(option);
      report(option);
    });
  }

  activate(scalarToString(initial));
  return value => activate(scalarToString(value));
}

function renderToggle(item: HTMLElement, initial: QueryParameterValue, report: (raw: unknown) => void): DisplaySetter {
  const holder = item.createDiv({ cls: 'places-query-param-toggle-holder' });
  const toggle = new ToggleComponent(holder)
    .setValue(Boolean(initial))
    .onChange(report);
  return value => { toggle.setValue(Boolean(value)); };
}

// Free-form ordered rows with add and remove buttons (multi-stop directions,
// isochrone centers). The value is the non-empty rows in order; declared or
// query-supplied options are per-row suggestions, never restrictions.
function renderStops(app: App, item: HTMLElement, definition: QueryParameterDefinition, initial: QueryParameterValue, report: (raw: unknown) => void): DisplaySetter {
  item.querySelector('.places-query-param-label')?.remove();
  const fieldset = item.createEl('fieldset', { cls: 'places-query-param-stop-fieldset' });
  fieldset.createEl('legend', { cls: 'places-query-param-stop-legend', text: definition.label });
  const column = fieldset.createDiv({ cls: 'places-query-param-stop-rows' });
  const rows = column.createDiv({ cls: 'places-query-param-stop-list' });
  const defaultStops = Array.isArray(definition.defaultValue) ? definition.defaultValue.map(String) : [];

  const collect = (): string[] => Array.from(rows.querySelectorAll('input')).map(input => input.value.trim()).filter(Boolean);

  const updateRowSemantics = (): void => {
    const rowElements = Array.from(rows.querySelectorAll<HTMLElement>('.places-query-param-stop-row'));
    rowElements.forEach((row, index) => {
      const positionLabel = `Stop ${index + 1}`;
      row.querySelector<HTMLElement>('.places-query-param-stop-marker')?.setText(String(index + 1));

      const input = row.querySelector<HTMLInputElement>('input');
      input?.setAttribute('aria-label', positionLabel);

      const remove = row.querySelector<HTMLButtonElement>('.places-query-param-stop-button');
      const value = input?.value.trim();
      const removeLabel = `Remove ${positionLabel.toLowerCase()}${value ? `: ${value}` : ''}`;
      remove?.setAttribute('aria-label', removeLabel);
    });
  };

  const addRow = (value: string): void => {
    const row = rows.createDiv({ cls: 'places-query-param-stop-row' });
    row.createSpan({ cls: 'places-query-param-stop-marker', attr: { 'aria-hidden': 'true' } });
    const text = new TextComponent(row)
      .setValue(value)
      .onChange(() => {
        updateRowSemantics();
        report(collect());
      });
    text.inputEl.addClass('places-query-param-input');
    if (definition.options?.length) {
      const suggest = new QueryParameterSuggest(app, text.inputEl, definition.options);
      suggest.onSelect(selected => {
        text.setValue(selected);
        report(collect());
        suggest.close();
      });
    }
    const remove = row.createEl('button', { cls: 'clickable-icon places-query-param-stop-button', attr: { type: 'button' } });
    setIcon(remove, 'trash-2');
    setTooltip(remove, 'Remove stop', { placement: 'top' });
    remove.addEventListener('click', () => {
      row.remove();
      ensureRow();
      updateRowSemantics();
      report(collect());
    });
    updateRowSemantics();
  };

  const ensureRow = (): void => {
    if (rows.childElementCount === 0) addRow('');
  };

  const render = (values: string[]): void => {
    rows.empty();
    for (const value of values) addRow(value);
    ensureRow();
    updateRowSemantics();
  };

  render(Array.isArray(initial) ? initial.map(String) : []);

  const actions = column.createDiv({ cls: 'places-query-param-stop-actions' });
  const add = actions.createEl('button', { cls: 'places-query-param-stop-add', attr: { type: 'button', 'aria-label': 'Add stop' } });
  setIcon(add, 'plus');
  add.createSpan({ text: 'Add stop' });
  add.addEventListener('click', () => {
    addRow('');
    updateRowSemantics();
    const inputs = rows.querySelectorAll('input');
    inputs[inputs.length - 1]?.focus();
  });

  const reset = actions.createEl('button', { cls: 'places-query-param-stop-reset', attr: { type: 'button', 'aria-label': 'Reset stops to defaults' } });
  setIcon(reset, 'rotate-ccw');
  reset.createSpan({ text: 'Reset stops' });
  setTooltip(reset, 'Reset stops to defaults', { placement: 'top' });
  reset.addEventListener('click', () => {
    render(defaultStops);
    report(defaultStops);
  });

  return value => render(Array.isArray(value) ? value.map(String) : []);
}

// Multi-select as toggleable chips; the value is the array of active options.
function renderMultiselect(item: HTMLElement, definition: QueryParameterDefinition, initial: QueryParameterValue, report: (raw: unknown) => void): void {
  const group = item.createDiv({ cls: 'places-query-param-segments places-query-param-chips' });
  const selected = new Set(Array.isArray(initial) ? initial.map(String) : []);

  for (const option of definition.options ?? []) {
    const button = group.createEl('button', { text: option, cls: 'places-query-param-segment', attr: { type: 'button' } });
    if (selected.has(option)) button.addClass('is-active');
    button.addEventListener('click', () => {
      if (selected.has(option)) {
        selected.delete(option);
        button.removeClass('is-active');
      } else {
        selected.add(option);
        button.addClass('is-active');
      }
      // Preserve declared option order in the reported value.
      report((definition.options ?? []).filter(candidate => selected.has(candidate)));
    });
  }
}

type TemporalInputType = 'date' | 'time';

function openNativePicker(input: HTMLInputElement): void {
  try {
    input.showPicker();
  } catch {
    input.focus();
  }
}

function createTemporalSegment(holder: HTMLElement, type: TemporalInputType, value: string, ariaLabel: string): HTMLInputElement {
  const segment = holder.createDiv({ cls: `places-query-param-temporal-segment places-query-param-temporal-${type}` });
  const icon = segment.createEl('button', {
    cls: 'places-query-param-temporal-icon',
    attr: { type: 'button', 'aria-label': `Open ${ariaLabel.toLowerCase()} picker` },
  });
  setIcon(icon, type === 'date' ? 'calendar-days' : 'clock-3');
  const input = segment.createEl('input', {
    type,
    cls: 'places-query-param-input places-query-param-temporal-input',
    attr: { 'aria-label': ariaLabel },
  });
  input.value = value;
  icon.addEventListener('click', () => openNativePicker(input));
  return input;
}

function renderTemporalInput(item: HTMLElement, type: TemporalInputType, initial: string, report: (raw: unknown) => void): DisplaySetter {
  const holder = item.createDiv({ cls: 'places-query-param-temporal' });
  const input = createTemporalSegment(holder, type, initial, item.dataset.paramName ?? type);
  input.value = initial;
  input.addEventListener('change', () => report(input.value));
  return value => { input.value = scalarToString(value); };
}

function renderDateTimeInput(item: HTMLElement, initial: string, report: (raw: unknown) => void): DisplaySetter {
  const holder = item.createDiv({ cls: 'places-query-param-temporal places-query-param-temporal-datetime' });
  const [initialDate = '', initialTime = ''] = initial.split('T');
  const label = item.dataset.paramName ?? 'date and time';
  const dateInput = createTemporalSegment(holder, 'date', initialDate, `${label} date`);
  const timeInput = createTemporalSegment(holder, 'time', initialTime, `${label} time`);
  const reportCombined = (): void => {
    if (dateInput.value && timeInput.value) report(`${dateInput.value}T${timeInput.value}`);
  };
  dateInput.addEventListener('change', reportCombined);
  timeInput.addEventListener('change', reportCombined);
  return value => {
    const [date = '', time = ''] = scalarToString(value).split('T');
    dateInput.value = date;
    timeInput.value = time;
  };
}
