import type { MapRenderPlan, MapCameraIntent } from "places-shared/render";
import type { MapSurfaceLifecycleEvent, MapSurfaceLifecycleState } from "places-shared/map";
import type { MapRenderRequest } from "places-shared/settings";

export type MapSurfacePendingReason = 'awaiting-load' | 'awaiting-size' | `temporarily-unavailable:${string}` | `declined-detached:${string}`;

export interface MapSurfaceDriver {
  isAttached(): boolean;
  // True when the container is connected AND has real layout size. False for a background/display:none tab, which is connected but 0-size.
  hasLayoutSize?(): boolean;
  lifecycle(): Readonly<MapSurfaceLifecycleState>;
  onLifecycleEvent(listener: (state: Readonly<MapSurfaceLifecycleState>, event: MapSurfaceLifecycleEvent) => void): () => void;
  // Full surface render into the container (provider.processPlaceCodeBlock path).
  render(plan: MapRenderPlan): Promise<{ rendered: boolean; reason?: string }>;
  // In-place data update of the live map.
  update(previous: MapRenderPlan | null, next: MapRenderPlan): Promise<{ refreshed: boolean; status?: 'requires-rebuild' | 'temporarily-unavailable'; reason?: string }>;
  // Post-creation camera application.
  applyCamera(camera: MapCameraIntent, request: MapRenderRequest): { applied: boolean; reason?: string };
  // Live whole-marker visibility toggle (deny-list of placeIds); absent/no-op on providers that cannot filter markers in place.
  applyMarkerVisibility?(hiddenPlaceIds: readonly string[]): void;
  // Escalation: full block/view rebuild. The controller only calls this while attached.
  rerender(reason: string): Promise<void>;
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

// Reconciler for one map surface. Owns the desired MapRenderPlan and converges
// the live map toward it: renders when nothing is applied, updates in place when
// the plan changes, escalates to a rebuild on structural declines (while attached),
// and applies fit-data camera intent once the surface is loaded and sized.
// Intent is never dropped - unsatisfiable steps go pending and retry on
// lifecycle transitions; intent pending too long WARNs.
//
// Camera policy: only 'fit-data' moves the camera post-creation, and only while
// the user has not taken over the camera. 'explicit' and 'preserve' are fully
// handled at map construction.
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

  // Adopt a surface that was just rendered outside the controller (the factory
  // renders initially through the existing provider path). cameraSatisfied
  // marks whether the construction-time camera could see real layout - a map
  // created at zero size fit garbage bounds and must be re-fit once sized.
  seedApplied(plan: MapRenderPlan, state: { cameraSatisfied: boolean }): void {
    if (this.disposed) return;
    this.desiredPlan = plan;
    this.appliedPlan = plan;
    this.fittedBoundsSignature = plan.camera.kind !== 'fit-data' || state.cameraSatisfied ? plan.boundsSignature : null;
    void this.reconcile();
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

  // Context loss / rehydrate: forget applied state, keep the desired plan, re-render.
  restartSurface(reason: string): void {
    if (this.disposed) return;
    this.driver.debug?.('map surface restart', { reason });
    this.appliedPlan = null;
    this.fittedBoundsSignature = null;
    this.renderFailedSignature = null;
    this.declinedSignature = null;
    // Layers are gone after a context loss; force the visibility filter to reapply.
    this.appliedMarkerVisibilityKey = null;
    void this.reconcile();
  }

  // Single-flight with re-run-when-dirty: overlapping calls fold into one loop,
  // and awaiting resolves once the loop (including the caller's plan) settles.
  reconcile(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.activeReconcile) {
      this.dirty = true;
      return this.activeReconcile;
    }
    const loop = (async () => {
      try {
        do {
          this.dirty = false;
          await this.reconcileOnce();
        } while (this.dirty && !this.disposed);
      } finally {
        this.activeReconcile = null;
      }
    })();
    this.activeReconcile = loop;
    return loop;
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

    if (!this.appliedPlan) {
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
          this.driver.debug?.('map surface update declined; rebuilding', { reason: result.reason });
          // Rebuild tears this controller down and creates a fresh one.
          await this.driver.rerender(result.reason ?? 'update declined');
          return;
        }
        // A rebuild while detached would race Obsidian's reattach of the same
        // elements; hold the intent and retry on the next lifecycle transition.
        this.setPending(`declined-detached:${result.reason ?? 'unknown'}`);
        return;
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
      // Same content rebuilt into a new plan object; adopt without touching the map.
      this.appliedPlan = desired;
    }

    // Live marker visibility rides outside the plan signature (like camera), and a
    // visibility-only parameter change lands here with an unchanged signature -
    // no setData - and is applied with a single setFilter instead.
    this.reconcileMarkerVisibility(this.appliedPlan);

    const applied = this.appliedPlan;
    if (applied.camera.kind === 'fit-data' && this.fittedBoundsSignature !== applied.boundsSignature) {
      const lifecycle = this.driver.lifecycle();
      if (lifecycle.userCameraInteracted) {
        // The user owns the camera now; data-driven fits stop permanently.
        this.driver.debug?.('map surface fit skipped - user owns the camera', { boundsSignature: applied.boundsSignature });
        this.fittedBoundsSignature = applied.boundsSignature;
      } else if (lifecycle.phase !== 'loaded') {
        this.setPending('awaiting-load');
        return;
      } else if (!lifecycle.sized) {
        this.setPending('awaiting-size');
        return;
      } else {
        const result = this.driver.applyCamera(applied.camera, { config: applied.config, runtime: applied.runtime });
        if (result.applied) {
          this.driver.debug?.('map surface camera applied', { camera: applied.camera.kind, boundsSignature: applied.boundsSignature });
        } else {
          this.driver.warn('map surface camera not applied', { reason: result.reason });
        }
        this.fittedBoundsSignature = applied.boundsSignature;
      }
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
