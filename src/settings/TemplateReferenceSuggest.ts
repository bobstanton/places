import { AbstractInputSuggest } from 'obsidian';
import { parseTemplateReference } from 'places/core';

export class TemplateReferenceSuggest extends AbstractInputSuggest<string> {
  protected getSuggestions(query: string): string[] {
    const value = query.trim().replace(/^\[\[|\]\]$/gu, '').split('|')[0];
    const reference = parseTemplateReference(value);

    if (value.includes('#')) {
      const file = reference && this.app.metadataCache.getFirstLinkpathDest(reference.linkpath, '');

      if (!file) return [];
      const needle = reference.heading?.toLocaleLowerCase() ?? '';

      return (this.app.metadataCache.getFileCache(file)?.headings ?? [])
        .filter(heading => heading.heading.toLocaleLowerCase().includes(needle))
        .map(heading => `[[${file.path.replace(/\.md$/iu, '')}#${heading.heading}]]`);
    }

    const needle = value.toLocaleLowerCase();

    return this.app.vault.getMarkdownFiles()
      .filter(file => file.path.toLocaleLowerCase().includes(needle))
      .map(file => `[[${file.path.replace(/\.md$/iu, '')}]]`)
      .sort((left, right) => left.localeCompare(right));
  }

  renderSuggestion(value: string, el: HTMLElement): void {
    el.setText(value);
  }
}
