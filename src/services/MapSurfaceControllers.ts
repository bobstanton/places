import type { MapSurfaceController } from "./MapSurfaceController";

const controllers = new WeakMap<HTMLElement, MapSurfaceController>();

export function setMapSurfaceController(container: HTMLElement, controller: MapSurfaceController): void {
  controllers.get(container)?.dispose();
  controllers.set(container, controller);
}

export function getMapSurfaceController(container: HTMLElement): MapSurfaceController | undefined {
  return controllers.get(container);
}

export function disposeMapSurfaceController(container: HTMLElement): void {
  controllers.get(container)?.dispose();
  controllers.delete(container);
}
