import { Command, Editor, MarkdownFileInfo, MarkdownView, Notice, Plugin, TFile } from "obsidian";
import { OverlayCacheRebuilder, rebuildOverlayCacheForFile } from "../services/OverlayCacheRebuilder";
import { Place } from "places-shared/place";
import { IPlacesPluginSettings } from "places-shared/settings";
import { parseCoordinate } from "places-shared/geo";
import { logger as rootLogger } from "places-shared/utils";
import { DecodeOverlayFieldModal } from "../modals/DecodeOverlayFieldModal";
import { CompressionLevelModal } from "../modals/CompressionLevelModal";
import { ImportTrackModal } from "../modals/ImportTrackModal";
import { PlaceSearchModal } from "../modals/PlaceSearchModal";
import { ReverseGeocodeModal } from "../modals/ReverseGeocodeModal";
import { AggregatorApiService } from "../places-services/AggregatorApiService";
import { OverlayRecompressor } from "../services/OverlayRecompression";
import { TrackImportController } from "./TrackImportController";

// A palette command plus the help line the main help page renders for it.
export interface CommandHelpEntry {
  name: string;
  description: string;
}

type DescribedCommand = Command & { description: string };

export class CommandRegistrar {
  private commands: DescribedCommand[] = [];

  constructor(
    private readonly plugin: Plugin,
    private readonly placesFor: (sourcePath: string) => AggregatorApiService,
    private readonly tracks: TrackImportController,
    private readonly getSettings: () => IPlacesPluginSettings,
    private readonly syncFileWithPlace: (file: TFile, place: Place) => Promise<void>,
  ) {}

  // In registration order; the source the help page lists.
  getCommandHelp(): readonly CommandHelpEntry[] {
    return this.commands.map(({ name, description }) => ({ name, description }));
  }

  register(): void {
    this.plugin.addRibbonIcon("map-pin", "Search for place", () => this.searchActiveFile());

    this.commands = [
      {
        id: "search-place",
        name: "Search for place by name",
        description: "find a location and add it to the current note",
        editorCallback: (editor: Editor, context: MarkdownView | MarkdownFileInfo) => {
          if (context.file) this.search(context.file, editor);
        },
      },
      {
        id: "search-place-by-coordinates",
        name: "Search for place by coordinates",
        description: "reverse geocode coordinates to find a place",
        editorCallback: (_editor: Editor, context: MarkdownView | MarkdownFileInfo) => {
          if (!context.file) return;
          const initial = parseCoordinate(context.file.basename);

          new ReverseGeocodeModal(
            this.plugin.app,
            this.placesFor(context.file.path),
            this.getSettings().units,
            (place) => void this.syncFileWithPlace(context.file!, place),
            initial ?? undefined,
          ).open();
        },
      },
      {
        id: "import-track-data",
        name: "Import track data (GPX/GeoJSON/CSV)",
        description: "create track notes from files, combined or one note per track",
        callback: () => {
          const activeFile = this.plugin.app.workspace.getActiveFile();
          const settings = this.getSettings();

          new ImportTrackModal(
            this.plugin.app,
            (results, mode, folder, filename) => void this.tracks.importTracks(results, mode, activeFile, folder, filename),
            Boolean(activeFile),
            settings.gpxImportMode === "one-per-track" ? "separate" : "combined",
            settings.geoJsonImportMode === "one-per-feature" ? "separate" : "combined",
          ).open();
        },
      },
      {
        id: "export-gpx-file",
        name: "Export to GPX file",
        description: "save the current track note's data as a GPX file",
        editorCallback: async (_editor, context) => { if (context.file) await this.tracks.exportGpx(context.file); },
      },
      {
        id: "export-geojson-file",
        name: "Export to GeoJSON file",
        description: "save the current track note's data as a GeoJSON file",
        editorCallback: async (_editor, context) => { if (context.file) await this.tracks.exportGeoJson(context.file); },
      },
      {
        id: "recalculate-track-stats",
        name: "Recalculate track stats from GPX data",
        description: "recompute the current track note's frontmatter stats from its stored overlay data",
        editorCallback: async (_editor, context) => { if (context.file) await this.tracks.recalculateStats(context.file); },
      },
      {
        id: "rebuild-overlay-cache",
        name: "Rebuild overlay cache",
        description: "re-derive the current note's Overlay Cache from its Overlay Source",
        editorCallback: async (_editor, context) => { if (context.file) await rebuildOverlayCacheForFile(this.plugin.app, context.file); },
      },
      {
        id: "rebuild-overlay-caches",
        name: "Rebuild all overlay caches",
        description: "re-derive every note's Overlay Cache from its Overlay Source",
        callback: () => { void new OverlayCacheRebuilder(this.plugin.app).run(); },
      },
      {
        id: "recompress-overlay-data",
        name: "Recompress all overlay data",
        description: "rewrite every Overlay Source and Overlay Cache at a chosen compression level and report the bytes saved",
        callback: () => {
          new CompressionLevelModal(this.plugin.app, (level) => {
            void new OverlayRecompressor(this.plugin.app, level).run();
          }).open();
        },
      },
      {
        id: "strip-overlay-timestamps",
        name: "Strip overlay timestamps",
        description: "remove per-point timestamps from the current note's overlay data",
        editorCallback: async (_editor, context) => { if (context.file) await this.tracks.stripOverlayData(context.file, true); },
      },
      {
        id: "strip-overlay-to-polyline",
        name: "Strip overlay to polyline",
        description: "reduce the current note's overlay data to coordinates only",
        editorCallback: async (_editor, context) => { if (context.file) await this.tracks.stripOverlayData(context.file, false); },
      },
      {
        id: "decode-overlay-source",
        name: "Decode overlay source",
        description: "show the current note's Overlay Source decoded",
        callback: () => new DecodeOverlayFieldModal(this.plugin.app, "Overlay Source", this.plugin.app.workspace.getActiveFile() ?? undefined).open(),
      },
      {
        id: "decode-overlay-cache",
        name: "Decode overlay cache",
        description: "show the current note's Overlay Cache decoded",
        callback: () => new DecodeOverlayFieldModal(this.plugin.app, "Overlay Cache", this.plugin.app.workspace.getActiveFile() ?? undefined).open(),
      },
      {
        id: "copy-debug-log",
        name: "Copy debug log to clipboard",
        description: "copy recent log entries for a bug report",
        callback: async () => {
          try {
            new Notice(`Debug log copied (${await rootLogger.copyToClipboard()} entries)`, 3000);
          } catch (error) {
            rootLogger.scope("DebugLog").error("Failed to copy debug log", error);
            new Notice("Failed to copy debug log", 5000);
          }
        },
      },
    ];

    for (const entry of this.commands) {
      const { description, ...command } = entry;

      void description;
      this.plugin.addCommand(command);
    }
  }

  private searchActiveFile(): void {
    const file = this.plugin.app.workspace.getActiveFile();

    if (!file) {
      new Notice("No active file.");

      return;
    }

    const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);

    if (!view) {
      new Notice("No active editor.");

      return;
    }

    this.search(file, view.editor);
  }

  private search(file: TFile, editor: Editor): void {
    const selection = editor.getSelection().trim();

    new PlaceSearchModal(this.plugin.app, this.placesFor(file.path), selection || file.basename, (place) => {
      void this.syncFileWithPlace(file, place);
    }).open();
  }
}
