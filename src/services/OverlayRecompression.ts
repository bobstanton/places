import { App, Notice } from "obsidian";
import { StringCompressor, getErrorMessage, logger as rootLogger, scalarToString } from "places-shared/utils";

const logger = rootLogger.scope("OverlayRecompression");
const OVERLAY_FIELDS = ["Overlay Source", "Overlay Cache"] as const;

export function recompressOverlayValue(value: string, level?: number): string {
  const decoded = StringCompressor.decodeAndDecompress(value);
  const recompressed = StringCompressor.compressAndEncode(decoded, level);

  if (StringCompressor.decodeAndDecompress(recompressed) !== decoded) {
    throw new Error("Recompressed value failed verification");
  }

  return recompressed;
}

export class OverlayRecompressor {
  constructor(private readonly app: App, private readonly level: number) {}

  async recompressVault(): Promise<void> {
    const files = this.app.vault.getMarkdownFiles();
    const progress = new Notice(`Recompressing overlay data at level ${this.level}...`, 0);
    let updated = 0;
    let unchanged = 0;
    let failed = 0;
    let bytesBefore = 0;
    let bytesAfter = 0;
    const encoder = new TextEncoder();

    // Pass the level with each call rather than through the shared global:
    // that state is visible to every plugin bundle, and this loop awaits for
    // minutes, and setting it would silently recompress anything the user
    // exports meanwhile.
    try {
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;

        if (!frontmatter) continue;

        const replacements: Record<string, string> = {};
        let hasOverlay = false;
        let fileFailed = false;
        let fileBytesBefore = 0;
        let fileBytesAfter = 0;

        for (const field of OVERLAY_FIELDS) {
          const value = scalarToString(frontmatter[field]);

          if (!value) continue;
          hasOverlay = true;
          fileBytesBefore += encoder.encode(value).length;

          try {
            const replacement = recompressOverlayValue(value, this.level);

            fileBytesAfter += encoder.encode(replacement).length;
            if (replacement !== value) replacements[field] = replacement;
          } catch (error) {
            fileFailed = true;
            logger.error(`Failed to recompress ${field} in ${file.path}`, error);
          }
        }

        if (fileFailed) {
          failed++;
        } else if (Object.keys(replacements).length > 0) {
          await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
            for (const [field, replacement] of Object.entries(replacements)) fm[field] = replacement;
          });
          updated++;
          bytesBefore += fileBytesBefore;
          bytesAfter += fileBytesAfter;
        } else if (hasOverlay) {
          unchanged++;
          bytesBefore += fileBytesBefore;
          bytesAfter += fileBytesAfter;
        }

        if (index % 50 === 49) {
          progress.setMessage(`Recompressing overlay data: ${index + 1} of ${files.length} notes scanned, ${updated} updated`);
        }
      }
    } finally {
      progress.hide();
    }

    const saved = bytesBefore - bytesAfter;
    const percent = bytesBefore > 0 ? Math.abs(saved) / bytesBefore * 100 : 0;
    const spaceResult = saved >= 0
      ? `${formatBytes(saved)} saved (${percent.toFixed(1)}%)`
      : `${formatBytes(-saved)} larger (${percent.toFixed(1)}%)`;
    const summary = `Overlay recompression complete at level ${this.level}: ${updated} notes updated, ${unchanged} unchanged, ${spaceResult}${failed ? `, ${failed} failed (see console)` : ""}`;

    new Notice(summary, 8000);
    logger.info(summary);
  }

  async run(): Promise<void> {
    try {
      await this.recompressVault();
    } catch (error) {
      logger.error("Overlay recompression failed", error);
      new Notice(`Overlay recompression failed: ${getErrorMessage(error)}`, 8000);
    }
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;

  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
