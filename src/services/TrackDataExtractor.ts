import { logger } from "places-shared/utils";
import { App, TFile, normalizePath } from "obsidian";
import { Coordinate, parseCoordinate } from "places-shared/geo";
import { TrackDataService } from "./TrackDataService";
import { speedWindowCacheToken } from "./TrackPointProcessor";
import { parseEmbeddedPlaceProperties, splitEmbeddedPlaces } from "./CodeBlockParser";

interface CachedTrack {
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
    // Coordinates alone do not depend on the speed window, but the parse that
    // produces them does, and the token keys this memo too.
    const cacheKey = `${file.path}|${speedWindowCacheToken()}`;
    const cached = TrackDataExtractor.trackCache.get(cacheKey);
    if (cached && cached.mtime === file.stat.mtime && cached.size === file.stat.size) {
      return cached.coordinates;
    }

    const coordinates = await this.extractTrackFromFileUncached(file);
    TrackDataExtractor.trackCache.set(cacheKey, { mtime: file.stat.mtime, size: file.stat.size, coordinates });
    return coordinates;
  }

  private async extractTrackFromFileUncached(file: TFile): Promise<Coordinate[]> {
    try {
      const fileCache = this.app.metadataCache.getFileCache(file);
      const frontmatter = fileCache?.frontmatter;

      if (!frontmatter) {
        const content = await this.app.vault.cachedRead(file);
        return extractEmbeddedCoordinatesFromPlacesBlocks(content);
      }

      try {
        const trackData = this.trackDataService.extractTrackFromNote(file);
        if (trackData.points.length > 0) {
          // TrackPoint[] is structurally compatible with Coordinate[].
          return trackData.points;
        }
      } catch {
        // Fall through to Location property if extractTrackFromNote fails
      }

      // Priority 3: Location property (single coordinate)
      if (frontmatter["Location"] && typeof frontmatter["Location"] === 'string') {
        const coord = parseCoordinate(frontmatter["Location"]);
        if (coord) {
          return [coord];
        }
      }

      // Priority 4: Embedded coordinates in places code blocks (requires content read)
      const content = await this.app.vault.cachedRead(file);
      return extractEmbeddedCoordinatesFromPlacesBlocks(content);
    } catch (error) {
      logger.error(`Error extracting track data from ${file.path}:`, error);
      return [];
    }
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

    // Drop cache entries for files that were deleted or renamed.
    const currentPaths = new Set(allFiles.map(file => file.path));
    currentPaths.add(excludePath);
    for (const path of TrackDataExtractor.trackCache.keys()) {
      if (!currentPaths.has(path)) {
        TrackDataExtractor.trackCache.delete(path);
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

      batchResults.forEach(result => {
        if (result.status === 'fulfilled' && result.value.data.length > 0) {
          tracks.set(result.value.path, result.value.data);
        }
      });
    }

    return tracks;
  }

}

export function extractEmbeddedCoordinatesFromPlacesBlocks(content: string): Coordinate[] {
  const points: Coordinate[] = [];
  const fencePattern = /```places(?:\s[^\n]*)?\n([\s\S]*?)```/g;
  for (const match of content.matchAll(fencePattern)) {
    const { embeddedPlaces } = splitEmbeddedPlaces(match[1]);
    for (const properties of parseEmbeddedPlaceProperties(embeddedPlaces)) {
      const location = properties.location;
      if (!location) continue;
      const coordinate = parseCoordinate(location);
      if (coordinate) points.push(coordinate);
    }
  }
  return points;
}
