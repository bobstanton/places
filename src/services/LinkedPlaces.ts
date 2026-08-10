export interface LinkedPlaceReference {
  raw: string;
  linkpath: string;
}

export function parseLinkedPlaceReferences(value: unknown): LinkedPlaceReference[] {
  const text = normalizeLinkedPlacesValue(value);
  if (!text) {
    return [];
  }

  const wikilinks = [...text.matchAll(/\[\[([^\]]+)\]\]/g)]
    .map(match => createReference(match[0], match[1]))
    .filter((reference): reference is LinkedPlaceReference => Boolean(reference));

  if (wikilinks.length > 0) {
    return dedupeReferences(wikilinks);
  }

  return dedupeReferences(
    text
      .split(',')
      .map(part => createReference(part.trim(), part.trim()))
      .filter((reference): reference is LinkedPlaceReference => Boolean(reference))
  );
}

function normalizeLinkedPlacesValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(item => String(item)).join('\n');
  }
  return '';
}

function createReference(raw: string, target: string): LinkedPlaceReference | null {
  const linkpath = target
    .split('|')[0]
    .split('#')[0]
    .trim();

  if (!linkpath) {
    return null;
  }

  return { raw, linkpath };
}

function dedupeReferences(references: LinkedPlaceReference[]): LinkedPlaceReference[] {
  const seen = new Set<string>();
  const deduped: LinkedPlaceReference[] = [];
  for (const reference of references) {
    const key = reference.linkpath.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(reference);
  }
  return deduped;
}
