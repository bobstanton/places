import { MarkdownRenderChild } from "obsidian";
import { clearMapRecoveryState } from "places-shared/map";
import { MapRefreshService } from "../services/MapRefreshService";
import { cleanupMapContainer } from "../services/MapSurfaceCleanup";

const MAP_CONTAINER_SELECTOR = '.places-map-container, .places-heatmap-map';

// Each re-render of a map-bearing block holds a WebGL context until the map is torn down.
export class MapCleanupRenderChild extends MarkdownRenderChild {
  onunload(): void {
    const mapContainer = this.containerEl.matches(MAP_CONTAINER_SELECTOR)
      ? this.containerEl
      : this.containerEl.querySelector<HTMLElement>(MAP_CONTAINER_SELECTOR);
    if (mapContainer) {
      cleanupMapContainer(mapContainer);
      clearMapRecoveryState(mapContainer);
    }

    // No-op for blocks that never registered for refresh.
    MapRefreshService.getInstance().unregisterMap(this.containerEl);
  }
}
