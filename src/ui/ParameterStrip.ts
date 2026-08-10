import { App, MarkdownRenderChild } from 'obsidian';
import { logger } from 'places-shared/utils';
import { QueryParameterDefinition, QueryParameterValue, parameterDependentOptionNames, resolveOptionsQueries } from '../services/QueryParameters';
import { QueryParameterState } from '../services/QueryParameterState';
import { RenderedQueryParameterControls, QueryParameterControlsLayout, QueryParameterControlsPosition, renderQueryParameterControls } from './QueryParameterControls';

const PARAMETER_APPLY_DEBOUNCE_MS = 250;

export interface ParameterStripOptions {
  app: App;
  // Block container the strip belongs to; hosts the strip unless floating.
  container: HTMLElement;
  // Element the strip positions around: 'above' inserts before it, 'below' after, 'floating' overlays it. Absent: the strip appends to the container.
  anchor?: HTMLElement;
  definitions: QueryParameterDefinition[];
  stateKey: string | null;
  position: QueryParameterControlsPosition;
  // Controls flow along a row (default) or stack one per line.
  layout?: QueryParameterControlsLayout;
  // Initial collapsed state. Declaring it makes a non-floating strip collapsible; floating strips always are.
  collapsed?: boolean;
  runQuery: (sql: string) => Promise<unknown[]>;
  // Applies the current values to the block (a map data refresh or a block re-render). Called debounced on control changes; immediately when options resolution corrected a value the block already rendered with.
  onValuesApplied: () => void;
  // Maps use a shorter interval for visual controls; query/data blocks keep the default.
  applyDebounceMs?: number;
  // Lifecycle registration (ctx.addChild): play timers stop with the block.
  addChild?: (child: MarkdownRenderChild) => void;
  // Cascading dropdowns re-resolve and re-render in place. Blocks that fully re-render on every change pass false.
  rebuildOnDependentOptions?: boolean;
  // Errors from the block's parameter transform, shown under the strip.
  transformErrors?: readonly string[];
}

// Live strip display updaters per state key: external writes (map context menu, selection actions) reflect in the controls.
const stripDisplays = new Map<string, Set<(name: string, value: QueryParameterValue) => void>>();

// The caller still triggers the block refresh appropriate to the parameter's
// scope.
export function applyExternalParameterValue(stateKey: string | null, name: string, value: QueryParameterValue): void {
  QueryParameterState.setValue(stateKey, name, value);
  if (!stateKey) return;
  for (const update of stripDisplays.get(stateKey) ?? []) {
    update(name, value);
  }
}

// Shared by places map blocks, the data blocks (chart, heatmap, similar,
// compare), and the places-parameters block.
export async function renderParameterStrip(options: ParameterStripOptions): Promise<void> {
  const { definitions, stateKey } = options;
  if (definitions.length === 0) {
    renderTransformErrors(options.container, options.transformErrors);
    return;
  }

  const preparedValues = QueryParameterState.peek(stateKey);
  const optionsErrors = await resolveOptionsQueries(definitions, options.runQuery, preparedValues);

  const values = QueryParameterState.reconcile(stateKey, definitions);
  // The block rendered before the optionsQuery results existed, and an
  // optionsQuery-backed enum resolved to '' there and to its first option
  // here. When resolving the options changed an effective value, the rendered
  // block disagrees with the controls - apply immediately.
  if (preparedValues && definitions.some(definition => JSON.stringify(values[definition.name]) !== JSON.stringify(preparedValues[definition.name]))) {
    options.onValuesApplied();
  }

  const rebuildDependents = (options.rebuildOnDependentOptions ?? true) && parameterDependentOptionNames(definitions).length > 0;
  const host = options.position === 'floating' && options.anchor ? options.anchor : options.container;

  let active: RenderedQueryParameterControls | null = null;
  let refreshTimer: number | null = null;
  const updateDisplay = (name: string, value: QueryParameterValue): void => active?.setDisplayValue(name, value);

  const lifecycle = new MarkdownRenderChild(options.container);
  lifecycle.register(() => {
    active?.dispose();
    if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    if (stateKey) stripDisplays.get(stateKey)?.delete(updateDisplay);
  });
  options.addChild?.(lifecycle);
  if (stateKey) {
    const displays = stripDisplays.get(stateKey) ?? new Set();
    displays.add(updateDisplay);
    stripDisplays.set(stateKey, displays);
  }

  const scheduleApply = (): void => {
    if (refreshTimer !== null) {
      window.clearTimeout(refreshTimer);
    }
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      void (async () => {
        if (rebuildDependents) {
          const rebuildErrors = await resolveOptionsQueries(definitions, options.runQuery, QueryParameterState.peek(stateKey));
          QueryParameterState.reconcile(stateKey, definitions);
          renderStrip(rebuildErrors);
        }
        // Non-manual application: control changes change what renders but
        // should not bust unrelated caches the way a manual refresh does.
        options.onValuesApplied();
      })();
    }, options.applyDebounceMs ?? PARAMETER_APPLY_DEBOUNCE_MS);
  };

  const renderStrip = (errors: string[]): void => {
    active?.dispose();
    active?.strip.remove();
    active = renderQueryParameterControls(host, {
      app: options.app,
      definitions,
      values: QueryParameterState.reconcile(stateKey, definitions),
      position: options.position,
      layout: options.layout,
      collapsed: options.collapsed,
      stateKey,
      onChange: (name, value) => {
        QueryParameterState.setValue(stateKey, name, value);
        scheduleApply();
      },
    });

    if (options.position === 'above') {
      options.container.insertBefore(active.strip, options.anchor ?? options.container.firstChild);
    } else if (options.anchor && options.position === 'below') {
      options.container.insertAfter(active.strip, options.anchor);
    }

    for (const error of [...(options.transformErrors ?? []), ...errors]) {
      active.strip.createDiv({ cls: 'places-query-param-error', text: error });
      logger.warn('Query parameter error', error);
    }
  };

  renderStrip(optionsErrors);
}

function renderTransformErrors(container: HTMLElement, errors: readonly string[] | undefined): void {
  for (const error of errors ?? []) {
    container.createDiv({ cls: 'places-query-param-error', text: error });
    logger.warn('Query parameter error', error);
  }
}
