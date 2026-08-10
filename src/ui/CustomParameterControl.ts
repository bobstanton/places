import { renderUserHtmlTemplate, UserTemplateRenderError } from 'user-template-renderer';
import { getErrorMessage, logger, scalarToString } from 'places-shared/utils';
import { QueryParameterDefinition, QueryParameterValue } from '../services/QueryParameters';

// `control: custom` - a query parameter drawn by user JavaScript.
//
// Two scripts, both compiled and cached by user-template-renderer (the same
// compiler, cache and error type the weather template block uses):
//
// - `render` returns the control's HTML. Required.
// - `mount` runs after each render and wires behaviour imperatively. Optional.
//
// The markup `render` returns is wired declaratively: an element carrying
// `data-places-value` sets that value when clicked, and a form field carrying
// `data-places-input` reports its own value as it changes. Both go through the
// parameter's normal coercion: a custom control cannot put an out-of-range or
// wrongly typed value into block state.
//
// `mount` receives the live element plus `param.setValue`.

// Element attribute: clicking sets the parameter to this value.
const VALUE_ATTRIBUTE = 'data-places-value';
// Element attribute: this form field's own value is the parameter's value.
const INPUT_ATTRIBUTE = 'data-places-input';

// Helpers available to both scripts as `h`.
export interface CustomParameterHelpers {
  // HTML-escape a string.
  escape: (value: unknown) => string;
  // Tagged template that escapes every interpolation: h.html`<b>${name}</b>`.
  html: (strings: TemplateStringsArray, ...values: unknown[]) => string;
  // Integers from start (inclusive) to end (exclusive).
  range: (start: number, end: number) => number[];
  // Space-joins the keys whose value is truthy.
  classNames: (map: Record<string, unknown>) => string;
  // The attribute name that makes an element set a value on click.
  valueAttribute: string;
  // The attribute name that makes a form field report its own value.
  inputAttribute: string;
}

// The `param` argument passed to both scripts.
export interface CustomParameterApi {
  readonly name: string;
  readonly type: string;
  readonly label: string;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly defaultValue: QueryParameterValue;
  // Reads live: `mount` handlers see updates.
  readonly value: QueryParameterValue;
  // Resolved options, from `options:` or `optionsQuery:`. Empty when neither applies.
  readonly options: readonly string[];
  // Report a new value. Coerced and clamped; an unusable value is ignored.
  //
  // The control re-renders by default, which replaces every node `render`
  // produced. Pass `{ redraw: false }` from a `mount` handler that is mid
  // interaction - a drag holds a reference to the element it started on, and
  // replacing that element would end the gesture. The handler then owns
  // showing the new value; `param.value` reflects it immediately either way.
  setValue: (raw: unknown, options?: { redraw?: boolean }) => void;
  // Register a teardown callback, run before the next mount and on dispose.
  onDispose: (cleanup: () => void) => void;
}

function escapeHtml(value: unknown): string {
  return scalarToString(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function createHelpers(): CustomParameterHelpers {
  return {
    escape: escapeHtml,
    html: (strings, ...values) => strings.reduce<string>(
      (accumulator, chunk, index) => accumulator + chunk + (index < values.length ? escapeHtml(values[index]) : ''),
      '',
    ),
    range: (start, end) => {
      const result: number[] = [];
      for (let value = start; value < end; value++) result.push(value);
      return result;
    },
    classNames: map => Object.entries(map).filter(([, on]) => Boolean(on)).map(([name]) => name).join(' '),
    valueAttribute: VALUE_ATTRIBUTE,
    inputAttribute: INPUT_ATTRIBUTE,
  };
}

// `mount` bodies do DOM work rather than producing markup, but the shared
// renderer requires an HTML string. An early `return` inside the user's body
// leaves the wrapper intact, and a returned function is registered as a
// teardown.
function wrapMountSource(source: string): string {
  return `const __cleanup = (() => {\n${source}\n})();\n`
    + 'if (typeof __cleanup === "function") param.onDispose(__cleanup);\n'
    + 'return "";';
}

export interface CustomParameterControlOptions {
  item: HTMLElement;
  definition: QueryParameterDefinition;
  initial: QueryParameterValue;
  // Report a candidate value; the caller coerces it and returns what it accepted, or undefined.
  report: (raw: unknown) => QueryParameterValue | undefined;
  // Teardown registrations owned by the strip.
  cleanups: Array<() => void>;
}

// Returns the display setter the strip uses for external writes (map clicks,
// selection actions, the play button), which re-runs the user's scripts with
// the new value - compilation is cached, and this is an innerHTML swap.
export function renderCustomParameter(options: CustomParameterControlOptions): (value: QueryParameterValue) => void {
  const { item, definition, report } = options;
  // The item already carries places-query-param-custom (from the control
  // name); a distinct class here keeps user CSS able to target the script's
  // own output rather than the wrapper the strip built.
  const host = item.createDiv({ cls: 'places-query-param-custom-host' });
  const helpers = createHelpers();

  let currentValue = options.initial;
  let mountCleanups: Array<() => void> = [];

  const runMountCleanups = (): void => {
    for (const cleanup of mountCleanups) {
      try {
        cleanup();
      } catch (error) {
        logger.warn('Custom parameter cleanup failed', { parameter: definition.name, error });
      }
    }
    mountCleanups = [];
  };
  options.cleanups.push(runMountCleanups);

  const api: CustomParameterApi = {
    name: definition.name,
    type: definition.type,
    label: definition.label,
    min: definition.min,
    max: definition.max,
    step: definition.step,
    defaultValue: definition.defaultValue,
    get value() {
      return currentValue;
    },
    get options() {
      return definition.options ?? [];
    },
    setValue: (raw, setOptions) => {
      const applied = report(raw);
      if (applied === undefined) return;
      if (setOptions?.redraw === false) {
        currentValue = applied;
        return;
      }
      draw(applied);
    },
    onDispose: cleanup => mountCleanups.push(cleanup),
  };

  const showError = (error: unknown): void => {
    const message = error instanceof UserTemplateRenderError || getErrorMessage(error);
    host.replaceChildren();
    host.createDiv({ cls: 'places-query-param-error', text: `Parameter "${definition.name}": ${message}` });
    logger.warn('Custom parameter script failed', { parameter: definition.name, error });
  };

  const draw = (value: QueryParameterValue): void => {
    currentValue = value;
    runMountCleanups();
    try {
      renderUserHtmlTemplate({
        template: definition.render ?? '',
        mode: 'function-body',
        args: [
          { name: 'value', value },
          { name: 'options', value: definition.options ?? [] },
          { name: 'param', value: api },
          { name: 'h', value: helpers },
        ],
        container: host,
        // No cacheKey: supplying one *replaces* the script text in the compile
        // cache key, and two parameters that happen to share a name would run
        // each other's body. Keying on the source is correct and invalidates
        // itself the moment the user edits the block.
      });
    } catch (error) {
      showError(error);
      return;
    }

    if (!definition.mount) return;
    try {
      renderUserHtmlTemplate({
        template: wrapMountSource(definition.mount),
        mode: 'function-body',
        args: [
          { name: 'el', value: host },
          { name: 'value', value },
          { name: 'options', value: definition.options ?? [] },
          { name: 'param', value: api },
          { name: 'h', value: helpers },
        ],
        container: host,
        // The wrapper returns "", and nothing is appended; the rendered markup
        // must survive for mount to wire it.
        clearContainer: false,
      });
    } catch (error) {
      showError(error);
    }
  };

  // Delegated: draw() replaces every node the markup produced.
  const onClick = (event: MouseEvent): void => {
    const target = (event.target as HTMLElement | null)?.closest?.(`[${VALUE_ATTRIBUTE}]`);
    if (!target || !host.contains(target)) return;
    event.preventDefault();
    // Redraw: only the user's markup knows how this control shows its value.
    // Built-in controls repaint themselves before reporting.
    const applied = report(target.getAttribute(VALUE_ATTRIBUTE));
    if (applied !== undefined) draw(applied);
  };
  const onInput = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    if (!target?.hasAttribute?.(INPUT_ATTRIBUTE)) return;
    const field = target as HTMLInputElement;
    // No redraw: the field already shows what was typed, and replacing it
    // mid-edit would drop focus and the caret on every keystroke.
    report(field.type === 'checkbox' ? field.checked : field.value);
  };

  host.addEventListener('click', onClick);
  host.addEventListener('input', onInput);
  host.addEventListener('change', onInput);
  options.cleanups.push(() => {
    host.removeEventListener('click', onClick);
    host.removeEventListener('input', onInput);
    host.removeEventListener('change', onInput);
    // Emptying the host drops every node the user's scripts created, and with
    // them any listener a `mount` body attached without returning a cleanup.
    host.replaceChildren();
  });

  draw(options.initial);
  return draw;
}
