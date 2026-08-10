import { logger } from "places-shared/utils";
import { clearMapRecoveryState, cleanupMapProviderStates, getMapRecoveryState, clearMapSurfaceLifecycle } from "places-shared/map";
import { disposeMapSurfaceController } from "./MapSurfaceControllers";

export function cleanupMapContainer(mapContainer: HTMLElement): void {
  disposeMapSurfaceController(mapContainer);
  const recoveryState = getMapRecoveryState(mapContainer);
  let cleanedByRecoveryState = false;

  if (recoveryState?.cleanup) {
    clearMapRecoveryState(mapContainer);
    try {
      recoveryState.cleanup();
      cleanedByRecoveryState = true;
    } catch (error) {
      logger.error('Error during map cleanup:', error);
    }
  }

  if (!cleanedByRecoveryState) {
    cleanupMapProviderStates(mapContainer, error => {
      logger.error('Error during map cleanup:', error);
    });
  }

  // After provider teardown has reported destroyed into it.
  clearMapSurfaceLifecycle(mapContainer);
}
