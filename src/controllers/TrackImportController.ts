import { App, Notice, TFile, normalizePath } from "obsidian";
import { collectGeoJsonGeometryParts, isGeoJsonFeature, isGeoJsonFeatureCollection } from "places-shared/geo";
import { PolylineCodec } from "places-shared/track";
import { StringCompressor, PLACES_EXPORTS_FOLDER, getErrorMessage, logger as rootLogger, scalarToString } from "places-shared/utils";
import { downloadOrCopy, ensureVaultFolder, getAvailableVaultPath } from "places-shared/obsidian/utils";
import { parseCsvCoordinates } from 'places/core';
import { GpxParser, FitParser, trackDocumentPrimaryPoints } from 'places/core';
import { ImportErrorHandler } from "../services/ImportErrorHandler";
import { OverlayImportResult } from 'places/core';
import { OverlayImportService } from 'places/core';
import { convertOverlaySourceToGeoJson, convertOverlaySourceToGpx, detectOverlayFormat } from 'places/core';
import { TrackDataService } from "../services/TrackDataService";
import { assignFrontmatter } from "places-shared/services";
import { TRACK_FILE_EXTENSION_PATTERN } from 'places/core';

const logger = {
  tracks: rootLogger.scope("Tracks"),
  export: rootLogger.scope("Export"),
  import: rootLogger.scope("Import"),
};

export class TrackImportController {
  constructor(private readonly app: App, private readonly trackDataService: TrackDataService, private readonly overlayImportService: OverlayImportService) {}

  async recalculateStats(file: TFile): Promise<void> {
    try {
      const originalSource = scalarToString(this.app.metadataCache.getFileCache(file)?.frontmatter?.["Overlay Source"]);

      if (!originalSource) {
        new Notice("This note doesn't have overlay data. Only notes with overlay source can be recalculated.");

        return;
      }

      // Recalculate from Overlay Source, never the cache: the cache is derived,
      // simplified, map-only geometry that carries no timestamps.
      const trackData = this.trackDataService.extractTrackFromNote(file, { skipCache: true });

      new Notice("Recalculating track statistics...");
      await this.updateFrontmatter(file, this.trackDataService.buildOverlayFrontmatterPreservingSource(trackData, originalSource));
      new Notice("Track statistics recalculated.");
    } catch (error) {
      logger.tracks.error("Error recalculating track stats", error);
      new Notice(`Error recalculating track stats: ${getErrorMessage(error)}`);
    }
  }

  async exportGpx(file: TFile): Promise<void> {
    try {
      const source = scalarToString(this.app.metadataCache.getFileCache(file)?.frontmatter?.["Overlay Source"]);

      if (!source) {
        new Notice("This note doesn't have GPX data to export.");

        return;
      }

      const decoded = StringCompressor.decodeAndDecompress(source);
      const format = detectOverlayFormat(decoded);
      const content = format === "gpx" ? decoded : convertOverlaySourceToGpx(decoded, format, file.basename);

      if (!content) {
        new Notice("This note doesn't have GPX data to export.");

        return;
      }

      await downloadOrCopy({
        app: this.app,
        content,
        filename: `${file.basename}.gpx`,
        mimeType: "application/gpx+xml",
        vaultFallbackFolder: PLACES_EXPORTS_FOLDER,
      });
    } catch (error) {
      logger.export.error("Error exporting GPX file", error);
      new Notice(`Error exporting GPX file: ${getErrorMessage(error)}`);
    }
  }

  async exportGeoJson(file: TFile): Promise<void> {
    try {
      const source = scalarToString(this.app.metadataCache.getFileCache(file)?.frontmatter?.["Overlay Source"]);

      if (!source) {
        new Notice("This note doesn't have overlay source data to export as GeoJSON.");

        return;
      }

      const decoded = StringCompressor.decodeAndDecompress(source);
      const format = detectOverlayFormat(decoded);
      const content = format === "geojson"
        ? decoded
        : JSON.stringify(convertOverlaySourceToGeoJson(decoded, format).geojson, null, 2);

      await downloadOrCopy({
        app: this.app,
        content,
        filename: `${file.basename}.geojson`,
        mimeType: "application/geo+json",
        vaultFallbackFolder: PLACES_EXPORTS_FOLDER,
      });
    } catch (error) {
      logger.export.error("Error exporting GeoJSON file", error);
      new Notice(`Error exporting GeoJSON file: ${getErrorMessage(error)}`);
    }
  }

  async stripOverlayData(file: TFile, keepElevation: boolean): Promise<void> {
    try {
      const source = scalarToString(this.app.metadataCache.getFileCache(file)?.frontmatter?.["Overlay Source"]);

      if (!source) {
        new Notice("This note doesn't have overlay data.");

        return;
      }

      const decoded = StringCompressor.decodeAndDecompress(source);
      const format = detectOverlayFormat(decoded);

      if (format === "polyline") {
        new Notice("Overlay data is already stripped.");

        return;
      }

      const coordinates: Array<{ lat: number; lon: number; ele?: number }> = [];

      if (format === "gpx" || format === "fit") {
        const model = format === "fit" ? FitParser.parseModel(decoded) : GpxParser.parseModel(decoded);

        for (const point of trackDocumentPrimaryPoints(model)) {
          coordinates.push({ lat: point.latitude, lon: point.longitude, ele: keepElevation ? point.elevationMeters : undefined });
        }
      } else if (format === "geojson") {
        const geojson: unknown = JSON.parse(decoded);
        const features = isGeoJsonFeatureCollection(geojson) ? geojson.features : isGeoJsonFeature(geojson) ? [geojson] : [];

        if (features.length === 0) throw new Error("Overlay source does not contain GeoJSON features.");

        for (const feature of features) {
          for (const coordinate of collectGeoJsonGeometryParts(feature.geometry).lines.flat()) {
            coordinates.push({ lat: coordinate[1], lon: coordinate[0], ele: keepElevation ? coordinate[2] : undefined });
          }
        }
      } else if (format === "csv") {
        for (const point of parseCsvCoordinates(decoded).rawPoints) {
          coordinates.push({ lat: point.latitude, lon: point.longitude, ele: keepElevation ? point.elevationMeters : undefined });
        }
      }

      if (coordinates.length === 0) {
        new Notice("No coordinates found in overlay data.");

        return;
      }

      let replacement: string;

      if (keepElevation) {
        if (!coordinates.some((point) => point.ele !== undefined)) {
          new Notice("No elevation data found in overlay. Use 'strip overlay to polyline' instead.");

          return;
        }

        const geometryCoordinates = coordinates.map((point) => point.ele === undefined
          ? [point.lon, point.lat]
          : [point.lon, point.lat, point.ele]);

        replacement = StringCompressor.compressAndEncode(JSON.stringify({
          type: "Feature",
          properties: {},
          geometry: { type: "LineString", coordinates: geometryCoordinates },
        }));
      } else {
        replacement = StringCompressor.compressAndEncode(PolylineCodec.encode(
          coordinates.map((point) => ({ latitude: point.lat, longitude: point.lon })),
        ));
      }

      await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
        frontmatter["Overlay Source"] = replacement;
        delete frontmatter["Overlay Cache"];
      });
      const reduction = ((source.length - replacement.length) / source.length * 100).toFixed(1);
      const action = keepElevation ? "timestamps stripped (elevation preserved)" : "stripped to polyline";

      new Notice(`Overlay data ${action}.\nSize reduced by ${reduction}% (${source.length} -> ${replacement.length} chars)`);
    } catch (error) {
      logger.export.error("Error stripping overlay data", error);
      new Notice(`Failed to strip overlay data: ${getErrorMessage(error)}`);
    }
  }

  async importTracks(results: OverlayImportResult[], importMode: "current" | "new", currentFile: TFile | null, targetFolder?: string, sourceFilename?: string): Promise<void> {
    for (let index = 0; index < results.length; index++) {
      await this.importTrack(results[index], index === 0 ? importMode : "new", currentFile, sourceFilename, targetFolder);
    }

    ImportErrorHandler.handleBatchImportResult(results.length, 0, []);
  }

  async importOverlay(file: TFile, result: OverlayImportResult, createNewNote = false): Promise<void> {
    if (createNewNote) {
      await this.createNewNoteFromImport(file, result);

      return;
    }

    await this.updateFrontmatter(file, this.overlayImportService.buildImportFrontmatter(result, {
      name: file.basename,
      path: file.path,
    }), true);
  }

  async createCliTrackNote(result: OverlayImportResult, sourceFilename: string, targetFolder?: string, website?: string): Promise<{ createdFile?: TFile; skippedPath?: string }> {
    const noteName = this.overlayImportService.formatOverlayNoteName(result, sourceFilename);
    const folder = normalizePath(targetFolder ?? "");
    const path = normalizePath(folder ? `${folder}/${noteName}.md` : `${noteName}.md`);

    if (this.app.vault.getFileByPath(path)) return { skippedPath: path };
    const frontmatter = this.overlayImportService.buildImportFrontmatter(result, { name: noteName, path });

    if (website) frontmatter["Website"] = website;
    await ensureVaultFolder(this.app, path);

    return { createdFile: await this.createNote(path, frontmatter) };
  }

  private async importTrack(result: OverlayImportResult, mode: "current" | "new", currentFile: TFile | null, sourceFilename?: string, targetFolder?: string): Promise<TFile | null> {
    const fallbackName = sourceFilename?.replace(TRACK_FILE_EXTENSION_PATTERN, "") || currentFile?.basename || "Track";
    const noteName = this.overlayImportService.formatOverlayNoteName(result, fallbackName);

    if (mode === "current" && currentFile) {
      const frontmatter = this.overlayImportService.buildImportFrontmatter(result, {
        name: noteName,
        path: currentFile.path,
      });

      await this.updateFrontmatter(currentFile, frontmatter, true);

      if (currentFile.basename !== noteName) {
        try {
          await this.app.fileManager.renameFile(currentFile, await this.uniqueNotePath(noteName, currentFile.parent?.path ?? ""));
        } catch (error) {
          logger.import.error("Failed to rename file", error);
        }
      }

      return currentFile;
    }

    const folder = normalizePath(targetFolder ?? currentFile?.parent?.path ?? "");
    const path = await this.uniqueNotePath(noteName, folder);
    const frontmatter = this.overlayImportService.buildImportFrontmatter(result, { name: noteName, path });

    return this.createNote(path, frontmatter);
  }

  private async uniqueNotePath(noteName: string, folder: string): Promise<string> {
    const path = folder ? `${folder}/${noteName}.md` : `${noteName}.md`;

    await ensureVaultFolder(this.app, path);

    return getAvailableVaultPath(this.app, path);
  }

  private async createNote(path: string, frontmatter: Record<string, unknown>): Promise<TFile> {
    try {
      const file = await this.app.vault.create(normalizePath(path), "");

      await this.updateFrontmatter(file, frontmatter);

      return file;
    } catch (error) {
      logger.import.error("Error creating note", error);
      new Notice(`Error creating note: ${getErrorMessage(error)}`);

      throw error;
    }
  }

  private async createNewNoteFromImport(sourceFile: TFile, result: OverlayImportResult): Promise<void> {
    const noteName = this.overlayImportService.formatOverlayNoteName(result, sourceFile.basename);
    const path = await this.uniqueNotePath(noteName, sourceFile.parent?.path ?? "");

    try {
      const file = await this.app.vault.create(normalizePath(path), result.description ?? "");

      await this.updateFrontmatter(file, this.overlayImportService.buildImportFrontmatter(result, {
        name: noteName,
        path,
      }));
      new Notice(`Created new note: ${file.basename}`);
    } catch (error) {
      logger.import.error("Error creating new note", error);
      new Notice(`Failed to create new note: ${getErrorMessage(error)}`);
    }
  }

  private async updateFrontmatter(file: TFile, values: Record<string, unknown>, preserveExistingIcon = false): Promise<void> {
    await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
      const existingIcon = preserveExistingIcon && scalarToString(frontmatter.icon).trim() !== ''
        ? frontmatter.icon
        : undefined;

      assignFrontmatter(frontmatter, values);
      if (existingIcon !== undefined) frontmatter.icon = existingIcon;
    });
  }
}
