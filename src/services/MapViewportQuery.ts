import type { MapControlHandle, MapViewState } from "places-shared/services";

const VIEWPORT_PLACEHOLDER = /\{map\.(south|west|north|east|ready|zoom|center\.latitude|center\.longitude|bearing|pitch|width|height)\}/g;

export type MapViewportQueryContext = Pick<MapViewState, 'bounds'> & Partial<Omit<MapViewState, 'bounds'>>;

export function readMapViewport(handle: MapControlHandle | null | undefined): MapViewportQueryContext | undefined {
  if (handle?.getViewState) return handle.getViewState();
  if (handle?.getBounds) return { bounds: handle.getBounds() };

  return undefined;
}

export function queryUsesMapViewport(sql: string | undefined): boolean {
  return (sql ?? '').match(VIEWPORT_PLACEHOLDER) !== null;
}

export function resolveMapViewportQuery(sql: string, view?: MapViewportQueryContext): string {
  const bounds = view?.bounds;
  const valid = bounds && [bounds.minLat, bounds.minLng, bounds.maxLat, bounds.maxLng].every(Number.isFinite);
  const wrap = (longitude: number): number => longitude >= -180 && longitude < 180
    ? longitude : ((longitude + 180) % 360 + 360) % 360 - 180;
  const numeric = (value: number | undefined, normalize?: (value: number) => number): number | 'NULL' =>
    typeof value === 'number' && Number.isFinite(value) ? (normalize ? normalize(value) : value) : 'NULL';
  const wholeWorld = !valid || bounds.maxLng - bounds.minLng >= 360;
  const values = {
    south: valid ? Math.max(-90, bounds.minLat) : -90,
    north: valid ? Math.min(90, bounds.maxLat) : 90,
    west: wholeWorld ? -180 : wrap(bounds.minLng),
    east: wholeWorld ? 180 : wrap(bounds.maxLng),
    ready: valid ? 1 : 0,
    zoom: numeric(view?.zoom),
    'center.latitude': numeric(view?.center?.latitude),
    'center.longitude': numeric(view?.center?.longitude, wrap),
    bearing: numeric(view?.bearing, degrees => degrees >= 0 && degrees < 360 ? degrees : ((degrees % 360) + 360) % 360),
    pitch: numeric(view?.pitch),
    width: numeric(view?.width),
    height: numeric(view?.height),
  };

  return sql.replace(VIEWPORT_PLACEHOLDER, (_, key: keyof typeof values) => String(values[key]));
}

export function subscribeMapViewportQuery(source: string, handle: MapControlHandle, listener: () => void): () => void {
  const tokens = [...new Set(source.match(VIEWPORT_PLACEHOLDER) ?? [])].join(',');
  let previous = resolveMapViewportQuery(tokens, readMapViewport(handle));

  return handle.onBoundsChanged?.(() => {
    const next = resolveMapViewportQuery(tokens, readMapViewport(handle));

    if (previous === next) return;
    previous = next;
    listener();
  }) ?? (() => {});
}

export interface ViewportParameterNames {
  north: string;
  south: string;
  east: string;
  west: string;
  zoom: string;
}

export function viewportParameterNames(baseName: string): ViewportParameterNames {
  const suffixed = (suffix: string): string => `${baseName}${suffix}`;

  return { north: suffixed('North'), south: suffixed('South'), east: suffixed('East'), west: suffixed('West'), zoom: suffixed('Zoom') };
}

export function viewportParameterDeclarations(names: ViewportParameterNames): Array<Record<string, unknown>> {
  const published: string[] = [names.north, names.south, names.east, names.west, names.zoom];

  return published.map(name => ({ name, type: 'float', control: 'number', default: 0 }));
}

export function viewportParameterValues(names: ViewportParameterNames, view: MapViewportQueryContext | undefined): Record<string, number> | undefined {
  const bounds = view?.bounds;

  if (!bounds || ![bounds.minLat, bounds.minLng, bounds.maxLat, bounds.maxLng].every(Number.isFinite)) return undefined;

  return {
    [names.north]: Math.min(90, bounds.maxLat),
    [names.south]: Math.max(-90, bounds.minLat),
    [names.east]: bounds.maxLng,
    [names.west]: bounds.minLng,
    [names.zoom]: typeof view?.zoom === 'number' && Number.isFinite(view.zoom) ? view.zoom : 0,
  };
}
