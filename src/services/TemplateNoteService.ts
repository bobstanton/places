import { App, TFile, normalizePath } from "obsidian";
import { extractTemplateBlock, parseTemplateReference, TEMPLATE_BLOCK_LANGUAGE, type TemplateReference } from 'places/core';
export { extractTemplateBlock, parseTemplateReference, TEMPLATE_BLOCK_LANGUAGE } from "places/core";
export type { TemplateReference } from "places/core";
import { getAvailableVaultPath } from "places-shared/obsidian/utils";

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
