import { createTileJsonResolver, type TileJsonVectorLayer } from "places-shared/overlay";
import { logger, loggedRequestUrl as requestUrl } from "places-shared/utils";

// TileJSON metadata for the editor.
//
// A vector tile overlay needs a `sourceLayer` and, to filter, the names of the
// properties in that layer. Both are declared by the tileset's own
// `vector_layers`, and completion offers them.
//
// Completion sources are synchronous: `peek` returns what is already known
// and schedules a fetch when it is not,
// notifying subscribers once the document lands for the open popup to refill.
// The map render path keeps its own resolver inside the provider plugin - the
// two caches are separate because they live in separate bundles, but they share
// this parser.

// Absolute http(s) URLs only, and only once the host looks finished - a bare
// `https://exa` mid-keystroke must not schedule a request. Requires a dotted
// host or an explicit port, and localhost with a port still resolves.
const FETCHABLE_URL = /^https?:\/\/[^\s/]+(\.[^\s/]+|:\d+)[^\s]*$/i;

export class TileJsonLayerIndex {
  private static _instance: TileJsonLayerIndex | undefined;

  static get instance(): TileJsonLayerIndex {
    TileJsonLayerIndex._instance ??= new TileJsonLayerIndex();

    return TileJsonLayerIndex._instance;
  }

  private readonly resolve = createTileJsonResolver(async url => (await requestUrl({ url })).text);
  private readonly loaded = new Map<string, TileJsonVectorLayer[]>();
  private readonly inFlight = new Set<string>();
  // URLs that failed or carry no vector_layers; peek never re-fetches them.
  private readonly unavailable = new Set<string>();
  private readonly listeners = new Set<() => void>();

  // Layers for a TileJSON URL, or undefined when they are not known yet.
  // Schedules the fetch as a side effect; subscribers hear about the result.
  peek(url: string | undefined): TileJsonVectorLayer[] | undefined {
    const key = url?.trim();

    if (!key) return undefined;

    const cached = this.loaded.get(key);

    if (cached) return cached;
    if (this.unavailable.has(key) || this.inFlight.has(key) || !FETCHABLE_URL.test(key)) return undefined;

    this.inFlight.add(key);
    void this.resolve(key)
      .then(tileJson => {
        if (tileJson.vectorLayers) {
          this.loaded.set(key, tileJson.vectorLayers);
        } else {
          // A valid raster or vector TileJSON can declare no layers.
          this.unavailable.add(key);
        }
      })
      .catch((error: unknown) => {
        this.unavailable.add(key);
        logger.debug('TileJSON layers unavailable', { url: key, error });
      })
      .finally(() => {
        this.inFlight.delete(key);
        for (const listener of this.listeners) listener();
      });

    return undefined;
  }

  // Field names and declared types for one source layer of a tileset.
  fields(url: string | undefined, sourceLayer: string | undefined): Record<string, string> | undefined {
    if (!sourceLayer) return undefined;

    return this.peek(url)?.find(layer => layer.id === sourceLayer)?.fields;
  }

  // True while a fetch for this URL is outstanding.
  isLoading(url: string | undefined): boolean {
    const key = url?.trim();

    return Boolean(key && this.inFlight.has(key));
  }

  // Adopt a TileJSON another caller already fetched; block rendering records every vector tileset it resolves.
  record(url: string, tileJson: { vectorLayers?: TileJsonVectorLayer[] }): void {
    const key = url.trim();

    if (!key) return;

    if (tileJson.vectorLayers?.length) {
      this.loaded.set(key, tileJson.vectorLayers);
      this.unavailable.delete(key);
    } else {
      this.unavailable.add(key);
    }

    for (const listener of this.listeners) listener();
  }

  // Notified when any fetch settles.
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.loaded.clear();
    this.unavailable.clear();
    this.inFlight.clear();
  }
}
