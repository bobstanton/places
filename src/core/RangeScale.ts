import type { QueryParameterDefinition } from './QueryParameters';

export interface RangeScale {
  min: number;
  max: number;
  step: number;
  input: { min: number; max: number; step: number };
  toInput(value: number): number;
  fromInput(input: number): number;
  format(value: number): string;
}

export const LOG_SCALE_RESOLUTION = 1000;

export function createRangeScale(definition: Pick<QueryParameterDefinition, 'type' | 'min' | 'max' | 'step' | 'scale'>): RangeScale {
  const min = definition.min ?? 0;
  const max = definition.max ?? 100;
  const step = definition.step ?? (definition.type === 'float' ? 0.1 : 1);
  const format = (value: number): string => value.toFixed(decimalPlaces(step));

  if (definition.scale !== 'log') {
    return { min, max, step, input: { min, max, step }, toInput: value => value, fromInput: input => input, format };
  }

  const span = Math.log1p((max - min) / step);
  const decimals = Math.max(decimalPlaces(step), decimalPlaces(min));

  return {
    min,
    max,
    step,
    input: { min: 0, max: LOG_SCALE_RESOLUTION, step: 1 },
    toInput: value => span > 0 ? Math.round(Math.log1p(Math.max(0, value - min) / step) / span * LOG_SCALE_RESOLUTION) : 0,
    fromInput: input => {
      if (input <= 0 || span <= 0) return min;
      if (input >= LOG_SCALE_RESOLUTION) return max;
      const raw = min + Math.expm1(input / LOG_SCALE_RESOLUTION * span) * step;
      const snapped = Number((min + Math.round((raw - min) / step) * step).toFixed(decimals));

      return Math.min(max, Math.max(min, snapped));
    },
    format,
  };
}

function decimalPlaces(value: number): number {
  const [mantissa, exponent] = String(value).split('e');

  return Math.max(0, (mantissa.split('.')[1]?.length ?? 0) - Number(exponent ?? 0));
}
