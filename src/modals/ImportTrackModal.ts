import { App, Modal, Platform, Setting } from "obsidian";
import { OverlayImportResult } from "../services/OverlayImportResult";
import { OverlayImportService } from "../services/OverlayImportService";
import { overlayFormatFromContent } from "places-shared/overlay";

type ImportMode = "current" | "new";
type FileType = "gpx" | "geojson" | "csv" | "unknown";
type MultiTrackMode = "combined" | "separate";

export class ImportTrackModal extends Modal {
  onSubmit: (results: OverlayImportResult[], importMode: ImportMode, targetFolder?: string, sourceFilename?: string) => void;
  input!: string;
  validationDiv!: HTMLDivElement;
  private overlayImportService: OverlayImportService;
  private importMode: ImportMode = "new";
  private fileType: FileType = "unknown";
  private gpxImportMode: MultiTrackMode;
  private geoJsonImportMode: MultiTrackMode;
  private multiTrackModeContainer?: HTMLElement;
  private importModeContainer?: HTMLElement;
  private hasActiveFile: boolean;
  private sourceFilename?: string;

  constructor(
    app: App,
    onSubmit: (results: OverlayImportResult[], importMode: ImportMode, targetFolder?: string, sourceFilename?: string) => void,
    hasActiveFile: boolean = false,
    initialGpxImportMode: MultiTrackMode = "combined",
    initialGeoJsonImportMode: MultiTrackMode = "combined",
  ) {
    super(app);
    this.onSubmit = onSubmit;
    this.overlayImportService = new OverlayImportService();
    this.hasActiveFile = hasActiveFile;
    this.importMode = "new";
    this.gpxImportMode = initialGpxImportMode;
    this.geoJsonImportMode = initialGeoJsonImportMode;
  }

  onOpen() {
    const { contentEl } = this;

    contentEl.createEl("h1", { text: "Import track data" });

     
    contentEl.createEl("p", { text: "Paste file contents or select a file (GPX, GeoJSON, or CSV). File type will be auto-detected." });

    const textareaContainer = contentEl.createDiv({ cls: "places-textarea" });
     
    const textarea = textareaContainer.createEl("textarea", { attr: { spellcheck: "false", placeholder: "Paste GPX, GeoJSON, or CSV content here or select a file from below" } });

    textarea.addEventListener("input", (e) => {
      this.input = (e.target as HTMLTextAreaElement).value;

      if (this.input) {
        this.fileType = this.detectFileType(this.input);
        this.updateMultiTrackOptions();
      }
    });

    new Setting(contentEl)
      .setName("Select file")
       
      .setDesc("Choose a GPX, GeoJSON, or CSV file from this device")
      .addButton((btn) =>
        btn
          .setButtonText("Choose file")
          .onClick(() => {
            const input = contentEl.createEl("input");
            input.hidden = true;
            input.type = "file";
            if (Platform.isMobile) {
              // Mobile browsers (especially iOS) are restrictive with custom file types.
              // */* allows selecting any file; content is validated after reading.
              input.accept = "*/*";
            } else {
              input.accept = ".gpx,.geojson,.json,.csv,application/gpx+xml,application/geo+json,application/json,text/csv,text/xml,application/xml";
            }
            input.onchange = (e) => {
              void (async () => {
                const file = (e.target as HTMLInputElement).files?.[0];
                if (file) {
                  const content = await file.text();
                  textarea.value = content;
                  this.input = content;
                  this.sourceFilename = file.name;

                  const fileName = file.name.toLowerCase();
                  if (fileName.endsWith('.gpx')) {
                    this.fileType = 'gpx';
                  } else if (fileName.endsWith('.geojson') || fileName.endsWith('.json')) {
                    this.fileType = 'geojson';
                  } else if (fileName.endsWith('.csv')) {
                    this.fileType = 'csv';
                  } else {
                    this.fileType = this.detectFileType(content);
                  }

                  this.updateMultiTrackOptions();
                }
              })();
            };
            input.click();
          }));

    this.multiTrackModeContainer = new Setting(contentEl)
      .setName("Multi-track handling")
      .setDesc("How to handle files with multiple tracks/features")
      .settingEl;
    this.multiTrackModeContainer.addClass("places-hidden");

    this.importModeContainer = new Setting(contentEl)
      .setName("Import destination")
      .setDesc("Choose where to import the track data")
      .settingEl;

    this.updateImportModeDropdown();

    this.validationDiv = contentEl.createDiv();

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("Import")
          .setCta()
          .onClick(() => {
            const result = this.parseInput(this.input);
            if (!result) return;

            this.onSubmit(result, this.importMode, undefined, this.sourceFilename);
            this.close();
          }));
  }

  private detectFileType(content: string): FileType {
    if (!content || content.trim().length === 0) {
      return "unknown";
    }

    const format = overlayFormatFromContent(content);
    return format === 'gpx' || format === 'geojson' || format === 'csv' ? format : 'unknown';
  }

  private updateMultiTrackOptions() {
    if (!this.multiTrackModeContainer || !this.importModeContainer) return;

    const showOptions = this.fileType === "gpx" || this.fileType === "geojson";
    this.multiTrackModeContainer.toggleClass("places-hidden", !showOptions);

    if (showOptions) {
      const isGeoJson = this.fileType === "geojson";
      const currentMode = isGeoJson ? this.geoJsonImportMode : this.gpxImportMode;

      const parent = this.multiTrackModeContainer.parentElement!;
      this.multiTrackModeContainer.remove();

      const setting = new Setting(parent);
      this.multiTrackModeContainer = setting
        .setName(isGeoJson ? "Multi-feature handling" : "Multi-track handling")
        .setDesc(isGeoJson
          ? "How to handle GeoJSON files with multiple features"
          : "How to handle GPX files with multiple tracks")
        .addDropdown((dropdown) =>
          dropdown
            .addOption("combined", "Import as one note")
            .addOption("separate", "Import as separate notes")
            .setValue(currentMode)
            .onChange((value: string) => {
              const mode = value as MultiTrackMode;
              if (isGeoJson) {
                this.geoJsonImportMode = mode;
              } else {
                this.gpxImportMode = mode;
              }
            }))
        .settingEl;

      parent.insertBefore(this.multiTrackModeContainer, this.importModeContainer);
    }
  }

  private updateImportModeDropdown() {
    if (!this.importModeContainer) return;

    const setting = new Setting(this.importModeContainer.parentElement!);
    this.importModeContainer.remove();
    this.importModeContainer = setting
      .setName("Import destination")
      .setDesc("Choose where to import the track data")
      .addDropdown((dropdown) => {
        if (this.hasActiveFile) {
          dropdown.addOption("current", "Overwrite current note");
        }
        dropdown.addOption("new", "Create new note in same folder");

        dropdown.setValue(this.importMode);
        dropdown.onChange((value: string) => {
          this.importMode = value as ImportMode;
        });
      })
      .settingEl;
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }

  parseInput(input: string): OverlayImportResult[] | undefined {
    this.validationDiv.textContent = "";
    this.validationDiv.className = "";

    if (this.fileType === "unknown") {
      this.fileType = this.detectFileType(input);
    }

    switch (this.fileType) {
      case "gpx":
        return this.parseGpx(input);
      case "geojson":
        return this.parseGeoJson(input);
      case "csv":
        return this.parseCsv(input);
      default:
         
        this.validationDiv.textContent = "Unrecognized content. Expected GPX, GeoJSON, or CSV.";
        this.validationDiv.classList.add("places-validation-error");
        return undefined;
    }
  }

  private parseGpx(input: string): OverlayImportResult[] | undefined {
    if (this.gpxImportMode === "combined") {
      const results = this.overlayImportService.parseGpxForImport(input);

      if (!results || results.length === 0) {
         
        this.validationDiv.textContent = "No tracks or routes found.";
        this.validationDiv.classList.add("places-validation-error");
        return undefined;
      }

      const result = results[0];
      const trackCount = result.sourceTrackCount ?? 1;
      if (trackCount > 1) {
        this.validationDiv.textContent = `Found ${trackCount} tracks in GPX file. All will be merged into one note.`;
        this.validationDiv.classList.add("places-validation-info");
      }

      return results;
    } else {
      const results = this.overlayImportService.parseGpxTracksAsSeparate(input);

      if (!results || results.length === 0) {
         
        this.validationDiv.textContent = "No tracks or routes found.";
        this.validationDiv.classList.add("places-validation-error");
        return undefined;
      }

      this.validationDiv.textContent = `Found ${results.length} tracks in GPX file. Each will be imported as a separate note.`;
      this.validationDiv.classList.add("places-validation-info");

      return results;
    }
  }

  private parseGeoJson(input: string): OverlayImportResult[] | undefined {
    if (this.geoJsonImportMode === "combined") {
      const results = this.overlayImportService.combineGeoJsonFeatures(input);

      if (results.length === 0) {
        this.validationDiv.textContent = "Invalid GeoJSON: no features found.";
        this.validationDiv.classList.add("places-validation-error");
        return undefined;
      }

      const featureCount = results[0].sourceTrackCount ?? 1;
      if (featureCount > 1) {
        this.validationDiv.textContent = `Found ${featureCount} features in GeoJSON file. All will be stored in one note.`;
        this.validationDiv.classList.add("places-validation-info");
      }

      return results;
    } else {
      const results = this.overlayImportService.parseGeoJsonForImport(input);

      if (results.length === 0) {
        this.validationDiv.textContent = "Invalid GeoJSON: no features found.";
        this.validationDiv.classList.add("places-validation-error");
        return undefined;
      }

      this.validationDiv.textContent = `Found ${results.length} features in GeoJSON file. Each will be imported as a separate note.`;
      this.validationDiv.classList.add("places-validation-info");

      return results;
    }
  }

  private parseCsv(input: string): OverlayImportResult[] | undefined {
    const results = this.overlayImportService.parseCsvForImport(input);

    if (results.length === 0) {
      this.validationDiv.textContent = "Invalid CSV format. CSV must have latitude and longitude columns, and optionally an elevation column.";
      this.validationDiv.classList.add("places-validation-error");
      return undefined;
    }

    this.validationDiv.textContent = `Found ${results[0].totalPoints} points in CSV file.`;
    this.validationDiv.classList.add("places-validation-info");

    return results;
  }
}
