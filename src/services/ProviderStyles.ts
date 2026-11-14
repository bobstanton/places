import type { PlaceProviderExport } from "places-shared/obsidian/services";
import type { MapStyleKind } from "places-shared/map";

export interface ProviderStyle {
  id: string;
  kind?: MapStyleKind;
}

export function resolveStyleKind(provider: PlaceProviderExport, styleId: string): MapStyleKind | undefined {
  const declared = provider.styleKinds?.[styleId];

  if (declared) return declared;

  const raster = provider.features?.raster;
  const vector = provider.features?.vector;

  if (raster && !vector) return 'raster';
  if (vector && !raster) return 'vector';

  return undefined;
}

export function toProviderStyles(provider: PlaceProviderExport): ProviderStyle[] {
  return (provider.styles ?? []).map(id => ({ id, kind: resolveStyleKind(provider, id) }));
}
