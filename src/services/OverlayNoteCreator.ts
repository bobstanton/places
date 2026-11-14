import type { App, TFile } from 'obsidian';
import { normalizeVaultPath as normalizePath } from 'places-shared/utils';
import { getAvailableVaultPath, ensureVaultFolder, resolveNewNoteFolder } from 'places-shared/obsidian/utils';
import { Utilities } from 'places-shared/utils';
import { assignFrontmatter } from "places-shared/services";

export interface CreateOverlayNoteOptions {
  name: string;
  sourcePath?: string;
  frontmatter: Record<string, unknown>;
  body?: string;
  openAfterCreate?: boolean;
}

export function overlayNoteBody(): string {
  return ['', '```places', 'height: 500px', '```', ''].join('\n');
}

export async function createOverlayNote(app: App, options: CreateOverlayNoteOptions): Promise<TFile> {
  const folder = resolveNewNoteFolder(app, options.sourcePath);
  const noteName = Utilities.sanitizeFilename(options.name) || 'Overlay';
  const basePath = normalizePath(`${folder ? `${folder}/` : ''}${noteName}.md`);

  await ensureVaultFolder(app, basePath);
  const path = getAvailableVaultPath(app, basePath);
  const file = await app.vault.create(path, options.body ?? overlayNoteBody());

  await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
    assignFrontmatter(frontmatter, options.frontmatter);
  });

  if (options.openAfterCreate) {
    await app.workspace.getLeaf().openFile(file);
  }

  return file;
}
