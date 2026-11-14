import { App, CliData, Platform, Plugin, TFile, normalizePath } from "obsidian";
import { IPlacesPluginSettings } from "places-shared/settings";
import { OverlayImportService } from 'places/core';
import { TrackImportController } from "./TrackImportController";

interface NodeFileSystemPromises { readFile(path: string, encoding: "utf8" | "base64"): Promise<string>; }
interface DesktopModuleLoader { (moduleName: "fs/promises"): NodeFileSystemPromises; }
type ImportMode = "combined" | "separate";

export class CliController {
  constructor(private readonly app: App, private readonly overlays: OverlayImportService, private readonly tracks: TrackImportController, private readonly getSettings: () => IPlacesPluginSettings) {}

  register(plugin: Plugin): void {
    plugin.registerCliHandler("places:import-gpx", "Import a GPX or FIT file into Places track notes", {
      "source-path": { value: "<path>", description: "Filesystem path to the GPX or FIT file to import", required: true },
      "target-folder": { value: "<folder>", description: "Vault-relative folder where imported notes should be created" },
      mode: { value: "<combined|separate>", description: "Import all GPX tracks into one note or one note per track; a FIT activity is always one note" },
      website: { value: "<url>", description: "Original website URL to write to the Website property and use as an import identity" },
    }, async (params) => this.importGpx(params));
  }

  private async importGpx(params: CliData): Promise<string> {
    const sourcePath = this.requiredString(params, "source-path");
    const filename = sourcePath.replace(/\\/g, "/").split("/").pop() ?? "";
    const isFit = filename.toLowerCase().endsWith(".fit");

    if (!isFit && !filename.toLowerCase().endsWith(".gpx")) throw new Error(`Expected a .gpx or .fit file, got: ${filename}`);
    const targetFolder = this.optionalString(params, "target-folder");
    const mode = isFit ? "combined" : this.resolveMode(params);
    const website = this.optionalString(params, "website");
    const existing = website ? this.findByWebsite(website) : null;

    if (existing) return JSON.stringify(this.result(sourcePath, targetFolder, mode, website, [], [{ path: existing.path, reason: "website" }]));

    const content = await this.readFile(sourcePath, isFit);
    const imports = isFit
      ? this.overlays.parseFitForImport(content)
      : mode === "separate" ? this.overlays.parseGpxTracksAsSeparate(content) : this.overlays.parseGpxForImport(content);

    if (imports.length === 0) throw new Error(`Invalid ${isFit ? "FIT" : "GPX"} format or no track points found: ${sourcePath}`);
    const createdFiles: Array<{ path: string; basename: string }> = [];
    const skippedFiles: Array<{ path: string; reason: string }> = [];

    for (const result of imports) {
      const imported = await this.tracks.createCliTrackNote(result, filename, targetFolder, website);

      if (imported.createdFile) createdFiles.push({ path: imported.createdFile.path, basename: imported.createdFile.basename });
      if (imported.skippedPath) skippedFiles.push({ path: imported.skippedPath, reason: "exists" });
    }

    return JSON.stringify(this.result(sourcePath, targetFolder, mode, website, createdFiles, skippedFiles));
  }

  private result(sourcePath: string, targetFolder: string | undefined, mode: ImportMode, website: string | undefined, createdFiles: Array<{ path: string; basename: string }>, skippedFiles: Array<{ path: string; reason: string }>) {
    return { sourcePath, targetFolder: normalizePath(targetFolder ?? ""), mode, website, createdFiles, skippedFiles };
  }

  private findByWebsite(website: string): TFile | null {
    for (const file of this.app.vault.getMarkdownFiles()) {
      const value: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.["Website"];

      if (typeof value === "string" && value.trim() === website) return file;
      if (Array.isArray(value) && value.some((entry) => typeof entry === "string" && entry.trim() === website)) return file;
    }

    return null;
  }

  private resolveMode(params: CliData): ImportMode {
    const mode = this.optionalString(params, "mode");

    if (mode === "combined" || mode === "single-note") return "combined";
    if (mode === "separate" || mode === "one-per-track") return "separate";
    if (mode) throw new Error(`Invalid --mode value "${mode}". Expected combined or separate.`);
    const setting = this.getSettings().gpxImportMode;

    if (setting === "one-per-track") return "separate";
    if (setting === "disabled") throw new Error("GPX import is disabled in Places settings. Pass --mode combined or --mode separate to import anyway.");

    return "combined";
  }

  private requiredString(params: CliData, key: string): string {
    const value = this.optionalString(params, key);

    if (!value) throw new Error(`Missing required CLI flag: --${key}`);

    return value;
  }

  private optionalString(params: CliData, key: string): string | undefined {
    const value = params[key];

    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  private async readFile(path: string, isFit: boolean): Promise<string> {
    if (!Platform.isDesktop) throw new Error("Filesystem track imports require Obsidian desktop.");
    const require = (activeWindow as Window & { require?: DesktopModuleLoader }).require;

    if (!require) throw new Error("Node filesystem access is unavailable.");

    return require("fs/promises").readFile(path, isFit ? "base64" : "utf8");
  }
}
