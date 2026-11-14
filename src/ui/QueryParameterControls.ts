import { AbstractInputSuggest, App, DropdownComponent, SliderComponent, TextComponent, setIcon, setTooltip } from 'obsidian';
import { QueryParameterDefinition, QueryParameterRange, QueryParameterValue, coerceQueryParameterValue, createRangeScale, isQueryParameterRange } from 'places/core';
import { QueryParameterPlayState, QueryParameterStripState } from '../services/QueryParameterState';
import { scalarToString } from "places-shared/utils";
import { syncCodeBlockLayout } from "places-shared/obsidian/ui";
import { renderCustomParameter } from './CustomParameterControl';
import { positionFloatingPanel } from './FloatingPanelPosition';

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
  layout?: QueryParameterControlsLayout;
  collapsed?: boolean;
  stateKey?: string | null;
  onChange: (name: string, value: QueryParameterValue, context?: { continuous: true }) => void;
}

export interface RenderedQueryParameterControls {
  strip: HTMLElement;
  refreshOptions: (values: Record<string, QueryParameterValue>) => void;
  setDisplayValue: (name: string, value: QueryParameterValue) => void;
  dispose: () => void;
}

// A control's programmatic display updater; undefined when the control cannot reflect external values.
type DisplaySetter = (value: QueryParameterValue) => void;

export function renderQueryParameterControls(host: HTMLElement, options: QueryParameterControlsOptions): RenderedQueryParameterControls {
  const strip = host.createDiv({ cls: `places-query-params places-query-params-${options.position} places-query-params-${options.layout ?? 'horizontal'}` });

  syncCodeBlockLayout(host);
  strip.dataset.ignoreSwipe = 'true';
  const cleanups: Array<() => void> = [];
  const setters = new Map<string, DisplaySetter>();
  const items = new Map<string, { item: HTMLElement; cleanups: Array<() => void>; signature: string }>();
  const optionSignature = (definition: QueryParameterDefinition): string => JSON.stringify([definition.options, definition.defaultValue, definition.min, definition.max]);

  if (options.position === 'floating' || options.collapsed !== undefined) {
    renderCollapseToggle(strip, options.layout ?? 'horizontal', options.stateKey ?? null, options.collapsed ?? false);
  }

  const renderItem = (definition: QueryParameterDefinition, item: HTMLElement, values: Record<string, QueryParameterValue>): void => {
    const cleanups: Array<() => void> = [];

    items.set(definition.name, { item, cleanups, signature: optionSignature(definition) });
    setters.delete(definition.name);
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

    let currentValue = values[definition.name] ?? definition.defaultValue;
    const report = (raw: unknown, continuous = false): QueryParameterValue | undefined => {
      const value = coerceQueryParameterValue(definition, raw);

      if (value === undefined) return undefined;
      if (JSON.stringify(value) === JSON.stringify(currentValue)) return value;
      currentValue = value;
      options.onChange(definition.name, value, continuous ? { continuous: true } : undefined);

      return value;
    };

    const initial = currentValue;
    let setter: DisplaySetter | undefined;

    switch (definition.control) {
      case 'slider':
        setter = renderSlider(item, definition, initial, report, cleanups);
        break;
      case 'range':
        setter = renderRange(item, definition, initial, report);
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
        setter = renderToggle(item, initial, report, cleanups);
        break;
      case 'multiselect':
        setter = renderMultiselect(item, definition, initial, report);
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
  };

  for (const definition of options.definitions) {
    renderItem(definition, strip.createDiv({ cls: `places-query-param places-query-param-${definition.control}` }), options.values);
  }

  if (options.position === 'floating') cleanups.push(positionFloatingPanel(host, strip));

  return {
    strip,
    refreshOptions: values => {
      for (const definition of options.definitions) {
        const previous = items.get(definition.name)!;

        if (previous.signature === optionSignature(definition)) continue;
        previous.cleanups.forEach(cleanup => cleanup());
        previous.item.replaceChildren();
        renderItem(definition, previous.item, values);
      }
    },
    setDisplayValue: (name, value) => setters.get(name)?.(value),
    dispose: () => {
      syncCodeBlockLayout(host, undefined, strip);
      for (const cleanup of cleanups) cleanup();
      for (const record of items.values()) record.cleanups.forEach(cleanup => cleanup());
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

function renderSlider(item: HTMLElement, definition: QueryParameterDefinition, initial: QueryParameterValue, report: (raw: unknown, continuous?: boolean) => void, cleanups: Array<() => void>): DisplaySetter {
  const hitArea = item.createDiv({ cls: 'places-query-param-slider-hit-area' });
  const min = definition.min ?? 0;
  const max = definition.max ?? 100;
  const step = definition.step ?? (definition.type === 'float' ? 0.1 : 1);
  const slider = new SliderComponent(hitArea)
    .setLimits(min, max, step)
    .setValue(Number(initial));

  slider.sliderEl.addClass('places-query-param-input');

  const reportInput = (): void => report(Number(slider.sliderEl.value), true);

  slider.sliderEl.addEventListener('input', reportInput);
  cleanups.push(() => slider.sliderEl.removeEventListener('input', reportInput));

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

function renderRange(item: HTMLElement, definition: QueryParameterDefinition, initial: QueryParameterValue, report: (raw: unknown, continuous?: boolean) => void): DisplaySetter {
  const scale = createRangeScale(definition);
  const start = isQueryParameterRange(initial) ? initial : { min: scale.min, max: scale.max };
  const formatRange = (value: QueryParameterRange): string => `${scale.format(value.min)}-${scale.format(value.max)}`;
  let valueLabel: HTMLElement | undefined;

  if (definition.showValue !== false) {
    valueLabel = item.createSpan({ cls: 'places-query-param-value', text: formatRange(start) });
    const widestEnd = Math.max(scale.format(scale.min).length, scale.format(scale.max).length);

    valueLabel.style.minWidth = `${widestEnd * 2 + 1}ch`;
  }

  const track = item.createDiv({ cls: 'places-query-param-range-track' });
  const attrs = { type: 'range', min: String(scale.input.min), max: String(scale.input.max), step: String(scale.input.step) };

  const lowInput = track.createEl('input', { cls: 'places-query-param-input places-query-param-range-low', attr: attrs });
  const highInput = track.createEl('input', { cls: 'places-query-param-input places-query-param-range-high', attr: attrs });

  lowInput.value = String(scale.toInput(start.min));
  highInput.value = String(scale.toInput(start.max));

  const updateTrack = (low: number, high: number): void => {
    const span = scale.input.max - scale.input.min;
    const lowPercent = span > 0 ? ((low - scale.input.min) / span) * 100 : 0;
    const highPercent = span > 0 ? ((high - scale.input.min) / span) * 100 : 100;

    track.style.setProperty('--places-query-range-low', `${Math.max(0, Math.min(100, lowPercent))}%`);
    track.style.setProperty('--places-query-range-high', `${Math.max(0, Math.min(100, highPercent))}%`);
  };

  const current = (): QueryParameterRange => {
    let low = Number(lowInput.value);
    let high = Number(highInput.value);

    if (low > high) {
      [low, high] = [high, low];
      lowInput.value = String(low);
      highInput.value = String(high);
    }

    const value = { min: scale.fromInput(low), max: scale.fromInput(high) };

    valueLabel?.setText(formatRange(value));
    updateTrack(low, high);

    return value;
  };
  const reportInput = (): void => { report(current(), true); };
  const commit = (): void => { report(current()); };

  updateTrack(Number(lowInput.value), Number(highInput.value));

  for (const input of [lowInput, highInput]) {
    input.addEventListener('input', reportInput);
    input.addEventListener('change', commit);
  }

  return value => {
    if (!isQueryParameterRange(value)) return;
    lowInput.value = String(scale.toInput(value.min));
    highInput.value = String(scale.toInput(value.max));
    valueLabel?.setText(formatRange(value));
    updateTrack(Number(lowInput.value), Number(highInput.value));
  };
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

function createOptionButton(group: HTMLElement, option: string): HTMLButtonElement {
  const button = group.createEl('button', { text: option, cls: 'places-query-param-segment', attr: { type: 'button' } });

  if (/^(?:\p{Extended_Pictographic}[\uFE0E\uFE0F]?|\p{Emoji_Presentation}|\p{Emoji_Modifier}|\u200D|[0-9#*]\uFE0F?\u20E3|[\u{E0020}-\u{E007F}])+$/u.test(option.trim())) {
    button.addClass('is-emoji');
  }

  return button;
}

function renderSegmented(item: HTMLElement, definition: QueryParameterDefinition, initial: QueryParameterValue, report: (raw: unknown) => void): DisplaySetter {
  const group = item.createDiv({ cls: 'places-query-param-segments' });
  const buttons = new Map<string, HTMLButtonElement>();

  const activate = (option: string): void => {
    for (const [, candidate] of buttons) candidate.removeClass('is-active');
    buttons.get(option)?.addClass('is-active');
  };

  for (const option of definition.options ?? []) {
    const button = createOptionButton(group, option);

    buttons.set(option, button);
    button.addEventListener('click', () => {
      activate(option);
      report(option);
    });
  }

  activate(scalarToString(initial));

  return value => activate(scalarToString(value));
}

function renderToggle(item: HTMLElement, initial: QueryParameterValue, report: (raw: unknown) => void, cleanups: Array<() => void>): DisplaySetter {
  const holder = item.createDiv({ cls: 'places-query-param-toggle-holder' });
  const button = holder.createEl('button', {
    cls: 'clickable-icon places-query-param-toggle-button',
    attr: { type: 'button', role: 'switch' },
  });
  const label = item.querySelector('.places-query-param-label');

  if (label) button.appendChild(label);
  const indicator = button.createSpan({ cls: 'checkbox-container', attr: { 'aria-hidden': 'true' } });
  let checked = Boolean(initial);
  const display = (value: QueryParameterValue): void => {
    checked = Boolean(value);
    button.setAttribute('aria-checked', String(checked));
    indicator.toggleClass('is-enabled', checked);
  };
  const activate = (): void => {
    display(!checked);
    report(checked);
  };

  display(initial);
  button.addEventListener('click', activate);
  cleanups.push(() => button.removeEventListener('click', activate));

  return display;
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

function renderMultiselect(item: HTMLElement, definition: QueryParameterDefinition, initial: QueryParameterValue, report: (raw: unknown) => void): DisplaySetter {
  const group = item.createDiv({ cls: 'places-query-param-segments places-query-param-chips' });
  const selected = new Set(Array.isArray(initial) ? initial.map(String) : []);
  const buttons = new Map<string, HTMLButtonElement>();

  for (const option of definition.options ?? []) {
    const button = createOptionButton(group, option);

    buttons.set(option, button);
    if (selected.has(option)) button.addClass('is-active');
    button.addEventListener('click', () => {
      if (selected.has(option)) {
        selected.delete(option);
        button.removeClass('is-active');
      } else {
        selected.add(option);
        button.addClass('is-active');
      }

      report((definition.options ?? []).filter(candidate => selected.has(candidate)));
    });
  }

  return value => {
    selected.clear();
    if (Array.isArray(value)) value.forEach(option => selected.add(String(option)));
    for (const [option, button] of buttons) button.toggleClass('is-active', selected.has(option));
  };
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
