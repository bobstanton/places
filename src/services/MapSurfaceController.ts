import { withPlanCamera, type MapRenderPlan, type MapCameraIntent } from "places-shared/render";
import type { MapSurfaceLifecycleEvent, MapSurfaceLifecycleState } from "places-shared/map";
import type { MapRenderRequest } from "places-shared/settings";

export type MapSurfacePendingReason = 'awaiting-load' | 'awaiting-size' | `temporarily-unavailable:${string}` | `declined-detached:${string}`;

export interface MapSurfaceDriver {
  isAttached(): boolean;
  hasLayoutSize?(): boolean;
  lifecycle(): Readonly<MapSurfaceLifecycleState>;
  onLifecycleEvent(listener: (state: Readonly<MapSurfaceLifecycleState>, event: MapSurfaceLifecycleEvent) => void): () => void;
  render(plan: MapRenderPlan): Promise<{ rendered: boolean; reason?: string }>;
  update(previous: MapRenderPlan | null, next: MapRenderPlan): Promise<{ refreshed: boolean; status?: 'requires-rebuild' | 'temporarily-unavailable'; reason?: string }>;
  applyCamera(camera: MapCameraIntent, request: MapRenderRequest): { applied: boolean; reason?: string };
  rememberFittedViewport?(plan: MapRenderPlan): void;
  applyMarkerVisibility?(hiddenPlaceIds: readonly string[]): void;
  rerender(reason: string): Promise<void>;
  resolveCamera?(plan: MapRenderPlan): MapCameraIntent;
  warn(message: string, details?: Record<string, unknown>): void;
  debug?(message: string, details?: Record<string, unknown>): void;
}

export interface MapSurfaceControllerOptions {
  // Warn when an intent stays pending this long (default 10s, aligned with the provider load timeout).
  pendingWarnMs?: number;
  scheduler?: {
    schedule(fn: () => void, ms: number): number;
    cancel(id: number): void;
  };
  now?: () => number;
  // UI side effects that must run when a plan lands on the surface (help cleanup, floating buttons).
  onPlanApplied?: (plan: MapRenderPlan) => void;
}

export interface MapSurfaceControllerState {
  desiredPlanSignature: string | null;
  appliedPlanSignature: string | null;
  fittedBoundsSignature: string | null;
  pending: { reason: MapSurfacePendingReason; since: number } | null;
  disposed: boolean;
}

export class MapSurfaceController {
  private desiredPlan: MapRenderPlan | null = null;
  private appliedPlan: MapRenderPlan | null = null;
  private fittedBoundsSignature: string | null = null;
  // Signatures held after failure/non-structural decline; retried only when a new plan arrives.
  private renderFailedSignature: string | null = null;
  private declinedSignature: string | null = null;
  // Last-applied live marker-visibility deny-list key; visibility rides outside the plan signature.
  private appliedMarkerVisibilityKey: string | null = null;
  private pending: { reason: MapSurfacePendingReason; since: number } | null = null;
  private pendingWarnTimer: number | null = null;
  private activeReconcile: Promise<void> | null = null;
  private dirty = false;
  private disposed = false;
  private userCameraInteracted = false;
  private fittedLoadingData = false;
  private fittedCameraValid = false;
  private rememberedBoundsSignature: string | null = null;
  private readonly unsubscribeLifecycle: () => void;
  private readonly pendingWarnMs: number;
  private readonly scheduler: NonNullable<MapSurfaceControllerOptions['scheduler']>;
  private readonly now: () => number;

  constructor(private readonly driver: MapSurfaceDriver, private readonly options: MapSurfaceControllerOptions = {}) {
    this.pendingWarnMs = options.pendingWarnMs ?? 10000;
    this.scheduler = options.scheduler ?? {
      schedule: (fn, ms) => window.setTimeout(fn, ms),
      cancel: id => window.clearTimeout(id),
    };
    this.now = options.now ?? (() => Date.now());
    this.unsubscribeLifecycle = driver.onLifecycleEvent(() => {
      if (!this.disposed) void this.reconcile();
    });
  }

  // Every plan change enters here. Never drops intent; latest plan wins.
  setPlan(next: MapRenderPlan, meta?: { source?: string }): void {
    if (this.disposed) return;
    this.desiredPlan = next;
    if (this.renderFailedSignature !== next.signature) this.renderFailedSignature = null;
    if (this.declinedSignature !== next.signature) this.declinedSignature = null;
    this.driver.debug?.('map surface plan set', { source: meta?.source });
    void this.reconcile();
  }

  setMarkerVisibility(hiddenIds: readonly string[]): void {
    if (!this.desiredPlan) return;
    this.setPlan({
      ...this.desiredPlan,
      markerVisibilityHiddenIds: hiddenIds,
      runtime: { ...this.desiredPlan.runtime, markerVisibilityHiddenIds: hiddenIds },
    }, { source: 'marker-filter' });
  }

  restartSurface(reason: string): void {
    if (this.disposed) return;
    this.driver.debug?.('map surface restart', { reason });

    if (this.desiredPlan && this.driver.resolveCamera) {
      this.desiredPlan = withPlanCamera(this.desiredPlan, this.driver.resolveCamera(this.desiredPlan));
    }

    this.appliedPlan = null;
    this.fittedBoundsSignature = null;
    this.fittedCameraValid = false;
    this.rememberedBoundsSignature = null;
    this.renderFailedSignature = null;
    this.declinedSignature = null;
    this.appliedMarkerVisibilityKey = null;
    void this.reconcile();
  }

  reconcile(): Promise<void> {
    if (this.disposed) return Promise.resolve();

    if (this.activeReconcile) {
      this.dirty = true;

      return this.activeReconcile;
    }

    const loop = Promise.resolve().then(async () => {
      try {
        do {
          if (this.disposed) return;
          this.dirty = false;

          await this.reconcileOnce();
        } while (this.dirty && !this.disposed);
      } finally {
        this.activeReconcile = null;
      }
    });

    this.activeReconcile = loop;

    return loop;
  }

  storesPlansOnly(): boolean {
    return !this.appliedPlan && this.driver.hasLayoutSize?.() === false;
  }

  getState(): Readonly<MapSurfaceControllerState> {
    return {
      desiredPlanSignature: this.desiredPlan?.signature ?? null,
      appliedPlanSignature: this.appliedPlan?.signature ?? null,
      fittedBoundsSignature: this.fittedBoundsSignature,
      pending: this.pending ? { ...this.pending } : null,
      disposed: this.disposed,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeLifecycle();
    this.clearPending();
  }

  private async reconcileOnce(): Promise<void> {
    const desired = this.desiredPlan;

    if (!desired) {
      this.clearPending();

      return;
    }

    this.userCameraInteracted ||= this.driver.lifecycle().userCameraInteracted;

    if (!this.appliedPlan) {
      if (this.driver.hasLayoutSize?.() === false) {
        this.setPending('awaiting-size');

        return;
      }

      if (this.renderFailedSignature === desired.signature) return;
      const result = await this.driver.render(desired);

      if (this.disposed) return;

      if (!result.rendered) {
        this.renderFailedSignature = desired.signature;
        this.driver.warn('map surface render failed', { reason: result.reason });

        return;
      }

      this.appliedPlan = desired;
      this.fittedBoundsSignature = desired.camera.kind !== 'fit-data' || this.driver.lifecycle().sized
        ? desired.boundsSignature
        : null;
      this.fittedCameraValid = desired.camera.kind === 'fit-data' && this.driver.lifecycle().sized;
      this.options.onPlanApplied?.(desired);
    }

    if (this.appliedPlan.signature !== desired.signature) {
      if (this.declinedSignature === desired.signature) {
        this.clearPending();

        return;
      }

      const result = await this.driver.update(this.appliedPlan, desired);

      if (this.disposed) return;

      if (result.refreshed) {
        this.appliedPlan = desired;
        this.options.onPlanApplied?.(desired);
      } else if (result.status === 'requires-rebuild') {
        if (this.driver.isAttached()) {
          if (desired.dataState === 'loading' || this.appliedPlan.dataState === 'loading') {
            const camera = this.driver.resolveCamera?.(desired) ?? { kind: 'preserve' as const };
            const rebuilt = await this.driver.render(withPlanCamera(desired, camera));

            if (this.disposed) return;

            if (!rebuilt.rendered) {
              this.declinedSignature = desired.signature;
              this.driver.warn('map surface loading rebuild failed', { reason: rebuilt.reason });

              return;
            }

            this.appliedPlan = desired;
            this.appliedMarkerVisibilityKey = null;
            this.options.onPlanApplied?.(desired);
          } else {
            this.driver.debug?.('map surface update declined; rebuilding', { reason: result.reason });
            await this.driver.rerender(result.reason ?? 'update declined');

            return;
          }
        } else {
          this.setPending(`declined-detached:${result.reason ?? 'unknown'}`);

          return;
        }
      } else if (result.status === 'temporarily-unavailable') {
        this.setPending(`temporarily-unavailable:${result.reason ?? 'unknown'}`);

        return;
      } else {
        this.driver.debug?.('map surface update declined; holding current surface', { reason: result.reason });
        this.declinedSignature = desired.signature;
        this.clearPending();

        return;
      }
    } else if (this.appliedPlan !== desired) {
      const completed = this.appliedPlan.dataState !== desired.dataState;

      this.appliedPlan = desired;
      if (completed) this.options.onPlanApplied?.(desired);
    }

    this.reconcileMarkerVisibility(this.appliedPlan);

    const applied = this.appliedPlan;

    if (applied.camera.kind === 'fit-data' && this.fittedBoundsSignature !== applied.boundsSignature
      && !(applied.dataState === 'loading' && this.fittedLoadingData)) {
      const lifecycle = this.driver.lifecycle();

      if (this.userCameraInteracted || lifecycle.userCameraInteracted) {
        this.driver.debug?.('map surface fit skipped - user owns the camera', { boundsSignature: applied.boundsSignature });
        this.fittedBoundsSignature = applied.boundsSignature;
        if (applied.dataState === 'loading') this.fittedLoadingData = true;
      } else if (lifecycle.phase !== 'loaded') {
        this.setPending('awaiting-load');

        return;
      } else if (!lifecycle.sized) {
        this.setPending('awaiting-size');

        return;
      } else {
        const result = this.driver.applyCamera(applied.camera, { config: applied.config, runtime: applied.runtime });

        this.fittedCameraValid = result.applied;

        if (result.applied) {
          this.driver.debug?.('map surface camera applied', { camera: applied.camera.kind, boundsSignature: applied.boundsSignature });
        } else {
          this.driver.warn('map surface camera not applied', { reason: result.reason });
        }

        this.fittedBoundsSignature = applied.boundsSignature;
        if (applied.dataState === 'loading') this.fittedLoadingData = true;
      }
    }

    const lifecycle = this.driver.lifecycle();

    if (applied.camera.kind === 'fit-data' && applied.dataState !== 'loading'
      && this.fittedCameraValid && this.fittedBoundsSignature === applied.boundsSignature
      && this.rememberedBoundsSignature !== applied.boundsSignature
      && lifecycle.phase === 'loaded' && lifecycle.sized
      && !this.userCameraInteracted && !lifecycle.userCameraInteracted) {
      this.driver.rememberFittedViewport?.(applied);
      this.rememberedBoundsSignature = applied.boundsSignature;
    }

    this.clearPending();
  }

  // Apply the plan's live marker-visibility deny-list when it changed. A plan
  // with `undefined` ids is not a live-visibility block and leaves the map
  // untouched. Idempotent: the same key skips the driver call.
  private reconcileMarkerVisibility(plan: MapRenderPlan): void {
    const hiddenIds = plan.markerVisibilityHiddenIds;

    if (hiddenIds === undefined) return;
    const key = hiddenIds.join('');

    if (key === this.appliedMarkerVisibilityKey) return;
    this.appliedMarkerVisibilityKey = key;
    this.driver.applyMarkerVisibility?.(hiddenIds);
  }

  private setPending(reason: MapSurfacePendingReason): void {
    if (this.pending?.reason === reason) return;
    this.clearPending();
    this.pending = { reason, since: this.now() };
    this.pendingWarnTimer = this.scheduler.schedule(() => {
      this.pendingWarnTimer = null;
      if (!this.pending || this.disposed) return;
      const details = {
        reason: this.pending.reason,
        sinceMs: this.now() - this.pending.since,
        desiredPlan: this.desiredPlan?.signature,
        appliedPlan: this.appliedPlan?.signature,
      };
      // A surface with no layout size is not visible yet: reading-view sections
      // held offscreen (detached) or a background/display:none tab (connected but
      // 0-size). Both apply their intent the moment they are shown and the
      // ResizeObserver reports real size. Only a laid-out surface still stuck is
      // anomalous and worth a warning.
      const notLaidOut = this.driver.hasLayoutSize ? !this.driver.hasLayoutSize() : !this.driver.isAttached();

      if (notLaidOut && (this.pending.reason === 'awaiting-size' || this.pending.reason.startsWith('declined-detached:'))) {
        this.driver.debug?.('map surface intent held while not laid out', details);

        return;
      }

      this.driver.warn('map surface intent pending', details);
    }, this.pendingWarnMs);
  }

  private clearPending(): void {
    if (this.pendingWarnTimer !== null) {
      this.scheduler.cancel(this.pendingWarnTimer);
      this.pendingWarnTimer = null;
    }

    this.pending = null;
  }
}
