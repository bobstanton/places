import { App, Notice, TFile } from "obsidian";
import { getErrorMessage, renderErrorWithHelp, logger as rootLogger } from "places-shared/utils";
import type { TrackData } from 'places-shared/geo';
import type { TrackDataService } from "../services/TrackDataService";

const logger = rootLogger.scope("TrackActionBar");

export interface TrackActionBarOptions {
  app: App;
  container: HTMLElement;
  trackDataService: TrackDataService;
  // Path of the note the block is rendered in - the export note is created alongside it.
  sourcePath: string;
  // Source track note to replace, or null when the track isn't a markdown note (replace disabled).
  targetFile: TFile | null;
  // `metadata.source` must already be set by the caller.
  trackData: TrackData;
  // e.g. `Replace elevation in "Morning Run"`.
  replaceLabel: string;
  replaceSuccess: string;
  // Tooltip shown when `targetFile` is null.
  replaceDisabledTitle: string;
  // Default name for the exported note.
  exportName: string;
}

// Both actions produce identical data via TrackDataService (GeoJSON overlay frontmatter).
export function renderTrackActionBar(options: TrackActionBarOptions): void {
  const { app, container, trackDataService, sourcePath, targetFile, trackData } = options;
  const actions = container.createDiv({ cls: "places-track-action-bar" });
  const status = container.createDiv({ cls: "places-track-action-status" });

  const replace = actions.createEl("button", { cls: "places-button mod-cta", text: options.replaceLabel });

  if (targetFile) {
    replace.addEventListener("click", () => {
      void withBusy(replace, async () => {
        status.empty();

        try {
          await trackDataService.writeOverlayToFile(targetFile, trackData);
          setSuccess(status, options.replaceSuccess);
        } catch (error) {
          logger.error("Track replace failed", error);
          renderErrorWithHelp(status, { icon: "⚠️", title: "Failed to replace track", message: getErrorMessage(error) });
        }
      });
    });
  } else {
    replace.disabled = true;
    replace.title = options.replaceDisabledTitle;
  }

  const exportButton = actions.createEl("button", { cls: "places-button", text: "Export to new note" });

  exportButton.addEventListener("click", () => {
    void withBusy(exportButton, async () => {
      status.empty();

      try {
        const file = await trackDataService.createTrackNote(trackData, { sourcePath, name: options.exportName });

        setSuccess(status, `Created track note "${file.basename}".`);
        new Notice(`Created track note: ${file.path}`);

        await app.workspace.getLeaf().openFile(file);
      } catch (error) {
        logger.error("Track export failed", error);
        renderErrorWithHelp(status, { icon: "⚠️", title: "Failed to export track", message: getErrorMessage(error) });
      }
    });
  });
}

function setSuccess(status: HTMLElement, text: string): void {
  status.empty();
  status.createDiv({ cls: "places-action-status is-success", text });
}

async function withBusy(button: HTMLButtonElement, action: () => Promise<void>): Promise<void> {
  button.disabled = true;

  try {
    await action();
  } finally {
    button.disabled = false;
  }
}
