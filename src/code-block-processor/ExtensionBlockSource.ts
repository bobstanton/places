export function splitExtensionBlockSource(source: string, format: 'yaml' | 'yaml-template' = 'yaml') {
  const separator = format === 'yaml-template' ? /^---[ \t]*\r?$/m.exec(source) : null;
  const settings = separator ? source.slice(0, separator.index) : source;
  const suffix = separator ? source.slice(separator.index) : '';

  return {
    settings,
    withSettings: (resolvedSettings: string): string => suffix ? `${resolvedSettings}\n${suffix}` : resolvedSettings,
  };
}
