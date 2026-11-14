import type { MapPlace } from "places-shared/place";
import { formatMetricWindow, type TrackInspection, type IPlacesPluginSettings, type MetricWindow } from "places-shared/settings";
import { getSpeedWindow, inspectTrackData } from 'places/core';
export { inspectTrackData } from 'places/core';
import type { TrackData } from 'places-shared/geo';
import { createPerformanceMonitor } from "places-shared/utils";
import { trackPreparation } from './TrackPreparationWorker';
import type { FeatureCollection } from 'geojson';

interface InspectionLoad {
  controller: AbortController;
  promise: Promise<TrackData>;
  consumers: Set<AbortSignal>;
  bytes: number;
  complete: boolean;
  unscopedConsumers: number;
}

export class TrackInspectionService {
  private readonly loadedTracks = new Map<string, InspectionLoad>();
  private readonly geometryIds = new WeakMap<FeatureCollection, number>();
  private nextGeometryId = 0;
  private readonly bindings = new WeakMap<AbortSignal, { key: string; release: () => void }>();
  private readonly maxBytes = 32 * 1024 * 1024;
  constructor(private settings: () => IPlacesPluginSettings, private speedWindow?: MetricWindow) {}

  async inspect(place: MapPlace, coordinate: { latitude: number; longitude: number }, sourcePath: string, signal?: AbortSignal): Promise<TrackInspection | null> {
    const path = place.filePath;
    const geometry = place.overlay?.geojson;

    if (signal?.aborted || !geometry) return null;
    let id = this.geometryIds.get(geometry);

    if (id === undefined) { id = ++this.nextGeometryId; this.geometryIds.set(geometry, id); }
    const speedWindow = place.settings?.trackSpeedWindow ?? this.speedWindow ?? getSpeedWindow();
    const key = `geometry:${id}:${formatMetricWindow(speedWindow)}`;
    const perf = createPerformanceMonitor('track-inspection', { sourcePath, trackPath: path, cached: this.loadedTracks.has(key) }, { enabled: this.settings().developerMode });
    let load = this.loadedTracks.get(key);

    if (!load) {
      const controller = new AbortController();
      const promise = trackPreparation.prepare({ format: 'geojson', geojson: geometry, name: place.name }, speedWindow, controller.signal);

      load = { controller, promise, consumers: new Set(), bytes: 0, complete: false, unscopedConsumers: 0 };
      this.loadedTracks.set(key, load);
      const entry = load;

      void entry.promise.then(data => {
        entry.complete = true;
        entry.bytes = 1024 + (data.points.length + (data.segments?.reduce((n, points) => n + points.length, 0) ?? 0)) * 384;
        this.trim();
      }, () => {
        if (this.loadedTracks.get(key) === entry) this.loadedTracks.delete(key);
      });
    }

    this.loadedTracks.delete(key);
    this.loadedTracks.set(key, load);
    if (!signal) load.unscopedConsumers++;

    if (signal && !load.consumers.has(signal)) {
      this.bindings.get(signal)?.release();
      load.consumers.add(signal);
      const entry = load;
      const release = () => {
        signal.removeEventListener('abort', release);
        this.bindings.delete(signal);
        entry.consumers.delete(signal);
        queueMicrotask(() => {
          if (!entry.complete && !entry.consumers.size && !entry.unscopedConsumers) {
            entry.controller.abort();
            if (this.loadedTracks.get(key) === entry) this.loadedTracks.delete(key);
          }

          this.trim();
        });
      };

      this.bindings.set(signal, { key, release });
      signal.addEventListener('abort', release, { once: true });
    }

    try {
      const data = await perf.measureAsync('load-track', () => load.promise);

      if (signal?.aborted) return null;

      return perf.measure('nearest-point', () => inspectTrackData(data, coordinate, this.settings()), { points: data.points.length });
    } catch (error) {
      if (signal?.aborted) return null;

      throw error;
    } finally {
      if (!signal) load.unscopedConsumers--;
      this.trim();
    }
  }

  private trim(): void {
    let bytes = 0, count = 0;

    for (const entry of this.loadedTracks.values()) {
      if (entry.complete && !entry.consumers.size) { bytes += entry.bytes; count++; }
    }

    for (const [key, entry] of this.loadedTracks) {
      if (!entry.complete || entry.consumers.size || (bytes <= this.maxBytes && count <= 4)) continue;
      this.loadedTracks.delete(key);
      bytes -= entry.bytes;
      count--;
    }
  }
}
