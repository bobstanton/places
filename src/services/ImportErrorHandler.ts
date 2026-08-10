import { getErrorMessage, logger as rootLogger } from "places-shared/utils";
import { Notice } from "obsidian";

const logger = rootLogger.scope('Places Import');

export class ImportErrorHandler {
  // context completes the message "Failed to <context>": "parsing", "creating note".
  static handleImportError(filename: string, error: unknown, context: string): void {
    const errorMessage = getErrorMessage(error);
    logger.error(`Failed to ${context} for "${filename}":`, error);
    new Notice("Import failed for " + filename + ": " + errorMessage);
  }

  static handleBatchImportResult(successCount: number, failureCount: number, failures: string[]): void {
    if (failureCount > 0 && failures.length > 0) {
      logger.error("Import errors:", failures);
    }

    if (failureCount === 0) {
      if (successCount === 1) {
        new Notice("Track imported");
      } else {
        new Notice(`Imported ${successCount} tracks`);
      }
    } else if (successCount === 0) {
      // The reason travels in the notice. logger.error writes to the Places debug
      // log, not the developer console, so pointing a reader at the console sends
      // them somewhere empty.
      new Notice(failureCount === 1
        ? `Import failed. ${failures[0]}`
        : `All ${failureCount} imports failed. ${failures.join(", ")}`);
    } else {
      new Notice(`Imported ${successCount} tracks. ${failureCount} failed: ${failures.join(", ")}`);
    }
  }

  // No Notice; used during validation.
  static logParseError(filename: string, error: unknown): void {
    const errorMessage = getErrorMessage(error);
    logger.warn('Parse error for "' + filename + '": ' + errorMessage);
  }
}
