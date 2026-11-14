import { logger } from "places-shared/utils";
import { clearMapRecoveryState } from "places-shared/obsidian/map";
import { cleanupMapProviderStates, clearMapSurfaceLifecycle } from "places-shared/map";
import { disposeMapSurfaceController } from "./MapSurfaceControllers";

export function cleanupMapContainer(mapContainer: HTMLElement): void {
  logger.scope('MapSurface').debug('map surface cleanup', {
    source: mapContainer.getAttribute('data-source-path'),
    connected: mapContainer.isConnected,
  });
  disposeMapSurfaceController(mapContainer);
  cleanupMapProviderStates(mapContainer, error => {
    logger.error('Error during map cleanup:', error);
  });
  clearMapRecoveryState(mapContainer);
  clearMapSurfaceLifecycle(mapContainer);
}
