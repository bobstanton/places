import { App, Notice, TFile, normalizePath } from 'obsidian';
import { DEFAULT_MARKER_ICON, type GeocodedPlaceNoteRequest, type LocationPlaceNoteRequest, type PlaceNoteHost, type PlaceNoteRequest, type PoiPlaceNoteRequest, type RouteOverlayPlaceNoteRequest, type TrackPlaceNoteRequest } from "places-shared/map";
import { buildPlaceNoteContent, resolvePlaceNoteIcon } from "../core/map/PlaceNoteContent";
import { coordinateFromPosition } from "places-shared/geo";
import { IPlacesPluginSettings } from "places-shared/settings";
import { buildTrackNoteFrontmatter } from "places-shared/services";
import { createOverlayNote } from "./OverlayNoteCreator";
import { formatPlaceNoteRequestName } from 'places/core';
import { renderPlaceNoteTemplate } from './PlaceNoteTemplate';
import { preparePlaceTags } from "../core/map/PlaceTagFilter";
import { StringCompressor, formatDisplayCoordinate, logger as rootLogger } from "places-shared/utils";
import { ensureVaultFolder, getAvailableVaultPath, resolveNewNoteFolder } from "places-shared/obsidian/utils";

const logger = rootLogger.scope('PlaceNote');

export class PlaceNoteCreationService implements PlaceNoteHost {
  constructor(private readonly app: App, private readonly getSettings: () => IPlacesPluginSettings) {}

  async createNote(request: PlaceNoteRequest): Promise<void> {
    try {
      const file = request.kind === 'route-overlay'
        ? await this.writeRouteOverlayNote(request)
        : request.kind === 'track' ? await this.writeTrackNote(request)
        : await this.writePlaceNote(request);

      await this.app.workspace.getLeaf('tab').openFile(file);
      new Notice(`Created note: ${file.basename}`);
    } catch (error) {
      logger.error('Failed to create place note', { request, error });
      new Notice(`Failed to create note: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  resolveIcon(request: PlaceNoteRequest): string {
    const tags = request.kind === 'place' ? preparePlaceTags([...(request.tags ?? [])], this.getSettings().newPlaceTagFilterPatterns) : [];
    const note = request.kind === 'track' || request.kind === 'route-overlay' ? undefined : this.resolveDestination(request);

    return resolvePlaceNoteIcon(request, tags, note) ?? DEFAULT_MARKER_ICON;
  }

  // A rendered route or isochrone stored as its own note: the overlay payload
  // in a note whose body is a `places` block, which renders on open. Uses the
  // shared overlay-note primitive, and compresses here - in the host's bundle,
  // where the codec and the configured compression level live.
  private async writeRouteOverlayNote(request: RouteOverlayPlaceNoteRequest): Promise<TFile> {
    return createOverlayNote(this.app, {
      name: request.name,
      sourcePath: request.sourcePath,
      frontmatter: {
        ...(request.location ? { Location: formatDisplayCoordinate(coordinateFromPosition(request.location)) } : {}),
        'Overlay Source': StringCompressor.compressAndEncode(JSON.stringify(request.geojson)),
      },
      // createNote opens and announces every kind uniformly.
      openAfterCreate: false,
    });
  }

  private async writePlaceNote(request: PoiPlaceNoteRequest | LocationPlaceNoteRequest | GeocodedPlaceNoteRequest): Promise<TFile> {
    const settings = this.getSettings();
    const note = this.resolveDestination(request);
    const content = buildPlaceNoteContent(request, {
      units: settings.units,
      newPlaceTagFilterPatterns: settings.newPlaceTagFilterPatterns,
    }, note);
    const template = settings.newPlaceTemplate?.trim()
      ? await renderPlaceNoteTemplate(this.app, settings.newPlaceTemplate, request, note, content.frontmatter)
      : { body: '', properties: {} };

    await ensureVaultFolder(this.app, note.path);

    const body = request.kind === 'place' && request.body?.trim()
      ? [template.body.trimEnd(), request.body.trim()].filter(Boolean).join('\n\n')
      : template.body;
    const file = await this.app.vault.create(note.path, body);

    await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
      Object.assign(frontmatter, template.properties, content.frontmatter);
    });

    return file;
  }

  private resolveDestination(request: PoiPlaceNoteRequest | LocationPlaceNoteRequest | GeocodedPlaceNoteRequest): { name: string; path: string } {
    const name = formatPlaceNoteRequestName(request, this.getSettings().noteNameFormat);
    const folder = resolveNewNoteFolder(this.app, request.sourcePath);
    const path = getAvailableVaultPath(this.app, normalizePath(folder ? `${folder}/${name}.md` : `${name}.md`));

    return { name: path.slice(path.lastIndexOf('/') + 1, -3), path };
  }

  private async writeTrackNote(request: TrackPlaceNoteRequest): Promise<TFile> {
    return createOverlayNote(this.app, {
      name: request.name,
      sourcePath: request.sourcePath,
      frontmatter: {
        ...buildTrackNoteFrontmatter(request.metrics, this.getSettings().units),
        'Overlay Source': StringCompressor.compressAndEncode(request.gpx),
      },
      openAfterCreate: false,
    });
  }
}
