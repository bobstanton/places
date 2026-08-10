import { App, normalizePath } from 'obsidian';

// The tag normalizer shared by the file-cache and Dataview paths; both agree with the
// VaultQuery `note_tags` column, which runs the same split via toTagList.
export function normalizeFrontmatterTags(raw: unknown): string[] {
  if (raw == null) return [];
  const parts = Array.isArray(raw) ? raw : [raw];
  const tags = parts.flatMap(part => String(part).split(/[,\s]+/)).map(tag => tag.replace(/^#/, '').trim()).filter(Boolean);
  return [...new Set(tags)];
}

// A note's place-category tags: the frontmatter `tags:` property only. Inline body
// #hashtags are excluded as document content, not place categories (matches the
// VaultQuery `note_tags` column).
export function extractFrontmatterTagsFromFile(app: App, filePath: string): string[] {
  if (!filePath) return [];
  const file = app.vault.getFileByPath(normalizePath(filePath));
  if (!file) return [];
  return normalizeFrontmatterTags(app.metadataCache.getFileCache(file)?.frontmatter?.tags);
}
