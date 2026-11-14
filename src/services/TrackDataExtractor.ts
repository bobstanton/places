import { logger } from "places-shared/utils";
import { App, TFile, normalizePath } from "obsidian";
import { Coordinate, parseCoordinate } from "places-shared/geo";
import { TrackDataService } from "./TrackDataService";
import { speedWindowCacheToken } from 'places/core';
import { BlockSyntaxError, parseCodeBlock } from 'places/core';
import { parsePlaceSources } from "places-shared/settings";
import { readNormalizedProperty } from "places-shared/utils";

interface CachedTrack {
  path: string;
  mtime: number;
  size: number;
  coordinates: Coordinate[];
}

export class TrackDataExtractor {
  // Shared across instances (similar-tracks and heatmap each create one).
  // Empty results are cached too.
  private static trackCache = new Map<string, CachedTrack>();

  constructor(private app: App, private trackDataService: TrackDataService) {}

  async extractTrackFromFile(file: TFile): Promise<Coordinate[]> {
    const cacheKey = `${file.path}|${speedWindowCacheToken()}`;
    const cached = TrackDataExtractor.trackCache.get(cacheKey);

    if (cached && cached.mtime === file.stat.mtime && cached.size === file.stat.size) {
      return cached.coordinates;
    }

    const coordinates = await this.extractTrackFromFileUncached(file);

    TrackDataExtractor.trackCache.set(cacheKey, { path: file.path, mtime: file.stat.mtime, size: file.stat.size, coordinates });

    return coordinates;
  }

  private async extractTrackFromFileUncached(file: TFile): Promise<Coordinate[]> {
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;

    if (frontmatter?.['Overlay Cache'] || frontmatter?.['Overlay Source'] || frontmatter?.['Location']) {
      const trackData = this.trackDataService.extractTrackFromNote(file);

      if (trackData.points.length > 0) return trackData.points;
    }

    return extractManualCoordinatesFromPlacesBlocks(await this.app.vault.cachedRead(file));
  }

  hasTrackData(filePath: string): boolean {
    if (!filePath) return false;

    const file = this.app.vault.getFileByPath(normalizePath(filePath));

    if (!file) return false;

    const fileCache = this.app.metadataCache.getFileCache(file);
    const frontmatter = fileCache?.frontmatter;

    return !!(
      frontmatter?.["Overlay Cache"] ||
      frontmatter?.["Overlay Source"] ||
      frontmatter?.["Location"]
    );
  }

  async getAllTracksFromVault(excludePath: string): Promise<Map<string, Coordinate[]>> {
    const tracks = new Map<string, Coordinate[]>();

    const allFiles = this.app.vault.getMarkdownFiles().filter(file =>
      file.path !== excludePath
    );

    const currentPaths = new Set(allFiles.map(file => file.path));

    currentPaths.add(excludePath);

    for (const [key, cached] of TrackDataExtractor.trackCache) {
      if (!currentPaths.has(cached.path)) {
        TrackDataExtractor.trackCache.delete(key);
      }
    }

    const batchSize = 10;

    for (let i = 0; i < allFiles.length; i += batchSize) {
      const batch = allFiles.slice(i, i + batchSize);
      const batchResults = await Promise.allSettled(
        batch.map(async file => {
          const trackData = await this.extractTrackFromFile(file);

          return { path: file.path, data: trackData };
        })
      );

      batchResults.forEach((result, index) => {
        if (result.status === 'fulfilled' && result.value.data.length > 0) {
          tracks.set(result.value.path, result.value.data);
        } else if (result.status === 'rejected') {
          logger.error(`Error extracting track data from ${batch[index].path}:`, result.reason);
        }
      });
    }

    return tracks;
  }
}

export function extractManualCoordinatesFromPlacesBlocks(content: string): Coordinate[] {
  const points: Coordinate[] = [];
  const fencePattern = /```places(?:[ \t][^\r\n]*)?\r?\n([\s\S]*?)```/g;

  for (const match of content.matchAll(fencePattern)) {
    let settings: Record<string, unknown>;

    try {
      settings = parseCodeBlock(match[1]).settings;
    } catch (error) {
      if (error instanceof BlockSyntaxError) continue;
      throw error;
    }

    for (const entry of parsePlaceSources(settings.places) ?? []) {
      if (typeof entry === 'string') continue;
      const location = readNormalizedProperty(entry, 'location');

      if (!location) continue;
      const coordinate = parseCoordinate(location);

      if (coordinate) points.push(coordinate);
    }
  }

  return points;
}
