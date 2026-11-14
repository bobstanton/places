export function parseTagFilterPatterns(value: string): string[] {
  return value
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

export function sanitizePlaceTag(tag: string): string {
  return tag.trim().replace(/^#/, '').replace(/\./g, '-');
}

function normalizeTagForComparison(tag: string): string {
  return sanitizePlaceTag(tag).toLowerCase().replace(/[\s_]+/g, '-');
}

export function shouldFilterPlaceTag(tag: string, patterns: string[]): boolean {
  if (!patterns || patterns.length === 0) return false;
  const normalizedTag = normalizeTagForComparison(tag);

  if (!normalizedTag) return true;

  for (const pattern of patterns) {
    const normalizedPattern = normalizeTagForComparison(pattern);

    if (!normalizedPattern) continue;
    if (normalizedTag === normalizedPattern) return true;
  }

  return false;
}

export function preparePlaceTags(tags: string[] | undefined, filterPatterns: string[] = []): string[] {
  if (!tags || tags.length === 0) return [];

  const prepared: string[] = [];
  const seen = new Set<string>();

  for (const rawTag of tags) {
    const tag = sanitizePlaceTag(String(rawTag));

    if (!tag || shouldFilterPlaceTag(tag, filterPatterns)) continue;

    const key = tag.toLowerCase();

    if (seen.has(key)) continue;
    seen.add(key);
    prepared.push(tag);
  }

  return prepared;
}
