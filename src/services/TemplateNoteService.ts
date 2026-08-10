import { App, TFile, normalizePath } from "obsidian";
import { getAvailableVaultPath } from "places-shared/utils";

// Fence language holding a template body. See CodeBlockRegistry for why it is `places-*`.
export const TEMPLATE_BLOCK_LANGUAGE = "places-template";

// A `fromTemplate:` reference, split into the note it names and an optional heading within it.
export interface TemplateReference {
  // Note linkpath, resolved the way any Obsidian link is.
  linkpath: string;
  // Heading naming one template in a note that holds several.
  heading?: string;
}

// Accepts `[[Note]]`, `[[Note#Heading]]`, `[[Note|Alias]]` and the bare forms
// of each. A bare name resolves through `getFirstLinkpathDest` exactly like a link.
export function parseTemplateReference(raw: string): TemplateReference | undefined {
  const inner = raw.trim().match(/^\[\[(.+?)\]\]$/u)?.[1] ?? raw.trim();
  // An alias changes only how a link reads, never what it points at.
  const withoutAlias = inner.split("|")[0].trim();
  if (!withoutAlias) return undefined;

  const hashIndex = withoutAlias.indexOf("#");
  if (hashIndex < 0) return { linkpath: withoutAlias };

  const linkpath = withoutAlias.slice(0, hashIndex).trim();
  const heading = withoutAlias.slice(hashIndex + 1).trim();
  return linkpath ? { linkpath, heading: heading || undefined } : undefined;
}

// A template is a `places-template` block in a note, referenced by link.
//
// There is no template folder. A link identifies a note wherever it lives, and
// `#heading` names one template in a note that holds several - both resolved
// with Obsidian's own link semantics rather than a parallel lookup scheme.
//
// Bodies are cached per note and dropped when the note changes, because a
// template is read on every render of every block that references it.
export class TemplateNoteService {
  private readonly bodies = new Map<string, { mtime: number; markdown: string }>();

  constructor(private readonly app: App) {}

  // Forget one note's cached content, or all of it when no path is given.
  invalidate(path?: string): void {
    if (path === undefined) this.bodies.clear();
    else this.bodies.delete(path);
  }

  // Whether this note has ever been read as a template, i.e. whether anything depends on it.
  isCached(path: string): boolean {
    return this.bodies.has(path);
  }

  // The note a reference resolves to, relative to the note holding the block.
  resolveFile(reference: TemplateReference, sourcePath: string): TFile | undefined {
    return this.app.metadataCache.getFirstLinkpathDest(reference.linkpath, sourcePath) ?? undefined;
  }

  // The template body a reference resolves to, or undefined when the note does
  // not exist or holds no matching `places-template` block.
  async readBody(raw: string, sourcePath: string): Promise<string | undefined> {
    const reference = parseTemplateReference(raw);
    if (!reference) return undefined;

    const file = this.resolveFile(reference, sourcePath);
    if (!file) return undefined;

    const cached = this.bodies.get(file.path);
    const markdown = cached && cached.mtime === file.stat.mtime
      ? cached.markdown
      : await this.app.vault.cachedRead(file);
    this.bodies.set(file.path, { mtime: file.stat.mtime, markdown });

    return extractTemplateBlock(markdown, reference.heading);
  }

  // A starter note body: a new template opens on something valid to edit.
  static scaffold(name: string, body = "height: 500px\n"): string {
    return `Template. Apply it with \`fromTemplate: [[${name}]]\` in a places block.\n\n\`\`\`${TEMPLATE_BLOCK_LANGUAGE}\n${body.endsWith("\n") ? body : `${body}\n`}\`\`\`\n`;
  }
}

// Create a template note beside the note that will use it, and return it.
export async function createTemplateNote(app: App, folder: string, body?: string, preferredName = "New template"): Promise<TFile | undefined> {
  const root = normalizePath(folder.trim());
  if (root && root !== "." && !app.vault.getAbstractFileByPath(root)) {
    await app.vault.createFolder(root).catch(() => undefined);
  }
  const prefix = root && root !== "." ? `${root}/` : "";
  const path = getAvailableVaultPath(app, `${prefix}${preferredName}.md`);
  // The scaffold names the template in its own body, and must match whatever
  // name survived deduplication rather than the one that was asked for.
  const name = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
  return app.vault.create(path, TemplateNoteService.scaffold(name, body)).catch(() => undefined);
}

const FENCE_PATTERN = /^(\s*)(`{3,}|~{3,})\s*([A-Za-z][\w-]*)?\s*/u;

// A `places-template` block's body from a note.
//
// With a heading, only the section under it is searched, ending at the next
// heading of the same or higher level: one note can define several templates
// and `[[Note#Name]]` picks one. Without a heading, the note's first
// template block wins.
//
// Matches the opening fence's own length, letting a body containing ``` inside
// a longer fence still end where it should, and tolerates a fence left unclosed
// at end of file.
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
      // Strip the fence's own indentation: an indented block (in a list, say)
      // yields the same body as an unindented one.
      body.push(indent && lines[line].startsWith(indent) ? lines[line].slice(indent.length) : lines[line]);
    }
    return body.join("\n");
  }
  return undefined;
}

// Line range of a named section: from just after the heading to the next
// heading of the same or higher level. Headings inside fenced blocks are
// skipped, and a `#` in a template body cannot end the section early.
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
