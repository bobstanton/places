import { renderKnapTemplate } from 'places-shared/services';
import type { PortablePopupRenderer } from 'places-shared/map';

export function createKnapPopupRenderer(readTemplate: (reference: string, sourcePath?: string) => Promise<string>): PortablePopupRenderer {
  return {
    id: 'knap',
    description: 'Markdown from a Knap template and the clicked place or feature',
    kind: 'sections',
    async render({ context, options, markdownSourcePath }) {
      if (typeof options?.templateFile !== 'string' || !options.templateFile.trim()) {
        throw new Error('The knap popup renderer requires options.templateFile.');
      }

      const template = await readTemplate(options.templateFile, markdownSourcePath);

      return [{ type: 'markdown', markdown: await renderKnapTemplate(template, context) }];
    },
  };
}
