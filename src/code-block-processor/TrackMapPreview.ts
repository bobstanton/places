import { MarkdownPostProcessorContext } from "obsidian";
import { buildTrackPreviewPlace, PreviewTrack } from "places-shared/overlay";
import { type MapContextAction } from "places-shared/settings";
import { renderMapSurface } from "../services/MapSurfaceRenderer";
import { resolveMapSettings } from "../services/MapSettingsResolver";

export { buildTrackPreviewPlace } from "places-shared/overlay";
export type { PreviewTrack } from "places-shared/overlay";

export interface TrackMapPreviewOptions {
  host: HTMLElement;
  mapContainerClass: string;
  ctx: MarkdownPostProcessorContext;
  mapProviderName: string;
  height: string;
  style?: string;
  poiDiscovery?: boolean;
  tracks: PreviewTrack[];
  contextMenuActions?: readonly MapContextAction[];
  isStale?: () => boolean;
  onRerenderRequested: (reason: string) => Promise<void>;
}

export async function renderTrackPreviewMap(options: TrackMapPreviewOptions): Promise<boolean> {
  const places = options.tracks.map(buildTrackPreviewPlace);

  const resolved = resolveMapSettings({
    providerName: options.mapProviderName,
    placeCount: places.length,
    rawBlockSettings: {
      mapProvider: options.mapProviderName,
      height: options.height,
      ...(options.style ? { style: options.style } : {}),
    },
    blockOverrides: {
      showLabels: false,
      trackDefaultVisibility: 'visible',
      poiDiscovery: options.poiDiscovery ?? false,
    },
  });

  const result = await renderMapSurface({
    host: options.host,
    mapContainerClass: options.mapContainerClass,
    height: options.height,
    places,
    providerName: options.mapProviderName,
    ctx: options.ctx,
    isStale: options.isStale,
    config: resolved.config,
    clusteringEnabled: resolved.clusteringEnabled,
    source: { path: options.ctx.sourcePath },
    sourcePath: options.ctx.sourcePath,
    contextMenuActions: options.contextMenuActions,
    onRerenderRequested: options.onRerenderRequested,
  });

  return result.rendered;
}
