import { App, Plugin } from "obsidian";
import type { PlaceNoteHost } from "places-shared/map";
import type { Coordinate } from "places-shared/geo";
import { IPlacesPluginSettings } from "places-shared/settings";
import { logger as rootLogger } from "places-shared/utils";
import { ReverseGeocodeModal } from "../modals/ReverseGeocodeModal";
import { AggregatorApiService } from "../places-services/AggregatorApiService";

export class ProtocolController {
  constructor(
    private readonly app: App,
    private readonly placesFor: (sourcePath?: string) => AggregatorApiService,
    private readonly getSettings: () => IPlacesPluginSettings,
    private readonly placeNoteHost: PlaceNoteHost,
  ) {}

  register(plugin: Plugin): void {
    plugin.registerObsidianProtocolHandler("places-reverse-geocode", (params) => {
      const latitude = Number.parseFloat(params.lat);
      const longitude = Number.parseFloat(params.lng);

      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        rootLogger.scope("Protocol").warn("Invalid coordinates in protocol handler", params);

        return;
      }

      this.openReverseGeocode({ latitude, longitude }, params.sourcePath);
    });
  }

  openReverseGeocode(coordinate: Coordinate, sourcePath?: string): void {
    new ReverseGeocodeModal(this.app, this.placesFor(sourcePath), this.getSettings().units, (place) => {
      void this.placeNoteHost.createNote({ kind: 'place', ...place, lat: place.latitude, lng: place.longitude, sourcePath });
    }, coordinate).open();
  }
}
