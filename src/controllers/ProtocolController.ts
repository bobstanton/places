import { App, Plugin } from "obsidian";
import { Place } from "places-shared/place";
import type { Coordinate } from "places-shared/geo";
import { IPlacesPluginSettings } from "places-shared/settings";
import { Utilities, ensureVaultFolder, getAvailableVaultPath, resolveNewNoteFolder, logger as rootLogger } from "places-shared/utils";
import { ReverseGeocodeModal } from "../modals/ReverseGeocodeModal";
import { AggregatorApiService } from "../places-services/AggregatorApiService";

export class ProtocolController {
  constructor(
    private readonly app: App,
    private readonly places: AggregatorApiService,
    private readonly getSettings: () => IPlacesPluginSettings,
    private readonly syncNote: (file: import("obsidian").TFile, place: Place) => Promise<void>,
  ) {}

  // Entry point for external callers - a URL in a note, another plugin, a
  // script. Places' own map surfaces do NOT use it: they call
  // `openReverseGeocode` through `MapRuntimeContext.reverseGeocodeHost`.
  register(plugin: Plugin): void {
    plugin.registerObsidianProtocolHandler("places-reverse-geocode", (params) => {
      const latitude = Number.parseFloat(params.lat);
      const longitude = Number.parseFloat(params.lng);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        rootLogger.scope("Protocol").warn("Invalid coordinates in protocol handler", params);
        return;
      }
      this.openReverseGeocode({ latitude, longitude });
    });
  }

  openReverseGeocode(coordinate: Coordinate): void {
    new ReverseGeocodeModal(this.app, this.places, this.getSettings().units, (place) => {
      void this.createNote(place);
    }, coordinate).open();
  }

  private async createNote(place: Place): Promise<void> {
    // Beside the note being read, like every other creation path.
    const folder = resolveNewNoteFolder(this.app);
    const path = `${folder ? `${folder}/` : ""}${Utilities.sanitizeFilename(place.name)}.md`;
    await ensureVaultFolder(this.app, path);
    const file = await this.app.vault.create(getAvailableVaultPath(this.app, path), "");
    await this.syncNote(file, place);
    await this.app.workspace.getLeaf("tab").openFile(file);
  }
}
