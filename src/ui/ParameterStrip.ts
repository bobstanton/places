import { App, MarkdownRenderChild } from 'obsidian';
import { logger } from "places-shared/utils";
import { QueryParameterDefinition, QueryParameterValue, resolveOptionsQueries } from 'places/core';
import { QueryParameterState } from '../services/QueryParameterState';
import { RenderedQueryParameterControls, QueryParameterControlsLayout, QueryParameterControlsPosition, renderQueryParameterControls } from './QueryParameterControls';

const PARAMETER_APPLY_DEBOUNCE_MS = 250;

export class ParameterApplyScheduler {
  private timer: number | null = null;

  constructor(private readonly apply: () => void, private readonly delayMs: number) {}

  schedule(continuous = false): void {
    if (this.timer !== null) {
      if (continuous) return;
      window.clearTimeout(this.timer);
    }

    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.apply();
    }, this.delayMs);
  }

  dispose(): void {
    if (this.timer === null) return;
    window.clearTimeout(this.timer);
    this.timer = null;
  }
}

export interface ParameterStripOptions {
  app: App;
  container: HTMLElement;
  anchor?: HTMLElement;
  definitions: QueryParameterDefinition[];
  stateKey: string | null;
  position: QueryParameterControlsPosition;
  layout?: QueryParameterControlsLayout;
  collapsed?: boolean;
  runQuery: (sql: string) => Promise<unknown[]>;
  prepareQuery?: (sql: string) => string;
  subscribeQueryContext?: (listener: () => void) => () => void;
  onValuesApplied: () => void;
  applyDebounceMs?: number;
  addChild?: (child: MarkdownRenderChild) => void;
  rebuildOnDependentOptions?: boolean;
  transformErrors?: readonly string[];
}

export function applyExternalParameterValue(stateKey: string | null, name: string, value: QueryParameterValue): void {
  QueryParameterState.setValue(stateKey, name, value);
}

export async function renderParameterStrip(options: ParameterStripOptions): Promise<void> {
  const { definitions, stateKey } = options;

  if (definitions.length === 0 && !options.subscribeQueryContext) {
    renderTransformErrors(options.container, options.transformErrors);

    return;
  }

  let active: RenderedQueryParameterControls | null = null;
  let disposed = false;
  const lifecycle = new MarkdownRenderChild(options.container);

  lifecycle.register(() => {
    disposed = true;
    active?.dispose();
  });
  options.addChild?.(lifecycle);

  if (definitions.length === 0) {
    const scheduler = new ParameterApplyScheduler(options.onValuesApplied, options.applyDebounceMs ?? PARAMETER_APPLY_DEBOUNCE_MS);

    lifecycle.register(() => scheduler.dispose());
    lifecycle.register(options.subscribeQueryContext!(() => scheduler.schedule()));
    renderTransformErrors(options.container, options.transformErrors);
    scheduler.schedule();

    return;
  }

  const preparedValues = QueryParameterState.peek(stateKey);
  const optionsErrors = await resolveOptionsQueries(definitions, options.runQuery, preparedValues, options.prepareQuery);

  if (disposed) return;

  const values = QueryParameterState.reconcile(stateKey, definitions);

  if (preparedValues && definitions.some(definition => JSON.stringify(values[definition.name]) !== JSON.stringify(preparedValues[definition.name]))) {
    options.onValuesApplied();
  }

  const hasDependents = (name: string): boolean => (options.rebuildOnDependentOptions ?? true)
    && definitions.some(definition => new RegExp(`\\{parameter(?:\\.${name}(?:\\.|\\})|\\[\\s*["']${name}["']\\s*\\])`).test(definition.optionsQuery ?? ''));
  const host = options.position === 'floating' && options.anchor ? options.anchor : options.container;

  let revision = 0;
  let needsOptionsRefresh = false;
  let applying = false;
  let pending = false;
  let reportingLocalChange = false;
  const updateDisplay = (name: string, value: QueryParameterValue): void => {
    active?.setDisplayValue(name, value);

    if (hasDependents(name)) {
      needsOptionsRefresh = true;
      revision++;
      applyScheduler.schedule();
    }
  };

  const applyScheduler = new ParameterApplyScheduler(() => {
    pending = true;
    if (applying || disposed) return;

    void (async () => {
      applying = true;

      try {
        while (pending && !disposed) {
          pending = false;
          const currentRevision = revision;

          if (needsOptionsRefresh) {
            const next = definitions.map(definition => ({ ...definition }));
            const rebuildErrors = await resolveOptionsQueries(next, options.runQuery, QueryParameterState.peek(stateKey), options.prepareQuery);

            if (disposed || currentRevision !== revision) continue;
            needsOptionsRefresh = false;
            next.forEach((definition, index) => Object.assign(definitions[index], definition));
            active?.refreshOptions(QueryParameterState.reconcile(stateKey, definitions));
            renderErrors(rebuildErrors);
          }

          options.onValuesApplied();
        }
      } finally {
        applying = false;
      }
    })();
  }, options.applyDebounceMs ?? PARAMETER_APPLY_DEBOUNCE_MS);

  lifecycle.register(() => applyScheduler.dispose());

  for (const definition of definitions) {
    lifecycle.register(QueryParameterState.subscribe(stateKey, definition.name, value => {
      if (!reportingLocalChange && value !== undefined) updateDisplay(definition.name, value);
    }));
  }

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
      onChange: (name, value, context) => {
        reportingLocalChange = true;

        try {
          QueryParameterState.setValue(stateKey, name, value);
        } finally {
          reportingLocalChange = false;
        }

        revision++;
        needsOptionsRefresh ||= hasDependents(name);
        applyScheduler.schedule(context?.continuous === true);
      },
    });

    if (options.position === 'above') {
      options.container.insertBefore(active.strip, options.anchor ?? options.container.firstChild);
    } else if (options.anchor && options.position === 'below') {
      options.container.insertAfter(active.strip, options.anchor);
    }

    renderErrors(errors);
  };

  const renderErrors = (errors: string[]): void => {
    if (!active) return;
    active.strip.querySelectorAll(':scope > .places-query-param-error').forEach(el => el.remove());

    for (const error of [...(options.transformErrors ?? []), ...errors]) {
      active.strip.createDiv({ cls: 'places-query-param-error', text: error });
      logger.warn('Query parameter error', error);
    }
  };

  renderStrip(optionsErrors);

  if (options.subscribeQueryContext) {
    lifecycle.register(options.subscribeQueryContext(() => {
      revision++;
      needsOptionsRefresh = true;
      applyScheduler.schedule();
    }));
    applyScheduler.schedule();
  }
}

function renderTransformErrors(container: HTMLElement, errors: readonly string[] | undefined): void {
  for (const error of errors ?? []) {
    container.createDiv({ cls: 'places-query-param-error', text: error });
    logger.warn('Query parameter error', error);
  }
}
