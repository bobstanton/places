import { type IPlacesPluginSettings } from "places-shared/settings";
import { bytesToBase64, getErrorMessage, logger } from "places-shared/utils";
import { App, Notice, Platform, TFile, normalizePath } from "obsidian";
import { OverlayImportService } from 'places/core';
import { OverlayImportResult } from 'places/core';
import { ImportErrorHandler } from "./services/ImportErrorHandler";
import { ensureVaultFolder, getAvailableVaultPath, resolveNewNoteFolder } from "places-shared/obsidian/utils";
import { serializeTrackDocumentToGpx, type TrackDocumentModel } from 'places/core';
import { assignFrontmatter } from "places-shared/services";

interface FileWithPath {
  file: File;
  // Relative path from dropped folder (e.g., "subfolder/file.gpx" or just "file.gpx" for root files)
  relativePath: string;
}

export class DragDropHandler {
  private app: App;
  private overlayImportService: OverlayImportService;
  private getSettings: () => IPlacesPluginSettings;
  private dragLeaveCleanupTimeout?: number;

  constructor(app: App, overlayImportService: OverlayImportService, getSettings: () => IPlacesPluginSettings) {
    this.app = app;
    this.overlayImportService = overlayImportService;
    this.getSettings = getSettings;
  }

  handleEditorDrop(evt: DragEvent): boolean {
    if (!this.claimTrackDrop(evt)) return false;

    const activeFile = this.app.workspace.getActiveFile();
    const targetFolder = activeFile?.parent?.path;
    const targetFile = this.getSettings().importDropOnNote === 'update' ? activeFile ?? undefined : undefined;

    this.processDropDataTransfer(evt.dataTransfer, targetFolder, targetFile);

    return true;
  }

  handleDrop(evt: DragEvent) {
    if (!this.claimTrackDrop(evt)) return;

    let targetFolder: string | undefined;
    let targetFile: TFile | undefined;
    const target = evt.target as HTMLElement;

    const navFile = this.getNavFileFromTarget(target);

    if (navFile) {
      targetFolder = navFile.parent?.path;
    }

    if (this.getSettings().importDropOnNote === 'update') {
      // Editor drops: capture-phase handler runs before Obsidian's editor-drop event,
      // and handleEditorDrop() never fires for track files. Detect editor area here.
      if (!targetFile && (target.closest('.cm-editor') || target.closest('.markdown-source-view'))) {
        const activeFile = this.app.workspace.getActiveFile();

        if (activeFile) {
          targetFile = activeFile;
          targetFolder = activeFile.parent?.path;
        }
      }
    }

    if (!targetFolder) {
      const folderEl = target.closest('.nav-folder');

      if (folderEl) {
        const folderTitle = folderEl.querySelector('.nav-folder-title');

        if (folderTitle) {
          const folderPath = (folderTitle as HTMLElement).dataset?.path || folderTitle.getAttribute('data-path');

          if (folderPath) {
            targetFolder = folderPath;
          }
        }
      }
    }

    targetFolder ??= this.app.workspace.getActiveFile()?.parent?.path;

    this.processDropDataTransfer(evt.dataTransfer, targetFolder, targetFile);
  }

  private claimTrackDrop(evt: DragEvent): boolean {
    if (this.bypassImportForCopy(evt)) return false;
    if (!this.hasTrackFiles(evt.dataTransfer)) return false;
    evt.preventDefault();
    evt.stopPropagation();
    evt.stopImmediatePropagation();
    this.cleanupDragOverClasses();

    return true;
  }

  private bypassImportForCopy(evt: DragEvent): boolean {
    const copy = Platform.isMacOS ? evt.altKey : evt.ctrlKey;

    if (copy && this.dragLeaveCleanupTimeout !== undefined) {
      window.clearTimeout(this.dragLeaveCleanupTimeout);
      this.dragLeaveCleanupTimeout = undefined;
    }

    return copy;
  }

  private processDropDataTransfer(dataTransfer: DataTransfer | null, targetFolder: string | undefined, targetFile: TFile | undefined): void {
    this.getTrackFilesAsync(dataTransfer)
      .then(trackFiles => {
        if (trackFiles.length === 0) {
          new Notice("No track files found in the dropped items");

          return;
        }

        return this.processDroppedTrackFiles(trackFiles, targetFolder, targetFile);
      })
      .catch(error => {
        logger.error("Places Plugin: Error processing track files:", error);
        new Notice("Error processing track files: " + getErrorMessage(error));
      })
      .finally(() => {
        this.cleanupDragOverClasses();
      });
  }

  private getNavFileFromTarget(target: HTMLElement): TFile | undefined {
    const fileEl = target.closest('.nav-file');

    if (!fileEl) {
      return undefined;
    }

    const fileTitle = fileEl.querySelector('.nav-file-title');

    if (!fileTitle) {
      return undefined;
    }

    const filePath = (fileTitle as HTMLElement).dataset?.path || fileTitle.getAttribute('data-path');

    if (!filePath?.endsWith('.md')) {
      return undefined;
    }

    return this.app.vault.getFileByPath(normalizePath(filePath)) ?? undefined;
  }

  handleDragOver(evt: DragEvent) {
    if (this.bypassImportForCopy(evt)) return;

    if (this.hasTrackFiles(evt.dataTransfer)) {
      evt.preventDefault();
      evt.stopPropagation();
      evt.stopImmediatePropagation();

      if (evt.dataTransfer) {
        evt.dataTransfer.dropEffect = 'move';
      }
    }
  }

  handleDragEnter(evt: DragEvent) {
    if (this.bypassImportForCopy(evt)) return;

    if (this.hasTrackFiles(evt.dataTransfer)) {
      evt.preventDefault();
      evt.stopPropagation();
      evt.stopImmediatePropagation();
    }
  }

  handleDragLeave(evt: DragEvent) {
    if (this.bypassImportForCopy(evt)) return;

    if (this.hasTrackFiles(evt.dataTransfer)) {
      evt.preventDefault();
      evt.stopPropagation();
      evt.stopImmediatePropagation();
    }

    if (this.dragLeaveCleanupTimeout !== undefined) window.clearTimeout(this.dragLeaveCleanupTimeout);
    this.dragLeaveCleanupTimeout = window.setTimeout(() => {
      this.dragLeaveCleanupTimeout = undefined;
      this.cleanupDragOverClasses();
    }, 100);
  }

  private cleanupDragOverClasses() {
    const draggedOverElements = activeDocument.querySelectorAll('.is-being-dragged-over');

    draggedOverElements.forEach(el => {
      el.removeClass('is-being-dragged-over');
    });

    const navFolders = activeDocument.querySelectorAll('.nav-folder.is-being-dragged-over');

    navFolders.forEach(el => {
      el.removeClass('is-being-dragged-over');
    });
  }

  // Read during dragover/dragenter, where the decision must be synchronous.
  private hasTrackFiles(dataTransfer: DataTransfer | null): boolean {
    if (!dataTransfer) return false;

    if (dataTransfer.items) {
      for (const item of Array.from(dataTransfer.items)) {
        if (item.kind === 'file') {
          const entry = item.webkitGetAsEntry?.();

          if (entry?.isDirectory) {
            // Could contain track files - allow the drop
            return true;
          }

          const file = item.getAsFile();

          if (file && this.isTrackFile(file.name)) {
            return true;
          }
        }
      }
    }

    if (dataTransfer.files) {
      for (const file of Array.from(dataTransfer.files)) {
        if (this.isTrackFile(file.name)) {
          return true;
        }

        if (file.type === '' && file.size === 0) {
          return true; // Could be a folder with track files
        }
      }
    }

    return false;
  }

  private isTrackFile(name: string): boolean {
    const lower = name.toLowerCase();

    return lower.endsWith('.gpx') || lower.endsWith('.fit') || lower.endsWith('.geojson') || lower.endsWith('.csv');
  }

  private async getTrackFilesAsync(dataTransfer: DataTransfer | null): Promise<FileWithPath[]> {
    if (!dataTransfer) return [];

    const trackFiles: FileWithPath[] = [];

    // Use DataTransferItemList with webkitGetAsEntry for folder support
    if (dataTransfer.items) {
      const entries: FileSystemEntry[] = [];

      for (const item of Array.from(dataTransfer.items)) {
        if (item.kind === 'file') {
          const entry = item.webkitGetAsEntry?.();

          if (entry) {
            entries.push(entry);
          }
        }
      }

      for (const entry of entries) {
        const files = await this.readEntry(entry, '');

        trackFiles.push(...files);
      }
    }

    if (trackFiles.length === 0 && dataTransfer.files) {
      for (const file of Array.from(dataTransfer.files)) {
        // Skip directories
        if (file.type === '' && file.size === 0) {
          continue;
        }

        if (this.isTrackFile(file.name)) {
          trackFiles.push({ file, relativePath: file.name });
        }
      }
    }

    return trackFiles;
  }

  // basePath is the path from the dropped folder root to this entry's parent.
  private async readEntry(entry: FileSystemEntry, basePath: string): Promise<FileWithPath[]> {
    if (entry.isFile) {
      const fileEntry = entry as FileSystemFileEntry;

      return new Promise((resolve) => {
        fileEntry.file(
          (file) => {
            if (this.isTrackFile(file.name)) {
              const relativePath = basePath ? `${basePath}/${file.name}` : file.name;

              resolve([{ file, relativePath }]);
            } else {
              resolve([]);
            }
          },
          () => resolve([]) // Error reading file
        );
      });
    } else if (entry.isDirectory) {
      const dirEntry = entry as FileSystemDirectoryEntry;
      const reader = dirEntry.createReader();
      const newBasePath = basePath ? `${basePath}/${entry.name}` : entry.name;

      return new Promise((resolve) => {
        const allFiles: FileWithPath[] = [];

        const readEntries = () => {
          reader.readEntries(
            (entries) => {
              if (entries.length === 0) {
                resolve(allFiles);
              } else {
                void (async () => {
                  for (const subEntry of entries) {
                    const files = await this.readEntry(subEntry, newBasePath);

                    allFiles.push(...files);
                  }

                  // Continue reading (readEntries may not return all entries at once)
                  readEntries();
                })();
              }
            },
            () => resolve(allFiles) // Error reading directory
          );
        };

        readEntries();
      });
    }

    return [];
  }

  private async processDroppedTrackFiles(filesWithPaths: FileWithPath[], targetFolder?: string, targetFile?: TFile) {
    let successCount = 0;
    let failCount = 0;
    const errors: string[] = [];

    const settings = this.getSettings();
    const gpxImportMode = settings.gpxImportMode;
    const fitImportMode = settings.fitImportMode;
    const geoJsonImportMode = settings.geoJsonImportMode;
    const csvImportMode = settings.csvImportMode;

    for (const { file, relativePath } of filesWithPaths) {
      try {
        const fileName = file.name.toLowerCase();
        const content = fileName.endsWith('.fit')
          ? bytesToBase64(new Uint8Array(await file.arrayBuffer()))
          : await file.text();
        let results: OverlayImportResult[] = [];
        let errorMessage = "";

        const lastSlash = relativePath.lastIndexOf('/');
        const relativeFolder = lastSlash > 0 ? relativePath.substring(0, lastSlash) : undefined;

        if (fileName.endsWith(".gpx")) {
          if (gpxImportMode === "disabled") {
            continue;
          } else if (gpxImportMode === "one-per-track") {
            results = this.overlayImportService.parseGpxTracksAsSeparate(content);

            if (results && results.length > 0) {
              const allWaypoints = results.flatMap(r => r.waypoints ?? []);
              const parsedDocument = results[0].parsedDocument;

              if (allWaypoints.length > 0 && parsedDocument) {
                await this.createWaypointsNote(file.name, targetFolder, parsedDocument, relativeFolder);
                successCount++;

                results.forEach(result => {
                  result.waypoints = [];
                });
              }
            }

            errorMessage = "No tracks or routes found";
          } else {
            results = this.overlayImportService.parseGpxForImport(content);
            errorMessage = "No tracks or routes found";
          }
        } else if (fileName.endsWith(".fit")) {
          if (fitImportMode === "disabled") {
            continue;
          }

          results = this.overlayImportService.parseFitForImport(content);
          errorMessage = "No position records found";
        } else if (fileName.endsWith(".geojson")) {
          if (geoJsonImportMode === "disabled") {
            continue;
          } else if (geoJsonImportMode === "single-note") {
            results = this.overlayImportService.combineGeoJsonFeatures(content);
            errorMessage = "Invalid GeoJSON format or no features found";
          } else {
            results = this.overlayImportService.parseGeoJsonForImport(content);
            errorMessage = "Invalid GeoJSON format or no features found";
          }
        } else if (fileName.endsWith(".csv")) {
          if (csvImportMode === "disabled") {
            continue;
          } else {
            results = this.overlayImportService.parseCsvForImport(content);
            errorMessage = "Invalid CSV format";
          }
        }

        if (results.length > 0) {
          for (let i = 0; i < results.length; i++) {
            if (i === 0 && targetFile) {
              await this.updateExistingNote(targetFile, results[i]);
            } else {
              const folder = targetFile ? targetFile.parent?.path : targetFolder;

              await this.createNoteFromImport(results[i], file.name, folder, relativeFolder);
            }

            successCount++;
          }

          targetFile = undefined;
        } else {
          failCount++;
          errors.push(file.name + ": " + errorMessage);
        }
      } catch (error) {
        failCount++;
        errors.push(file.name + ": " + getErrorMessage(error));
      }
    }

    ImportErrorHandler.handleBatchImportResult(successCount, failCount, errors);
  }

  private async updateExistingNote(targetFile: TFile, result: OverlayImportResult): Promise<void> {
    const generatedFrontmatter = this.overlayImportService.buildImportFrontmatter(result, {
      name: targetFile.basename,
      path: targetFile.path,
    });

    await this.app.fileManager.processFrontMatter(targetFile, (frontmatter: Record<string, unknown>) => {
      const existingIcon = typeof frontmatter.icon === 'string' && frontmatter.icon.trim() !== ''
        ? frontmatter.icon
        : undefined;

      assignFrontmatter(frontmatter, generatedFrontmatter);
      if (existingIcon !== undefined) frontmatter.icon = existingIcon;
    });
  }

  private async createNoteFromImport(result: OverlayImportResult, filename: string, targetFolder?: string, relativeFolder?: string): Promise<void> {
    const noteName = this.overlayImportService.formatOverlayNoteName(result, filename);
    const baseFolder = this.resolveTargetFolder(targetFolder);
    const folderPath = relativeFolder
      ? (baseFolder ? `${baseFolder}/${relativeFolder}` : relativeFolder)
      : baseFolder;
    const notePath = folderPath ? `${folderPath}/${noteName}.md` : `${noteName}.md`;
    const finalPath = await this.getUniqueNotePath(notePath);

    const noteContent = "";

    try {
      const newFile = await this.app.vault.create(normalizePath(finalPath), noteContent);

      const generatedFrontmatter = this.overlayImportService.buildImportFrontmatter(result, {
        name: noteName,
        path: finalPath,
      });

      await this.app.fileManager.processFrontMatter(newFile, (frontmatter: Record<string, unknown>) => {
        assignFrontmatter(frontmatter, generatedFrontmatter);
      });
    } catch (error) {
      logger.error(error);

      throw error;
    }
  }

  private async createWaypointsNote(filename: string, targetFolder: string | undefined, parsedDocument: TrackDocumentModel, relativeFolder?: string): Promise<void> {
    const baseName = filename.replace(/\.gpx$/i, '');
    const waypointsNoteName = `${baseName} - Waypoints`;
    const baseFolder = this.resolveTargetFolder(targetFolder);
    const folderPath = relativeFolder
      ? (baseFolder ? `${baseFolder}/${relativeFolder}` : relativeFolder)
      : baseFolder;
    const notePath = folderPath ? `${folderPath}/${waypointsNoteName}.md` : `${waypointsNoteName}.md`;
    const finalPath = await this.getUniqueNotePath(notePath);

    try {
      const newFile = await this.app.vault.create(normalizePath(finalPath), "");

      const waypointsOnly: TrackDocumentModel = { ...parsedDocument, tracks: [], routes: [] };
      const waypointsOnlyGpx = serializeTrackDocumentToGpx(waypointsOnly);

      const precomputeCache = this.getSettings().precomputeOverlayCache;
      const overlayFields = OverlayImportService.buildOverlayFields(waypointsOnlyGpx, 'gpx', precomputeCache, waypointsOnly);

      await this.app.fileManager.processFrontMatter(newFile, (frontmatter: Record<string, unknown>) => {
        assignFrontmatter(frontmatter, overlayFields);
      });
    } catch (error) {
      logger.error(error);

      throw error;
    }
  }

  // An explicit drop target wins; otherwise the shared new-note folder policy.
  private resolveTargetFolder(targetFolder?: string): string {
    return targetFolder ?? resolveNewNoteFolder(this.app);
  }

  private async getUniqueNotePath(notePath: string): Promise<string> {
    await ensureVaultFolder(this.app, notePath);

    return getAvailableVaultPath(this.app, notePath);
  }
}
