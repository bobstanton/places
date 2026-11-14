import { App, Notice, TFile } from 'obsidian';
import { StringCompressor, logger as rootLogger, scalarToString } from "places-shared/utils";
import { compactGeoJson } from 'places/core';
import { convertOverlaySourceToGeoJson } from 'places/core';

const logger = rootLogger.scope('Overlays');

// `skipped`: a note with no overlay, or one that renders straight from its source; whether a note stores a cache is the import setting's decision, not this command's.
export type OverlayCacheRebuildOutcome =
  | { kind: 'skipped' }
  | { kind: 'updated' | 'unchanged'; hasTimestamps: boolean }
  | { kind: 'failed'; error: unknown };

// The cache is precomputed GeoJSON and takes precedence over the source when a
// map renders: anything missing from the cache is invisible even when the
// source still has it. A track cached before Places carried per-point
// timestamps cannot color by speed or pace until its cache is regenerated.
// The source is never touched.
export async function rebuildOverlayCache(app: App, file: TFile): Promise<OverlayCacheRebuildOutcome> {
  const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
  const source = scalarToString(frontmatter?.['Overlay Source']);
  const existingCache = scalarToString(frontmatter?.['Overlay Cache']);

  if (!source || !existingCache) return { kind: 'skipped' };

  try {
    const overlay = convertOverlaySourceToGeoJson(StringCompressor.decodeAndDecompress(source));
    const rebuilt = StringCompressor.compressAndEncode(JSON.stringify(compactGeoJson(overlay.geojson)));
    const hasTimestamps = Boolean(overlay.track?.time?.length);

    if (rebuilt === existingCache) return { kind: 'unchanged', hasTimestamps };

    await app.fileManager.processFrontMatter(file, (matter: Record<string, unknown>) => {
      matter['Overlay Cache'] = rebuilt;
    });

    return { kind: 'updated', hasTimestamps };
  } catch (error) {
    logger.error(`Failed to rebuild Overlay Cache for ${file.path}`, error);

    return { kind: 'failed', error };
  }
}

interface RebuildTally {
  updated: number;
  unchanged: number;
  withTimestamps: number;
  withoutTimestamps: number;
  failed: number;
}

export class OverlayCacheRebuilder {
  constructor(private readonly app: App) {}

  async run(): Promise<void> {
    const files = this.app.vault.getMarkdownFiles();
    const progress = new Notice('Rebuilding overlay caches...', 0);
    const tally: RebuildTally = { updated: 0, unchanged: 0, withTimestamps: 0, withoutTimestamps: 0, failed: 0 };

    try {
      for (let index = 0; index < files.length; index++) {
        const outcome = await rebuildOverlayCache(this.app, files[index]);

        recordOutcome(tally, outcome);

        if (index % 25 === 0) {
          progress.setMessage(`Rebuilding overlay caches... ${index + 1}/${files.length}`);
        }
      }
    } finally {
      progress.hide();
    }

    new Notice(summarize(tally), 10000);
    logger.info('Overlay cache rebuild complete', { ...tally });
  }
}

function recordOutcome(tally: RebuildTally, outcome: OverlayCacheRebuildOutcome): void {
  if (outcome.kind === 'skipped') return;

  if (outcome.kind === 'failed') {
    tally.failed++;

    return;
  }

  if (outcome.kind === 'updated') tally.updated++;
  else tally.unchanged++;

  if (outcome.hasTimestamps) tally.withTimestamps++;
  else tally.withoutTimestamps++;
}

function summarize(tally: RebuildTally): string {
  const lines = [`Overlay caches: ${tally.updated} rebuilt, ${tally.unchanged} already current.`];

  if (tally.failed > 0) {
    lines.push(`${tally.failed} failed - see the console for details.`);
  }

  return lines.join('\n');
}

export async function rebuildOverlayCacheForFile(app: App, file: TFile): Promise<void> {
  const outcome = await rebuildOverlayCache(app, file);

  switch (outcome.kind) {
    case 'skipped':
      new Notice('No overlay cache to rebuild.');

      return;
    case 'failed':
      new Notice('Failed to rebuild the overlay cache - see the console for details.');

      return;
    case 'unchanged':
      new Notice('Overlay cache is already current.');

      return;
    case 'updated':
      new Notice('Overlay cache rebuilt.');
  }
}
