export const TEMPLATE_BLOCK_LANGUAGE = "places-template";

export interface TemplateReference {
  linkpath: string;
  heading?: string;
}

export function parseTemplateReference(raw: string): TemplateReference | undefined {
  const inner = raw.trim().match(/^\[\[(.+?)\]\]$/u)?.[1] ?? raw.trim();
  const withoutAlias = inner.split("|")[0].trim();

  if (!withoutAlias) return undefined;

  const hashIndex = withoutAlias.indexOf("#");

  if (hashIndex < 0) return { linkpath: withoutAlias };

  const linkpath = withoutAlias.slice(0, hashIndex).trim();
  const heading = withoutAlias.slice(hashIndex + 1).trim();

  return linkpath ? { linkpath, heading: heading || undefined } : undefined;
}

const FENCE_PATTERN = /^(\s*)(`{3,}|~{3,})\s*([A-Za-z][\w-]*)?\s*/u;

export function extractTemplateBlock(markdown: string, heading?: string): string | undefined {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const [start, end] = heading ? headingRange(lines, heading) : [0, lines.length];

  if (start < 0) return undefined;

  for (let index = start; index < end; index++) {
    const opening = lines[index].match(FENCE_PATTERN);

    if (!opening || opening[3] !== TEMPLATE_BLOCK_LANGUAGE) continue;

    const [, indent, fence] = opening;
    const closing = new RegExp(`^\\s*${fence[0] === "~" ? "~" : "`"}{${fence.length},}\\s*$`, "u");
    const body: string[] = [];

    for (let line = index + 1; line < end; line++) {
      if (closing.test(lines[line])) return body.join("\n");
      body.push(indent && lines[line].startsWith(indent) ? lines[line].slice(indent.length) : lines[line]);
    }

    return body.join("\n");
  }

  return undefined;
}

function headingRange(lines: string[], heading: string): [number, number] {
  const wanted = heading.trim().toLowerCase();
  let level = 0;
  let start = -1;
  let fence: string | undefined;

  for (let index = 0; index < lines.length; index++) {
    const fenceMatch = lines[index].match(FENCE_PATTERN);

    if (fenceMatch) {
      const marker = fenceMatch[2];

      if (fence === undefined) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;

      continue;
    }

    if (fence !== undefined) continue;

    const match = lines[index].match(/^(#{1,6})\s+(.*?)\s*$/u);

    if (!match) continue;

    if (start < 0) {
      if (match[2].toLowerCase() === wanted) {
        level = match[1].length;
        start = index + 1;
      }

      continue;
    }

    if (match[1].length <= level) return [start, index];
  }

  return [start, lines.length];
}
