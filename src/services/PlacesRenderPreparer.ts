import { MarkdownPostProcessorContext } from "obsidian";
import { applyIconRotation } from "./IconRotationService";
import { getPlaceId, overlayShapeSignature } from "places-shared/track";
import { MapPlace, Overlay, OverlayResult } from "places-shared/overlay";
import { MarkerStyleConfig, MarkerStyleService } from "places-shared/map";
import { CODED_MAP_DEFAULTS, parseMapConfigPatch, type ConfigWarning, type MapBlockSettings, type MapConfigPatch, type MapPrepareSourceTiming, type MapPrepareTimings, type ResolvedMapConfig } from "places-shared/settings";
import { scalarToString, logger, createPerformanceMonitor, fnvHash, stableSignatureCached, PerformanceMonitor } from "places-shared/utils";
import PlacesPlugin from "../main";
import { PlaceDataService } from "./PlaceDataService";
import { OverlayService } from "./OverlayService";
import { RouteOverlayGenerator } from "./RouteOverlayGenerator";
import { getLabelTemplateService, LabelTemplateResult } from "./LabelTemplateService";
import { injectPathLabels } from "./PathLabelService";
import { ParsedCodeBlock, parseCodeBlock } from "./CodeBlockParser";
import { collectTemplateNames, mergeBlockTemplates } from "./BlockTemplate";
import type { TemplateNoteService } from "./TemplateNoteService";
import { resolveMapSettings, type ResolvedMapSettings } from "./MapSettingsResolver";
import { settingsUseParameters } from "./QueryParameters";

// Thrown when a `fromTemplate:` reference does not resolve to a template body.
// A template is a `places-template` block in any note, reached by link.
export class TemplateNotFoundError extends Error {
  constructor(public readonly missingReferences: readonly string[]) {
    super(missingReferences.length === 1
      ? `No template found for "${missingReferences[0]}".`
      : `No template found for: ${missingReferences.join(', ')}.`);
    this.name = 'TemplateNotFoundError';
  }
}

// What a block is currently waiting on, for a loading indicator to name.
// `waiting-for-index` is a shared, whole-vault wait that belongs to VaultQuery's startup.
export type PreparePhase = 'waiting-for-index' | 'querying' | 'building';

export interface PreparedOverlayError {
  path: string;
  error: string;
  type: string;
}

export interface AsyncOverlayLoad {
  promise: Promise<{
    overlays: Overlay[];
    errors: PreparedOverlayError[];
  }>;
}

export interface PreparedPlacesRender {
  parsedBlock: ParsedCodeBlock;
  rawBlockSettings: Record<string, unknown>;
  blockSettings: MapBlockSettings;
  providerName: string;
  resolvedSettings?: ResolvedMapSettings;
  places: MapPlace[];
  labelTemplateResult?: LabelTemplateResult;
  initialOverlays: Overlay[];
  // Refresh mode: load errors for the overlays in initialOverlays (initial mode reports through asyncOverlayLoad).
  overlayErrors?: PreparedOverlayError[];
  asyncOverlayLoad?: AsyncOverlayLoad;
  dataFingerprint: string;
  // True when a refresh collected identical data and post-processing was skipped.
  unchangedData?: boolean;
  // Present when a parameter-driven `markerFilter:` rule runs on a live-capable
  // renderer: `places` holds every collected place (not the filtered subset) and
  // `hiddenIds` is the deny-list applied via setFilter.
  liveVisibility?: { hiddenIds: string[] };
  // Present when `debug:` includes `parameters`: substitution and filter trace for the debug panel.
  parameterDebug?: PreparedParameterDebug;
  // Present when any `debug:` mode is on: substituted markerFilter rules for the popup debug section.
  popupDebug?: { markerFilter: readonly string[] };
  // Query parameter errors raised by the block transform. Carried on the result rather
  // than only through the transform's own callback, which fires for whichever caller
  // owned a coalesced prepare and not for the callers that joined it.
  parameterErrors?: string[];
  // Wall-clock breakdown of this prepare pass, surfaced by the `debug: true` overlay.
  prepareTimings?: MapPrepareTimings;
}

// Substitution and filter trace computed during prepare for `debug: parameters`.
export interface PreparedParameterDebug {
  // Every block setting that referenced {parameter.*}: raw text and the substituted text the block ran with.
  substitutions: Array<{ setting: string; before: string; after: string }>;
  // Per-rule markerFilter results over the collected (pre-filter) places. Absent when the block has no markerFilter.
  markerFilter?: { rules: Array<{ rule: string; valid: boolean; matched: number }>; total: number; kept: number; live: boolean };
  // Union of metadata field names condition evaluation can see, as normalized from the data source.
  fieldNames: string[];
}

// The modes carried by the `debug:` setting, which accepts a comma list (e.g. `debug: true, parameters`).
export interface DebugModes {
  // `true`: the on-map state/viewport/performance overlay.
  overlay: boolean;
  // `settings`: the settings-resolution trace table under the block.
  settings: boolean;
  // `parameters`: the parameter & filter trace under the block.
  parameters: boolean;
  // Any mode is on; enables the popup debug section.
  any: boolean;
}

export function parseDebugModes(value: unknown): DebugModes {
  const tokens = scalarToString(value).toLowerCase().split(',').map(token => token.trim()).filter(Boolean);
  const overlay = tokens.includes('true');
  const settings = tokens.includes('settings');
  const parameters = tokens.includes('parameters');
  return { overlay, settings, parameters, any: overlay || settings || parameters };
}

export interface PreparePlacesRenderOptions {
  source: string;
  ctx: MarkdownPostProcessorContext;
  mode: 'initial' | 'refresh';
  bypassOverlayCache?: boolean;
  // Applied to the parsed block before settings derivation (parameter substitution across query and settings).
  transformBlock?: (parsedBlock: ParsedCodeBlock) => Promise<{ parameterSignature: string; parameterErrors?: string[] }>;
  // Refresh mode: when the newly collected data matches this fingerprint, skip post-processing and return unchangedData.
  previousDataFingerprint?: string;
  // Typed configuration supplied by an extension-owned block.
  mapConfigOverrides?: MapConfigPatch;
  // Whether the resolved provider can toggle marker visibility live (native GL symbol markers). Enables the keep-all-places live path.
  supportsLiveVisibility?: (providerName: string) => boolean;
  // Reports the current wait for a caller showing a loading indicator to name.
  onPhase?: (phase: PreparePhase) => void;
  // In-flight VaultQuery initialization; see VaultQueryService.pendingReadiness.
  vaultQueryReadiness?: () => Promise<void> | null;
}

// A prepare pipeline other callers of the same block can join, and the last
// phase it reported, replayed to a joiner's loading indicator on arrival.
interface InFlightPrepare {
  promise: Promise<PreparedPlacesRender>;
  phase: { listeners: Set<(phase: PreparePhase) => void>; last?: PreparePhase };
}

export class PlacesRenderPreparer {
  constructor(
    private placeDataService: PlaceDataService,
    private overlayService: OverlayService,
    private routeOverlayGenerator?: RouteOverlayGenerator,
    private templateNotes?: TemplateNoteService
  ) {}

  // Templates cascade in list order (later overrides earlier); the block's own
  // keys win over all (shallow per-key). Mutates parsedBlock in place, BEFORE
  // parameter substitution. Templates cannot chain (a nested `fromTemplate` is ignored).
  private async applyBlockTemplate(parsedBlock: ParsedCodeBlock, sourcePath: string): Promise<ConfigWarning[]> {
    const references = collectTemplateNames(parsedBlock.settings);
    if (references.length === 0) {
      mergeBlockTemplates(parsedBlock, []);
      return [];
    }

    const bodies: string[] = [];
    const missing: string[] = [];
    for (const reference of references) {
      // Resolved relative to the note holding the block.
      const body = await this.templateNotes?.readBody(reference, sourcePath);
      if (body === undefined) missing.push(reference);
      else bodies.push(body);
    }
    if (missing.length > 0) {
      throw new TemplateNotFoundError(missing);
    }
    return mergeBlockTemplates(parsedBlock, bodies).map(reference => ({
      path: 'fromTemplate',
      message: `The template references ${reference} with its own fromTemplate. Templates do not chain, so that reference was ignored; move its keys into this template or into the block.`,
    }));
  }

  private readonly inFlight = new Map<string, InFlightPrepare>();
  // Settled results, answering re-renders that arrive after the pipeline finished.
  private readonly completed = new Map<string, { result: PreparedPlacesRender; expiresAt: number }>();
  // Every signal that changes the answer clears the cache outright
  // (MapRefreshService notifies on file and index events, parameter changes,
  // and manual refreshes); the TTL bounds staleness from the inputs nothing
  // signals, such as a plugin settings edit.
  private static readonly COMPLETED_TTL_MS = 5000;

  invalidateCompleted(): void {
    this.completed.clear();
  }

  // Null for requests that must not share a pipeline: a refresh carries one
  // live map's own previousDataFingerprint, an extension-owned block hands in
  // typed config this key cannot summarize, and a cache bypass is a demand for
  // fresh work. The key holds the full source text rather than a hash: a
  // 32-bit collision between two different blocks would silently share a result.
  private static coalesceKey(options: PreparePlacesRenderOptions): string | null {
    if (options.mode !== 'initial' || options.mapConfigOverrides || options.bypassOverlayCache) return null;
    return `${options.ctx.sourcePath}\u0000${options.source}`;
  }

  // Every caller, the one that started the pipeline included, gets a clone; the
  // shared result is never handed out. Copied here are the arrays a caller does
  // take ownership of - map tools contribute into `places`. Everything else
  // (parsedBlock, blockSettings, resolvedSettings, the places themselves) is read.
  private static cloneForCaller(prepared: PreparedPlacesRender): PreparedPlacesRender {
    return {
      ...prepared,
      places: [...prepared.places],
      initialOverlays: [...prepared.initialOverlays],
      asyncOverlayLoad: prepared.asyncOverlayLoad
        ? { promise: prepared.asyncOverlayLoad.promise.then(result => ({ overlays: [...result.overlays], errors: result.errors })) }
        : undefined,
    };
  }

  // Prepare a block for render, joining a concurrent prepare of the same block
  // rather than starting a second one, and answering a repeat of a just-settled
  // prepare from its result.
  //
  // Obsidian re-invokes a markdown post processor on every re-render of the
  // section, and any plugin registering a code block processor after first paint
  // re-renders every open preview. One map in one note has entered prepare 55
  // times inside a second that way, and each invocation ran the query, the style
  // pass and both label passes to completion before the staleness guard threw
  // away all but the last. A storm can also arrive sequentially when the
  // pipeline is fast (a warm desktop prepare runs in hundreds of milliseconds),
  // which is what the completed-result cache covers.
  //
  // The pipeline reads the per-element context for `sourcePath` and nothing else
  // (parameter state keys on block content, not the section's line range), so its
  // result is a function of the block text and the vault. Identical concurrent
  // requests ask one question rather than N, which makes joining exact - two
  // identical blocks in one note included, and that is why the key is
  // content-keyed rather than element-identified.
  //
  // Anything the pipeline reports outward has to reach the callers that joined:
  // phases fan out to every listener, and query parameter errors ride back on
  // the result instead of only through the owning caller's transform callback.
  async prepare(options: PreparePlacesRenderOptions): Promise<PreparedPlacesRender> {
    const key = PlacesRenderPreparer.coalesceKey(options);
    if (!key) return this.runPrepare(options);

    const settled = this.completed.get(key);
    if (settled) {
      if (settled.expiresAt > Date.now()) return PlacesRenderPreparer.cloneForCaller(settled.result);
      this.completed.delete(key);
    }

    const existing = this.inFlight.get(key);
    if (existing) {
      if (options.onPhase) {
        existing.phase.listeners.add(options.onPhase);
        // A joiner arriving mid-pipeline has reported no phase yet; its loading
        // indicator would hold its initial text until the next phase change.
        if (existing.phase.last !== undefined) options.onPhase(existing.phase.last);
      }
      return PlacesRenderPreparer.cloneForCaller(await existing.promise);
    }

    const phase: InFlightPrepare['phase'] = { listeners: new Set(options.onPhase ? [options.onPhase] : []) };
    const promise = this.runPrepare({
      ...options,
      onPhase: next => {
        phase.last = next;
        for (const listener of phase.listeners) listener(next);
      },
    });
    this.inFlight.set(key, { promise, phase });
    try {
      const result = await promise;
      this.storeCompleted(key, result);
      return PlacesRenderPreparer.cloneForCaller(result);
    } finally {
      this.inFlight.delete(key);
    }
  }

  private storeCompleted(key: string, result: PreparedPlacesRender): void {
    // Entries are only otherwise removed on re-access or invalidation; the sweep
    // keeps blocks rendered once and never again from accumulating.
    const now = Date.now();
    for (const [staleKey, entry] of this.completed) {
      if (entry.expiresAt <= now) this.completed.delete(staleKey);
    }
    this.completed.set(key, { result, expiresAt: now + PlacesRenderPreparer.COMPLETED_TTL_MS });
  }

  private async runPrepare(options: PreparePlacesRenderOptions): Promise<PreparedPlacesRender> {
    // Dev-mode pipeline metrics: the phases BEFORE the provider render (query,
    // overlay decompression, labels) are where multi-second refreshes hide -
    // provider monitors only start once rendering begins.
    //
    // The same phases are also totalled into `prepareTimings` below. That copy is
    // independent of the developerMode perf gate because the `debug: true` overlay
    // reports it, and it is what the "Loading places data..." indicator is actually
    // waiting on.
    const prepareStartTime = Date.now();
    const sourceTimings: MapPrepareSourceTiming[] = [];
    const parsedBlock = parseCodeBlock(options.source);
    // A `fromTemplate:` block inherits a named template's keys as defaults; the
    // block's own keys win. Merged here, before substitution and derivation, and
    // the template composes exactly like inline keys (query substitution, track
    // normalization, config resolution all see the merged result).
    const templateWarnings = await this.applyBlockTemplate(parsedBlock, options.ctx?.sourcePath ?? '');
    // Snapshot before substitution mutates settings in place: a `markerFilter:` rule
    // that references a parameter drives the live (setFilter) visibility path.
    const visibleUsesParameters = parsedBlock.settings.markerFilter !== undefined && settingsUseParameters(parsedBlock.settings.markerFilter);
    const debugModes = parseDebugModes(parsedBlock.settings.debug);
    // Pre-substitution snapshot of every parameterized setting, paired with the
    // substituted text after the transform for the `debug: parameters` trace.
    const parameterizedBefore = debugModes.parameters ? captureParameterizedSettings(parsedBlock.settings) : [];
    // Parameter substitution mutates the parsed settings before any derivation,
    // and overlays, directions, and every downstream consumer see final values.
    const transformResult = options.transformBlock ? await options.transformBlock(parsedBlock) : undefined;
    const parameterSignature = transformResult?.parameterSignature ?? '';
    const parameterErrors = transformResult?.parameterErrors;
    const rawBlockSettings = getRawBlockSettings(parsedBlock);
    // One parse of the block YAML, shared by collection (this object) and rendering (the same
    // patch is handed to resolveMapSettings, which does not re-parse). blockSettings is the patch
    // with coded defaults applied; it stays mutable because processStyles appends badge CSS to it.
    const configInput = omitNonMapSettings(rawBlockSettings);
    // `debug:` accepts a comma list of modes; the map config layer only knows
    // the boolean overlay flag, and takes the parsed token instead of the raw
    // string (which optionalBoolean would read as false for any combination).
    if (parsedBlock.settings.debug !== undefined) {
      configInput.debug = debugModes.overlay;
    }
    const configWarnings: ConfigWarning[] = [...templateWarnings];
    const blockPatch = parseMapConfigPatch(configInput, configWarnings);
    const blockSettings: MapBlockSettings = { ...CODED_MAP_DEFAULTS, ...blockPatch };
    const providerName = PlacesPlugin.resolveMapProvider(blockSettings.mapProvider);
    // Live visibility needs native GL symbol markers: a parameter-driven `markerFilter:`
    // rule then toggles markers via setFilter instead of re-collecting places.
    const liveVisibilityEligible = visibleUsesParameters
      && blockSettings.markerRenderer !== 'html'
      && (options.supportsLiveVisibility?.(providerName) ?? false);
    const perf = createPerformanceMonitor('places-prepare', {
      mode: options.mode,
      bypassOverlayCache: Boolean(options.bypassOverlayCache),
      provider: providerName,
      sourcePath: options.ctx.sourcePath,
      blockSignature: fnvHash(options.source),
    }, { enabled: PlacesPlugin.settings.developerMode });

    const overlaysSetting = parsedBlock.settings.overlays;

    const hasRequestedOverlayWork = Boolean(overlaysSetting);
    const hasGeneratedOverlayWork = Boolean(blockSettings.directions || blockSettings.isochrones);
    const hasAsyncOverlayWork = hasRequestedOverlayWork || hasGeneratedOverlayWork;

    // Only a query blocks on VaultQuery; frontmatter and embedded places keep the
    // caller's own wording. Readiness always settles before collect returns, and the
    // handoff to 'querying' cannot land on top of a later phase.
    if (blockSettings.query) {
      const readiness = options.vaultQueryReadiness?.() ?? null;
      if (readiness) {
        options.onPhase?.('waiting-for-index');
        void readiness.then(() => options.onPhase?.('querying'), () => options.onPhase?.('querying'));
      } else {
        options.onPhase?.('querying');
      }
    }

    const collectStarted = Date.now();
    const collectedPlaces = await perf.measureAsync('collect-places', () => this.placeDataService.collectAllPlaces(blockSettings, options.ctx, perf, sourceTimings), { hasQuery: Boolean(blockSettings.query), hasDataview: Boolean(blockSettings.dataview) });
    const collectMs = Date.now() - collectStarted;
    options.onPhase?.('building');
    // Whole-marker visibility (`markerFilter:` conditions, already parameter-substituted):
    // hidden places drop, taking icon + label together, on every renderer. When the
    // rule is parameter-driven on a live-capable renderer, keep every place in the
    // source instead and hand the hidden ids to the setFilter path, and a toggle
    // reconciles without a marker rebuild (the plan signature stays identical).
    const visibleRules = normalizeVisibilityRules(parsedBlock.settings.markerFilter);
    let places: MapPlace[];
    let liveVisibility: { hiddenIds: string[] } | undefined;
    if (liveVisibilityEligible) {
      places = collectedPlaces;
      const visibleIds = new Set(MarkerStyleService.filterVisiblePlaces(collectedPlaces, visibleRules).map(getPlaceId));
      liveVisibility = { hiddenIds: collectedPlaces.filter(place => !visibleIds.has(getPlaceId(place))).map(getPlaceId) };
    } else {
      places = MarkerStyleService.filterVisiblePlaces(collectedPlaces, visibleRules);
    }
    const popupDebug = debugModes.any ? { markerFilter: visibleRules } : undefined;
    // Computed against the collected (pre-filter) places, leaving hidden counts
    // visible; runs before the unchanged-data skip, and the trace always updates.
    const parameterDebug: PreparedParameterDebug | undefined = debugModes.parameters
      ? (() => {
          const explanation = MarkerStyleService.explainMarkerFilter(collectedPlaces, visibleRules);
          return {
            substitutions: parameterizedBefore.map(({ setting, before }) => ({ setting, before, after: displaySettingValue(parsedBlock.settings[setting]) })),
            markerFilter: visibleRules.length > 0
              ? { rules: explanation.rules, total: explanation.total, kept: explanation.kept, live: Boolean(liveVisibility) }
              : undefined,
            fieldNames: explanation.fieldNames,
          };
        })()
      : undefined;

    // Cheap content fingerprint of the collected data. When a refresh collects
    // identical data, the expensive per-place post-processing (styles, labels)
    // and the provider round-trip are pure waste - the caller short-circuits.
    // Fold the parameter signature into the fingerprint, keeping a parameter
    // change that only affects settings (an overlay path, an isochrone range)
    // out of the unchanged-data skip even when the collected places are identical.
    const fingerprintSource = parameterSignature ? `${options.source}\u0001${parameterSignature}` : options.source;
    const fingerprintStarted = Date.now();
    const dataFingerprint = perf.measure('fingerprint', () => computePlaceDataFingerprint(places, fingerprintSource), { places: places.length });
    const fingerprintMs = Date.now() - fingerprintStarted;
    const buildPrepareTimings = (stylesMs: number, labelsMs: number): MapPrepareTimings => ({
      startTime: prepareStartTime,
      collectMs,
      sources: sourceTimings,
      fingerprintMs,
      stylesMs,
      labelsMs,
      totalMs: Date.now() - prepareStartTime,
    });
    // The fingerprint covers collected places only, not overlay content - an
    // overlay-only block fingerprints identically forever. A manual refresh
    // (bypassOverlayCache) always takes the full path, reloading overlays.
    const hasSelfReferencingQuery = typeof parsedBlock.settings.query === 'string' && /\{this\./i.test(parsedBlock.settings.query);
    if (options.mode === 'refresh' && !options.bypassOverlayCache && !hasSelfReferencingQuery && options.previousDataFingerprint !== undefined && options.previousDataFingerprint === dataFingerprint) {
      perf.mark('skipped-unchanged', { places: places.length });
      return { parsedBlock, rawBlockSettings, blockSettings, providerName, places, labelTemplateResult: undefined, initialOverlays: [], dataFingerprint, unchangedData: true, parameterDebug, popupDebug, parameterErrors, prepareTimings: buildPrepareTimings(0, 0) };
    }

    // Resolve the block > global waypoint-label cascade here (overlays load before the full settings
    // merge). OverlayService applies the coded default when this is undefined.
    const waypointLabelTemplate = blockSettings.waypointLabelTemplate ?? (PlacesPlugin.settings.waypointLabelTemplate || undefined);
    const overlayLoadPromise = overlaysSetting
      ? this.overlayService.loadOverlays(overlaysSetting, waypointLabelTemplate)
      : Promise.resolve({ overlays: [], errors: [] });

    const stylesStarted = Date.now();
    perf.measure('process-styles', () => this.processStyles(places, blockSettings, perf), { places: places.length });
    const stylesMs = Date.now() - stylesStarted;
    const resolvedSettings = resolveMapSettings({
      providerName,
      // The block was already parsed above (blockPatch); resolveMapSettings reuses it as the
      // block layer instead of re-parsing. blockOverrides carries the badge CSS that processStyles
      // appended to blockSettings.css, plus any programmatic overrides.
      rawBlockSettings: configInput,
      blockPatch,
      warnings: configWarnings,
      blockOverrides: {
        ...(blockSettings.css !== configInput.css ? { css: blockSettings.css } : {}),
        ...(options.mapConfigOverrides ?? {}),
      },
      placeCount: places.length,
    });
    const labelsStarted = Date.now();
    const labelTemplateResult = await perf.measureAsync('process-labels', () => this.processLabels(places, blockSettings));
    // After labels: both read the same per-place context, and rotation is
    // independent of the CSS style pass, and ordering against it does not matter.
    await perf.measureAsync('resolve-icon-rotation', () => applyIconRotation(places, blockSettings.iconRotation));
    await perf.measureAsync('inject-path-labels', () => injectPathLabels(places, blockSettings, PlacesPlugin.settings));
    const labelsMs = Date.now() - labelsStarted;
    if (options.mode === 'refresh') {
      const [overlayResult, generatedOverlayResult] = await perf.measureAsync('load-overlays', () => Promise.all([
        overlayLoadPromise,
        this.generateRouteOverlays(resolvedSettings.config, places, providerName, options.ctx, options.bypassOverlayCache)
      ]));
      perf.mark('complete', { places: places.length, overlays: overlayResult.overlays.length + generatedOverlayResult.overlays.length });

      return {
        parsedBlock,
        rawBlockSettings,
        blockSettings,
        providerName,
        resolvedSettings,
        places,
        labelTemplateResult,
        dataFingerprint,
        initialOverlays: [
          ...overlayResult.overlays,
          ...generatedOverlayResult.overlays,
        ],
        overlayErrors: [
          ...overlayResult.errors.map(e => ({ ...e, type: 'Overlay' })),
          ...generatedOverlayResult.errors.map(e => ({ ...e, type: 'Overlay' })),
        ],
        liveVisibility,
        parameterDebug,
        popupDebug,
        parameterErrors,
        prepareTimings: buildPrepareTimings(stylesMs, labelsMs),
      };
    }

    const asyncOverlayLoad = hasAsyncOverlayWork
      ? this.createAsyncOverlayLoad({
        overlayLoadPromise,
        places,
        providerName,
        ctx: options.ctx,
        config: resolvedSettings.config,
      })
      : undefined;

    perf.mark('complete', { places: places.length, overlaysDeferred: Boolean(asyncOverlayLoad) });

    return {
      parsedBlock,
      rawBlockSettings,
      blockSettings,
      providerName,
      resolvedSettings,
      places,
      labelTemplateResult,
      dataFingerprint,
      initialOverlays: [],
      asyncOverlayLoad,
      liveVisibility,
      parameterDebug,
      popupDebug,
      parameterErrors,
      prepareTimings: buildPrepareTimings(stylesMs, labelsMs),
    };
  }

  // No query, dataview, or embedded places: the map renders the note's own frontmatter location.
  private isSelfNoteMap(blockSettings: MapBlockSettings): boolean {
    return !blockSettings.query && !blockSettings.dataview && !blockSettings.embeddedPlaces;
  }

  // Global default rules run before the block's own rules. Zoom-visibility declarations in
  // the defaults are dropped on self-note maps - de-emphasis rules assume a crowd, and
  // zoom-hiding a map's only subject reads as a broken map. Block rules apply verbatim.
  private getStyleRules(defaultRules: string | undefined, blockRules: string | readonly string[] | undefined, blockSettings: MapBlockSettings) {
    const defaults = MarkerStyleService.parseRules(defaultRules);
    const applicableDefaults = this.isSelfNoteMap(blockSettings) ? MarkerStyleService.withoutZoomVisibility(defaults) : defaults;
    return [...applicableDefaults, ...MarkerStyleService.parseRules(blockRules)];
  }

  private processStyles(places: MapPlace[], blockSettings: MapBlockSettings, perf: PerformanceMonitor): void {
    const styleConfig: MarkerStyleConfig = {
      css: blockSettings.css,
      iconStyles: this.getStyleRules(PlacesPlugin.settings.defaultIconStyles, blockSettings.iconStyles, blockSettings),
      labelStyles: this.getStyleRules(PlacesPlugin.settings.defaultLabelStyles, blockSettings.labelStyles, blockSettings)
    };
    const styleProfile = perf.measure(
      'style-apply',
      () => MarkerStyleService.processPlaces(places, styleConfig, { profile: PlacesPlugin.settings.developerMode }),
      { places: places.length }
    );
    if (styleProfile) {
      perf.mark('style-profile', {
        places: styleProfile.places,
        totalMs: roundProfileMs(styleProfile.totalMs),
        metadataContextMs: roundProfileMs(styleProfile.metadataContextMs),
        attributesAndZoomMs: roundProfileMs(styleProfile.attributesAndZoomMs),
        dataAttributesMs: roundProfileMs(styleProfile.dataAttributesMs),
        zoomRangesMs: roundProfileMs(styleProfile.zoomRangesMs),
        iconStyleMs: roundProfileMs(styleProfile.iconStyleMs),
        labelStyleMs: roundProfileMs(styleProfile.labelStyleMs),
        instrumentationMs: roundProfileMs(Math.max(0, styleProfile.totalMs - styleProfile.metadataContextMs - styleProfile.attributesAndZoomMs - styleProfile.iconStyleMs - styleProfile.labelStyleMs)),
      });
    }

    // HTML-renderer counterpart of the symbol badge compositing: badge rules become
    // ::before classes, injected with the block's own CSS.
    const badgeCss = perf.measure('style-badge-css', () => MarkerStyleService.buildBadgeCss(places), { places: places.length });
    if (badgeCss) {
      blockSettings.css = [blockSettings.css, badgeCss].filter(Boolean).join('\n');
    }
  }

  private async processLabels(places: MapPlace[], blockSettings: MapBlockSettings): Promise<LabelTemplateResult | undefined> {
    const labelTemplate = blockSettings.labelTemplate || PlacesPlugin.settings.defaultLabelTemplate;
    if (!labelTemplate) {
      return undefined;
    }

    const labelService = getLabelTemplateService();
    const result = await labelService.processPlaces(places, labelTemplate);
    if (result.errors.length > 0) {
      logger.warn(`${result.errors.length} label template error(s)`);
    }
    return result;
  }

  private async generateRouteOverlays(
    config: ResolvedMapConfig,
    places: MapPlace[],
    providerName: string,
    ctx: MarkdownPostProcessorContext,
    bypassCache?: boolean
  ): Promise<OverlayResult> {
    return this.routeOverlayGenerator
      ? this.routeOverlayGenerator.generateForBlock(
        config,
        places,
        providerName,
        ctx,
        { bypassCache },
      )
      : { overlays: [], errors: [] };
  }

  private createAsyncOverlayLoad(options: {
    overlayLoadPromise: Promise<OverlayResult>;
    places: MapPlace[];
    providerName: string;
    ctx: MarkdownPostProcessorContext;
    config: ResolvedMapConfig;
  }): AsyncOverlayLoad {
    return {
      promise: Promise.all([
        options.overlayLoadPromise.then(overlayResult => {
          if (overlayResult.errors.length > 0) {
            logger.warn(`${overlayResult.errors.length} overlay(s) failed to load`);
          }
          return {
            overlays: overlayResult.overlays,
            errors: overlayResult.errors.map(e => ({ ...e, type: 'Overlay' })),
          };
        }),
        this.generateRouteOverlays(options.config, options.places, options.providerName, options.ctx)
          .then(result => ({
            overlays: result.overlays,
            errors: result.errors.map(e => ({ ...e, type: 'Overlay' })),
          })),
      ]).then(([requested, generated]) => ({
        overlays: [...requested.overlays, ...generated.overlays],
        errors: [...requested.errors, ...generated.errors],
      }))
    };
  }
}

function roundProfileMs(value: number): number {
  return Math.round(value * 10) / 10;
}

function getRawBlockSettings(parsedBlock: ParsedCodeBlock): Record<string, unknown> {
  return {
    ...parsedBlock.settings,
    ...(parsedBlock.embeddedPlaces !== undefined ? { embeddedPlaces: parsedBlock.embeddedPlaces } : {}),
  };
}

// Entries of the parsed block whose values reference {parameter.*}, snapshotted before substitution.
function captureParameterizedSettings(settings: Record<string, unknown>): Array<{ setting: string; before: string }> {
  return Object.entries(settings)
    .filter(([, value]) => settingsUseParameters(value))
    .map(([setting, value]) => ({ setting, before: displaySettingValue(value) }));
}

// A block setting value as display text for the debug trace: strings verbatim, lists one entry per line.
function displaySettingValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(entry => `- ${displaySettingValue(entry)}`).join('\n');
  if (value && typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

// The `markerFilter:` value (a single condition string or a YAML list) as a rule list.
function normalizeVisibilityRules(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(entry => String(entry).trim()).filter(entry => entry.length > 0);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  return [];
}

function omitNonMapSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const mapSettings = { ...settings };
  delete mapSettings.overlays;
  delete mapSettings.heatmapLayer;
  delete mapSettings.heatmapColorScheme;
  return mapSettings;
}

// Content fingerprint over everything a map render can observe from the
// collected places plus the block source itself: identity, position, marker
// inputs, frontmatter metadata, and overlay shape (feature/coordinate counts
// plus endpoints). Deliberately avoids serializing full overlay geometry -
// that is what made per-marker payloads expensive on 25k-note vaults.
export function computePlaceDataFingerprint(places: MapPlace[], source: string): string {
  const parts: string[] = [source, String(places.length)];
  for (const place of places) {
    parts.push(
      getPlaceId(place), place.name, place.icon,
      String(place.latitude), String(place.longitude),
      place.filePath ?? '', String(place.trackDefaultVisibility ?? ''),
      place.queryRow ? stableSignatureCached(place.queryRow) : '',
      place.metadata ? stableSignatureCached(place.metadata) : '',
      overlayShapeSignature(place),
    );
  }
  return fnvHash(parts.join('\u0001'));
}
