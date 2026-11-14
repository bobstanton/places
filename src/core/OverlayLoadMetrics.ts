export type OverlayLoadPhase = 'normalize' | 'place' | 'decode' | 'parse' | 'extract';

export class OverlayLoadMetrics {
  readonly phaseMs: Record<OverlayLoadPhase, number> = { normalize: 0, place: 0, decode: 0, parse: 0, extract: 0 };
  readonly phaseFailures: Record<OverlayLoadPhase, number> = { normalize: 0, place: 0, decode: 0, parse: 0, extract: 0 };
  readonly counts = {
    cacheHits: 0, cacheMisses: 0, cacheBypasses: 0, cacheFallbacks: 0,
    storedChars: 0, decodedChars: 0, binaryBytes: 0, compressedFields: 0, plainFields: 0,
    deferredOverlays: 0, processedRows: 0, skippedRows: 0, rowFailures: 0, yields: 0,
  };
  yieldMs = 0;
  maxRowMs = 0;
  private active?: { childrenMs: number };

  measure<T>(phase: OverlayLoadPhase, work: () => T): T {
    const parent = this.active;
    const span = { childrenMs: 0 };

    this.active = span;
    const started = performance.now();

    try {
      return work();
    } catch (error) {
      this.phaseFailures[phase]++;

      throw error;
    } finally {
      const elapsed = performance.now() - started;

      this.phaseMs[phase] += elapsed - span.childrenMs;
      if (parent) parent.childrenMs += elapsed;
      this.active = parent;
    }
  }
}
