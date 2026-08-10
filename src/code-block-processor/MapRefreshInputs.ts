import { MarkdownPostProcessorContext } from "obsidian";
import { logger } from "places-shared/utils";

export interface MapRefreshRenderInputs {
  source: string;
  ctx: MarkdownPostProcessorContext;
}

// Builds a resolver that reconstructs the inputs Obsidian would hand a
// post-processor if it re-rendered the block right now. Refresh callbacks run
// outside Obsidian's render pipeline, and two inputs can be stale:
// - the block text: the note may have been edited without a re-render (e.g.
//   routine mobile editor saves);
// - ctx.sourcePath: Obsidian keeps the original context object alive with the
//   pre-rename path.
//
// The resolver owns the block's last-known source and line position; the
// refresh service only routes events and supplies the current source path.
export function createMapRefreshInputResolver(container: HTMLElement, initialSource: string, ctx: MarkdownPostProcessorContext, sectionLineStart?: number): (currentSourcePath: string) => MapRefreshRenderInputs {
  let source = initialSource;
  sectionLineStart ??= ctx.getSectionInfo(container)?.lineStart;

  return (currentSourcePath: string): MapRefreshRenderInputs => {
    source = resolveCurrentSource(container, ctx, source, sectionLineStart, currentSourcePath);
    return { source, ctx: createRefreshContext(ctx, currentSourcePath) };
  };
}

function resolveCurrentSource(container: HTMLElement, ctx: MarkdownPostProcessorContext, lastSource: string, sectionLineStart: number | undefined, currentSourcePath: string): string {
  const sectionInfo = ctx.getSectionInfo(container);
  if (
    sectionInfo?.lineStart !== undefined &&
    sectionLineStart !== undefined &&
    sectionInfo.lineStart !== sectionLineStart
  ) {
    logger.debug('map refresh ignored section text from different code block', {
      sourcePath: ctx.sourcePath,
      currentSourcePath,
      registeredLineStart: sectionLineStart,
      currentLineStart: sectionInfo.lineStart,
    });
    return lastSource;
  }

  if (!sectionInfo?.text) {
    return lastSource;
  }

  // sectionInfo.text is the full document, not the section.
  const allLines = sectionInfo.text.replace(/\r\n/g, '\n').split('\n');
  const sectionLines = allLines.slice(sectionInfo.lineStart, sectionInfo.lineEnd + 1).join('\n');
  return extractCodeBlockSource(sectionLines) ?? lastSource;
}

function createRefreshContext(ctx: MarkdownPostProcessorContext, currentSourcePath: string): MarkdownPostProcessorContext {
  if (ctx.sourcePath === currentSourcePath) {
    return ctx;
  }

  return new Proxy(ctx, {
    get(target, property, receiver): unknown {
      return property === 'sourcePath' ? currentSourcePath : Reflect.get(target, property, receiver);
    }
  });
}

function extractCodeBlockSource(sectionText: string): string | null {
  const lines = sectionText.replace(/\r\n/g, '\n').split('\n');
  const openingIndex = lines.findIndex(line => /^(```|~~~)\s*places(?:\s|$)/i.test(line.trim()));
  if (openingIndex < 0) {
    return null;
  }

  const fence = lines[openingIndex].trim().startsWith('~~~') ? '~~~' : '```';
  const closingIndex = lines.findIndex((line, index) => index > openingIndex && line.trim().startsWith(fence));
  if (closingIndex < 0) {
    return null;
  }

  return lines.slice(openingIndex + 1, closingIndex).join('\n');
}
