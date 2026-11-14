import { GpxParser, parseTrackContent, type TrackContent } from 'places/core';
import type { TrackData } from 'places-shared/geo';
import type { MetricWindow } from 'places-shared/settings';
import type { TrackPreparationRequest, TrackPreparationResponse } from '../workers/TrackPreparationProtocol';
import { unpackTrackData } from '../workers/PackedTrackData';
import { geoJsonFootprint } from "places-shared/geo";
// @ts-expect-error esbuild-plugin-inline-worker supplies the Worker constructor.
import TrackWorker from '../workers/track-preparation.worker';

export class TrackPreparationWorkerError extends Error {}

export class TrackPreparationQueue {
  private readonly jobs: Array<() => void> = [];
  private readonly cancellations = new Set<() => void>();
  private busy = false;
  private disposed = false;

  constructor(private readonly createWorker: (() => Worker) | undefined) {}

  prepare(input: TrackContent, speedWindow: MetricWindow, signal?: AbortSignal): Promise<TrackData> {
    if (this.disposed || signal?.aborted) return Promise.reject(new DOMException('Track preparation canceled', 'AbortError'));
    const size = 'geojson' in input ? geoJsonFootprint(input.geojson).estimatedBytes : input.content.length;

    if (!this.createWorker || size < 256 * 1024) {
      return Promise.resolve().then(() => {
        signal?.throwIfAborted();
        if (this.disposed) throw new DOMException('Track preparation canceled', 'AbortError');

        return parseTrackContent(input, speedWindow);
      });
    }

    return new Promise<TrackData>((resolve, reject) => {
      let worker: Worker | undefined;
      let active = false;
      let done = false;
      const handoff = new AbortController();
      const finish = (track?: TrackData, error?: unknown) => {
        if (done) return;
        done = true;
        handoff.abort();
        worker?.terminate();
        signal?.removeEventListener('abort', cancel);
        this.cancellations.delete(cancel);
        const index = this.jobs.indexOf(start);

        if (index >= 0) this.jobs.splice(index, 1);

        if (track) resolve(track);
        else reject(error instanceof Error || error instanceof DOMException ? error : new Error(String(error)));

        if (active) {
          this.busy = false;
          queueMicrotask(() => this.drain());
        }
      };
      const cancel = () => finish(undefined, new DOMException('Track preparation canceled', 'AbortError'));
      const start = () => {
        active = true;

        try {
          signal?.throwIfAborted();

          try {
 worker = this.createWorker!(); 
}
          catch (error) {
 throw new TrackPreparationWorkerError(error instanceof Error ? error.message : String(error)); 
}

          worker.onmessage = (event: MessageEvent<TrackPreparationResponse>) => {
            if (done) return;

            if ('track' in event.data) {
              worker?.terminate();
              worker = undefined;
              void unpackTrackData(event.data.track, handoff.signal).then(track => finish(track), error => finish(undefined, error));
            }
            else finish(undefined, new Error(event.data.error));
          };

          worker.onerror = event => { event.preventDefault(); finish(undefined, new TrackPreparationWorkerError(event.message)); };
          worker.onmessageerror = () => finish(undefined, new TrackPreparationWorkerError('Track preparation response could not be read'));
          const request: TrackPreparationRequest = {
            input: input.format === 'gpx' ? { format: 'gpx-model', model: GpxParser.parseModel(typeof input.content === 'string' ? input.content : new TextDecoder('utf-8', { fatal: true }).decode(input.content)) } : input,
            speedWindow,
          };

          try {
 worker.postMessage(request); 
}
          catch (error) {
 throw new TrackPreparationWorkerError(error instanceof Error ? error.message : String(error)); 
}
        } catch (error) {
 finish(undefined, error); 
}
      };

      this.cancellations.add(cancel);
      signal?.addEventListener('abort', cancel, { once: true });
      this.jobs.push(start);
      this.drain();
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const cancel of this.cancellations) cancel();
  }

  private drain(): void {
    if (this.busy || this.disposed) return;
    const next = this.jobs.shift();

    if (!next) return;
    this.busy = true;
    next();
  }
}

export const trackPreparation = new TrackPreparationQueue(typeof Worker === 'undefined'
  ? undefined : () => new (TrackWorker as unknown as new () => Worker)());
