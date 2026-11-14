import type { MapSurfaceController } from "./MapSurfaceController";
import type { MapSurfaceChrome } from "./MapSurfaceChrome";

interface MapSurfaceEntry {
  controller: MapSurfaceController;
  chrome?: MapSurfaceChrome;
}

const surfaces = new WeakMap<HTMLElement, MapSurfaceEntry>();

export function setMapSurfaceController(container: HTMLElement, controller: MapSurfaceController, chrome?: MapSurfaceChrome): void {
  disposeMapSurfaceController(container);
  surfaces.set(container, { controller, chrome });
}

export function getMapSurfaceController(container: HTMLElement): MapSurfaceController | undefined {
  return surfaces.get(container)?.controller;
}

export function disposeMapSurfaceController(container: HTMLElement): void {
  const entry = surfaces.get(container);

  entry?.controller.dispose();
  entry?.chrome?.dispose();
  surfaces.delete(container);
  providerWaiters.delete(container);
}

interface ProviderWaiter {
  providerName: string;
  rerender: (reason: string) => Promise<void>;
}

const providerWaiters = new Map<HTMLElement, ProviderWaiter>();

export function setMapSurfaceProviderWaiter(container: HTMLElement, waiter: ProviderWaiter): void {
  providerWaiters.set(container, waiter);
}

export function retryMapSurfacesWaitingForProvider(hasProvider: (providerName: string) => boolean): void {
  for (const [container, waiter] of [...providerWaiters]) {
    if (!container.isConnected) {
      providerWaiters.delete(container);
      continue;
    }

    if (!hasProvider(waiter.providerName)) continue;
    providerWaiters.delete(container);
    void waiter.rerender('map provider available');
  }
}
