import { logger as rootLogger } from "places-shared/utils";
import { MarkdownPostProcessorContext } from "obsidian";
import { buildTrackPreviewPlace, PreviewTrack } from "places-shared/overlay";
import { type MapContextAction } from "places-shared/settings";
import { renderMapSurface } from "../services/MapSurfaceRenderer";
import { resolveMapSettings } from "../services/MapSettingsResolver";

const logger = rootLogger.scope('TrackMapPreview');

export { buildTrackPreviewPlace } from "places-shared/overlay";
export type { PreviewTrack } from "places-shared/overlay";

export interface TrackMapPreviewOptions {
  mapContainer: HTMLElement;
  ctx: MarkdownPostProcessorContext;
  mapProviderName: string;
  height: string;
  width: string;
  style?: string;
  poiDiscovery?: boolean;
  tracks: PreviewTrack[];
  contextMenuActions?: readonly MapContextAction[];
}

// renderMapSurface registers teardown through MapCleanupRenderChild; callers add none.
export async function renderTrackPreviewMap(options: TrackMapPreviewOptions): Promise<boolean> {
  const places = options.tracks.map(buildTrackPreviewPlace);

  const resolved = resolveMapSettings({
    providerName: options.mapProviderName,
    placeCount: places.length,
    rawBlockSettings: {
      mapProvider: options.mapProviderName,
      height: options.height,
      width: options.width,
      ...(options.style ? { style: options.style } : {}),
    },
    blockOverrides: {
      showLabels: false,
      trackDefaultVisibility: 'visible',
      poiDiscovery: options.poiDiscovery ?? false,
    },
  });

  const result = await renderMapSurface({
    host: options.mapContainer.parentElement ?? options.mapContainer,
    mapContainer: options.mapContainer,
    places,
    providerName: options.mapProviderName,
    ctx: options.ctx,
    config: resolved.config,
    clusteringEnabled: resolved.clusteringEnabled,
    source: { path: options.ctx.sourcePath },
    contextMenuActions: options.contextMenuActions,
  });
  if (!result.rendered) {
    logger.debug('Track preview map did not render', { provider: options.mapProviderName });
  }
  return result.rendered;
}
