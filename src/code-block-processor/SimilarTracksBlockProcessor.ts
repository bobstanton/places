import { logger } from "places-shared/utils";
import { createLoadingIndicator } from "places-shared/ui";
import { App, MarkdownPostProcessorContext, normalizePath } from "obsidian";
import { km, kph, meters, formatKmInSystem, formatKphInSystem, UnitsSystem, Kilometers, Meters } from "places-shared/units";
import { normalizePercentage, parsePositiveFloat, parsePositiveInt, parseBoolean, parseLongDistanceAsKilometers, parseDistanceStringAsKilometers, conditionalProps } from "places-shared/settings";
import { renderError, formatDisplayCoordinate, getErrorMessage, clamp, scalarToString } from "places-shared/utils";
import { parseCoordinate } from "places-shared/geo";
import PlacesPlugin from "../main";
import { BlockParameterSupport } from "../services/BlockParameters";
import { ParsedCodeBlock, optionalStringSetting, parseCodeBlock } from "../services/CodeBlockParser";
import { SimilarTracksService } from "../services/SimilarTracksService";
import { TrackDataService } from "../services/TrackDataService";
import { registerRefreshableCodeBlock, renderHoverPlaceholder, createOwnNoteEditRefreshGuard } from "./RefreshableCodeBlock";

interface SimilarTracksBlockSettings {
  // Minimum Fréchet similarity (0-1). Use with or without minOverlap.
  minSimilarity?: number;
  // Minimum overlap (0-1). Accepts input as 0-1 or 0-100. Use with or without minSimilarity.
  minOverlap?: number;
  radius: Kilometers;
  maxResults: number;
  location?: { latitude: number; longitude: number };
  searchType?: 'track' | 'point';
  showPersonalBest: boolean;
  showSpeedTime: boolean;
  // Distance tolerance in degrees for Fréchet similarity (default: 0.01 ≈ 1.1km). Higher = more lenient matching.
  tolerance: number;
  // Tolerance in meters for overlap calculation (default: 50m)
  overlapTolerance: Meters;
}

interface EnrichedTrackResult {
  filePath: string;
  fileName: string;
  distance: Kilometers;
  similarity?: number;
  overlapPercent?: number;
  lengthMatchPercentage?: number;
  trackData?: {
    metrics?: {
      averageSpeed?: number;
      duration?: number;
    };
  };
}

interface SearchLocation {
  latitude: number;
  longitude: number;
}

const SimilarTracksBlockDefaultSettings: SimilarTracksBlockSettings = {
  minSimilarity: undefined, // Will default to 0.7 if neither minSimilarity nor minOverlap is set
  minOverlap: undefined,
  radius: km(1.0),
  maxResults: Number.MAX_SAFE_INTEGER,
  showPersonalBest: false,
  showSpeedTime: false,
  tolerance: 0.01, // ~1.1km at equator for Fréchet
  overlapTolerance: meters(50)
};

function shouldShowSimilarity(settings: SimilarTracksBlockSettings): boolean {
  return settings.minSimilarity !== undefined || (settings.minSimilarity === undefined && settings.minOverlap === undefined);
}

export class SimilarTracksBlockProcessor {
  private similarTracksService: SimilarTracksService;
  private trackDataService: TrackDataService;

  constructor(private app: App, trackDataService: TrackDataService, private blockParameters: BlockParameterSupport) {
    this.similarTracksService = new SimilarTracksService(app, trackDataService);
    this.trackDataService = trackDataService;
  }

  async processCodeBlock(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
    if (renderHoverPlaceholder(el, '📊 Similar tracks preview not available in hover')) return;

    const parsed = parseCodeBlock(source);
    const parameters = await this.blockParameters.apply(parsed, el, ctx);
    registerRefreshableCodeBlock({
      source,
      el,
      ctx,
      process: (src, container, context) => this.processCodeBlock(src, container, context),
      shouldAutoRefresh: createOwnNoteEditRefreshGuard(source, ctx.sourcePath),
      ariaLabel: 'Refresh similar tracks',
      onError: error => logger.error('Refresh similar tracks failed:', error),
      usesParameters: parameters !== null,
    });

    try {
      const settings = this.parseSettings(parsed, ctx);

      let searchLocation = settings.location;
      if (!searchLocation && ctx?.sourcePath) {
        searchLocation = extractLocationFromFrontmatter(this.app, ctx.sourcePath);
      }

      const loadingText = settings.searchType === 'point' || searchLocation
        ? "Finding tracks near location..."
        : "Finding similar tracks...";
      createLoadingIndicator(el, loadingText);

      let results: EnrichedTrackResult[];

      const hasTrackData = this.similarTracksService.hasTrackData(ctx?.sourcePath);

      if (settings.searchType === 'point' || (!hasTrackData && searchLocation)) {
        if (!searchLocation) {
          throw new Error("Point-based search requires a location coordinate");
        }

        const pointSearchResults = await this.similarTracksService.findTracksNearPoint(
          searchLocation,
          { radiusKm: km(settings.radius), maxResults: settings.maxResults },
          ctx?.sourcePath
        );

        results = pointSearchResults.map(r => {
          const proximityRatio = clamp(1 - (r.distance / settings.radius), 0, 1);
          return {
            fileName: r.fileName,
            filePath: r.filePath,
            similarity: proximityRatio,
            distance: r.distance,
            overlapPercent: proximityRatio * 100
          };
        });
      } else if (hasTrackData) {
        results = await this.similarTracksService.findSimilarTracks(ctx, {
          minSimilarity: settings.minSimilarity,
          minOverlap: settings.minOverlap,
          maxResults: settings.maxResults,
          tolerance: settings.tolerance,
          overlapToleranceMeters: settings.overlapTolerance
        });
      } else {
        throw new Error("No track data or location found for comparison");
      }

      el.empty();

      if (results.length === 0) {
        el.createDiv({
          text: "No similar tracks found.",
          cls: "places-centered places-empty"
        });
        return;
      }

      const isPointSearch = settings.searchType === 'point' || (!hasTrackData && !!searchLocation);

      let enrichedResults = results;
      if (settings.showSpeedTime || settings.showPersonalBest) {
        enrichedResults = this.enrichResultsWithTrackData(results);
      }

      const personalBest = settings.showPersonalBest ? this.findPersonalBest(enrichedResults) : undefined;

      this.renderResults(el, enrichedResults, isPointSearch, settings, searchLocation, hasTrackData, personalBest ?? undefined);

    } catch (error) {
      logger.error("Error in places-similar code block:", error);
      renderError(el, {
        icon: "⚠️",
        title: "Similar Tracks Error",
        message: getErrorMessage(error)
      });
    } finally {
      // Render after the content and any internal el.empty(); 'above' placement
      // still displays the strip on top.
      await parameters?.renderStrip();
    }
  }

  private parseSettings(parsed: ParsedCodeBlock, ctx: MarkdownPostProcessorContext): SimilarTracksBlockSettings {
    const pairs = parsed.settings;
    const settings: SimilarTracksBlockSettings = { ...SimilarTracksBlockDefaultSettings };
    const units: UnitsSystem = PlacesPlugin.settings.units;

    if (ctx.sourcePath && pairs.radius === undefined) {
      const distanceRadius = this.getDistanceFromCurrentNote(ctx.sourcePath);
      if (distanceRadius !== null) {
        settings.radius = distanceRadius;
      }
    }

    settings.showPersonalBest = parseBoolean(pairs.showPersonalBest, settings.showPersonalBest);
    settings.showSpeedTime = parseBoolean(pairs.showSpeedTime, settings.showSpeedTime);

    // Similarity thresholds accept 0-1 or 0-100 format.
    const minSimilarity = parsePositiveFloat(pairs.minSimilarity);
    const minOverlap = parsePositiveFloat(pairs.minOverlap);

    Object.assign(settings, conditionalProps({
      minSimilarity: minSimilarity !== undefined ? normalizePercentage(minSimilarity) : undefined,
      minOverlap: minOverlap !== undefined ? normalizePercentage(minOverlap) : undefined,
      overlapTolerance: parsePositiveFloat(pairs.overlapTolerance),
      tolerance: parsePositiveFloat(pairs.tolerance),
      maxResults: parsePositiveInt(pairs.maxResults),
    }));

    if (pairs.radius !== undefined) {
      const radiusStr = scalarToString(pairs.radius);
      const fromIndex = radiusStr.toLowerCase().indexOf(' from ');
      if (fromIndex !== -1) {
        const distanceStr = radiusStr.substring(0, fromIndex).trim();
        const coordStr = radiusStr.substring(fromIndex + 6).trim();
        const radiusKm = parseLongDistanceAsKilometers(distanceStr, units);
        if (radiusKm !== undefined) settings.radius = radiusKm;
        const center = parseCoordinate(coordStr);
        if (center) {
          settings.location = center;
          settings.searchType = 'point';
        }
      } else {
        const radiusKm = parseLongDistanceAsKilometers(radiusStr, units);
        if (radiusKm !== undefined) settings.radius = radiusKm;
      }
    }

    // Location setting - lower priority than FROM in radius
    const location = optionalStringSetting(pairs, 'location');
    if (location && !settings.location) {
      const parsed = parseCoordinate(location);
      if (parsed) {
        settings.location = parsed;
        settings.searchType = 'point';
      }
    }

    return settings;
  }

  private getDistanceFromCurrentNote(filePath: string): Kilometers | null {
    try {
      const file = this.app.vault.getFileByPath(normalizePath(filePath));
      if (!file) return null;

      const fileCache = this.app.metadataCache.getFileCache(file);
      if (!fileCache?.frontmatter) return null;

      const distance: unknown = fileCache.frontmatter['Distance'];
      return parseDistanceStringAsKilometers(distance) ?? null;
    } catch {
      return null;
    }
  }

  private enrichResultsWithTrackData(results: EnrichedTrackResult[]): EnrichedTrackResult[] {
    return results.map((result) => {
      try {
        const file = this.app.vault.getFileByPath(normalizePath(result.filePath));
        if (!file) {
          return result;
        }
        const trackData = this.trackDataService.extractTrackFromNote(file);
        return { ...result, trackData };
      } catch {
        return result;
      }
    });
  }

  private findPersonalBest(results: EnrichedTrackResult[]): EnrichedTrackResult | null {
    const tracksWithSpeed = results.filter(r => r.trackData?.metrics?.averageSpeed !== undefined);
    if (tracksWithSpeed.length === 0) return null;

    return tracksWithSpeed.reduce((best, current) => {
      const currentSpeed = current.trackData?.metrics?.averageSpeed ?? 0;
      const bestSpeed = best.trackData?.metrics?.averageSpeed ?? 0;
      return currentSpeed > bestSpeed ? current : best;
    });
  }

  private renderResults(el: HTMLElement, results: EnrichedTrackResult[], isPointSearch: boolean, settings: SimilarTracksBlockSettings, searchLocation: SearchLocation | undefined, hasTrackData: boolean, personalBest?: EnrichedTrackResult): void {
    const container = el.createDiv("places-similar");

    container.createEl("h3", {
      text: `Found ${results.length} similar track${results.length === 1 ? '' : 's'}`,
      cls: "places-similar-header"
    });

    const table = this.createResultsTable(container, isPointSearch, settings);
    this.populateTableData(table, results, isPointSearch, settings, personalBest);

    this.addSettingsInfo(container, isPointSearch, settings, searchLocation, hasTrackData);
  }

  private createResultsTable(container: HTMLElement, isPointSearch: boolean, settings: SimilarTracksBlockSettings): HTMLTableElement {
    const table = container.createEl("table");
    const thead = table.createEl("thead");
    const headerRow = thead.createEl("tr");

    let headers: string[];
    if (isPointSearch) {
      headers = ["Track", "Distance", "Proximity"];
    } else {
      headers = ["Track"];
      if (shouldShowSimilarity(settings)) {
        headers.push("Similarity");
      }
      if (settings.minOverlap !== undefined) {
        headers.push("Overlap");
      }
      headers.push("Distance", "Length Match");
    }

    if (settings.showSpeedTime) {
      headers.push("Avg Speed", "Duration");
    }

    if (settings.showPersonalBest) {
      headers.push("PB");
    }

    for (const headerText of headers) {
      headerRow.createEl("th", { text: headerText });
    }

    table.createEl("tbody");

    return table;
  }

  private populateTableData(table: HTMLTableElement, results: EnrichedTrackResult[], isPointSearch: boolean, settings: SimilarTracksBlockSettings, personalBest?: EnrichedTrackResult): void {
    const tbody = table.querySelector("tbody");
    if (!tbody) return;

    for (const result of results) {
      const row = tbody.createEl("tr");

      const nameCell = row.createEl("td");
      const link = nameCell.createEl("a", {
        text: result.fileName,
        cls: "internal-link"
      });
      link.addEventListener('click', (e) => {
        e.preventDefault();
        void this.app.workspace.openLinkText(result.filePath, '');
      });

      if (isPointSearch) {
        this.addPointSearchCells(row, result, settings);
      } else {
        this.addTrackSimilarityCells(row, result, settings);
      }

      if (settings.showSpeedTime) {
        this.addSpeedTimeCells(row, result);
      }

      if (settings.showPersonalBest) {
        this.addPersonalBestCell(row, result, personalBest);
      }
    }
  }

  private addPointSearchCells(row: HTMLTableRowElement, result: EnrichedTrackResult, _settings: SimilarTracksBlockSettings): void {
    const distanceCell = row.createEl("td");
    const distanceText = formatKmInSystem(km(result.distance), PlacesPlugin.settings.units, 1);
    distanceCell.textContent = distanceText;

    const proximityCell = row.createEl("td");
    proximityCell.textContent = `${Math.round(result.overlapPercent ?? 0)}%`;
  }

  private addTrackSimilarityCells(row: HTMLTableRowElement, result: EnrichedTrackResult, settings: SimilarTracksBlockSettings): void {
    if (shouldShowSimilarity(settings)) {
      const similarityCell = row.createEl("td");
      similarityCell.textContent = `${Math.round((result.similarity ?? 0) * 100)}%`;
    }

    if (settings.minOverlap !== undefined) {
      const overlapCell = row.createEl("td");
      overlapCell.textContent = `${Math.round(result.overlapPercent ?? 0)}%`;
    }

    const distanceCell = row.createEl("td");
    const distanceText = formatKmInSystem(km(result.distance), PlacesPlugin.settings.units, 1);
    distanceCell.textContent = distanceText;

    const lengthMatchCell = row.createEl("td");
    lengthMatchCell.textContent = `${Math.round(result.lengthMatchPercentage ?? 0)}%`;
  }

  private addSpeedTimeCells(row: HTMLTableRowElement, result: EnrichedTrackResult): void {
    const speedCell = row.createEl("td");
    if (result.trackData?.metrics?.averageSpeed) {
      const speedText = formatKphInSystem(kph(result.trackData.metrics.averageSpeed), PlacesPlugin.settings.units, 1);
      speedCell.textContent = speedText;
    } else {
      speedCell.textContent = "-";
    }

    const durationCell = row.createEl("td");
    if (result.trackData?.metrics?.duration) {
      const hours = Math.floor(result.trackData.metrics.duration);
      const minutes = Math.round((result.trackData.metrics.duration - hours) * 60);
      durationCell.textContent = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
    } else {
      durationCell.textContent = "-";
    }
  }

  private addPersonalBestCell(row: HTMLTableRowElement, result: EnrichedTrackResult, personalBest?: EnrichedTrackResult): void {
    const pbCell = row.createEl("td");
    if (personalBest && result.filePath === personalBest.filePath) {
      pbCell.textContent = "🏆";
      pbCell.title = "Personal best - fastest average speed";
    } else {
      pbCell.textContent = "";
    }
  }

  private addSettingsInfo(container: HTMLElement, isPointSearch: boolean, settings: SimilarTracksBlockSettings, searchLocation: SearchLocation | undefined, hasTrackData: boolean): void {
    let settingsText = "";
    if (isPointSearch) {
      const radius = settings.radius;
      const radiusText = formatKmInSystem(km(radius), PlacesPlugin.settings.units, 1);
      settingsText = `Showing tracks within ${radiusText} of location`;
      if (searchLocation && typeof searchLocation.latitude === 'number' && typeof searchLocation.longitude === 'number') {
        settingsText += ` (${formatDisplayCoordinate(searchLocation, 4)})`;
      }
    } else if (hasTrackData) {
      const filters: string[] = [];

      if (settings.minSimilarity !== undefined) {
        filters.push(`≥${Math.round(settings.minSimilarity * 100)}% similarity`);
      } else if (settings.minOverlap === undefined) {
        filters.push(`≥70% similarity`);
      }

      if (settings.minOverlap !== undefined) {
        filters.push(`≥${Math.round(settings.minOverlap * 100)}% overlap`);
      }

      if (filters.length > 0) {
        settingsText = `Showing tracks with ${filters.join(' and ')}`;
      }
    }

    if (settingsText) {
      container.createDiv({
        text: settingsText,
        cls: "places-similar-settings-info"
      });
    }
  }

}

function extractLocationFromFrontmatter(app: App, filePath: string): { latitude: number; longitude: number } | undefined {
  const file = app.vault.getFileByPath(normalizePath(filePath));
  if (!file) return undefined;
  const fileCache = app.metadataCache.getFileCache(file);
  const location: unknown = fileCache?.frontmatter?.Location;
  if (typeof location !== 'string') return undefined;
  return parseCoordinate(location) ?? undefined;
}
