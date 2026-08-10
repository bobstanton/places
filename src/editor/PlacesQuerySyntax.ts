const YAML_BLOCK_SCALAR_INDICATOR = /^[|>](?:[1-9][+-]?|[+-][1-9]?)?$/u;

export function isYamlBlockScalarIndicator(value: string): boolean {
  return YAML_BLOCK_SCALAR_INDICATOR.test(value.trim());
}

export function isQueryBlockContentLine(text: string, parentIndent: number): boolean {
  const lineIndent = text.search(/\S/u);
  return lineIndent < 0 || lineIndent > parentIndent;
}
