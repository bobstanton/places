import { App, normalizePath } from 'obsidian';

import { normalizeFrontmatterTags } from "places-shared/map";

// A note's place-category tags: the frontmatter `tags:` property only. Inline body
// #hashtags are excluded as document content, not place categories (matches the
// VaultQuery `note_tags` column).
export function extractFrontmatterTagsFromFile(app: App, filePath: string): string[] {
  if (!filePath) return [];
  const file = app.vault.getFileByPath(normalizePath(filePath));

  if (!file) return [];

  return normalizeFrontmatterTags(app.metadataCache.getFileCache(file)?.frontmatter?.tags);
}
