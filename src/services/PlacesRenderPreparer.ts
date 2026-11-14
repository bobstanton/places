import { QueryPreparationCanceled, type VaultQueryPlaceResult } from './VaultQueryService';
import { MarkdownPostProcessorContext } from "obsidian";
import { applyIconRotation } from "./IconRotationService";
import { applyIconImages } from "./IconImageService";
import { getPlaceId, overlayShapeSignature } from "places-shared/track";
import { MapPlace, Overlay, OverlayResult } from "places-shared/overlay";
import { MarkerStyleConfig, MarkerStyleService } from "places-shared/map";
import { CODED_MAP_DEFAULTS, parseMapConfigPatch, type ConfigWarning, type MapBlockSettings, type MapConfigPatch, type MapPrepareSourceTiming, type MapPrepareTimings, type ResolvedMapConfig } from "places-shared/settings";
import { scalarToString, logger, createPerformanceMonitor, fnvHash, stableSignature, stableSignatureCached, PerformanceMonitor, reportHeapPressure } from "places-shared/utils";
import PlacesPlugin from "../main";
import { PlaceDataService } from "./PlaceDataService";
import { applyPlaceTrackSettings } from "./MapPlaceFactory";
import { OverlayService } from "./OverlayService";
import { RouteOverlayGenerator } from "./RouteOverlayGenerator";
import { getLabelTemplateService, LabelTemplateResult, type PlaceLabelOutcome } from "./LabelTemplateService";
import { injectPathLabels } from "./PathLabelService";
import { PlaceLabelCaches } from './LabelResultCache';
import { ParsedCodeBlock, parseCodeBlock } from 'places/core';
import { collectTemplateNames, mergeBlockTemplates, optsOutOfDefaultTemplate } from 'places/core';
import type { TemplateNoteService } from "./TemplateNoteService";
import { resolveMapSettings, type ResolvedMapSettings } from "./MapSettingsResolver";
import { settingsUseParameters, type QueryParameterMapMarker } from "places/core";
import type { MapDataChange } from './MapRefreshService';
import { queryReadsTables } from "./QueryTableScope";

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
  sourcesUnreadable?: boolean;
  queryErrors?: VaultQueryPlaceResult['errors'];
  labelTemplateResult?: LabelTemplateResult;
  initialOverlays: Overlay[];
  overlayErrors?: PreparedOverlayError[];
  asyncOverlayLoad?: AsyncOverlayLoad;
  dataFingerprint: string;
  collectionSignature: string;
  unchangedData?: boolean;
  isDataStale?: () => boolean;
  liveVisibility?: { hiddenIds: string[] };
  parameterDebug?: PreparedParameterDebug;
  popupDebug?: { markerFilter: readonly string[] };
  parameterErrors?: string[];
  prepareTimings?: MapPrepareTimings;
}

export interface CollectedPlaces {
  signature: string;
  places: MapPlace[];
  queryErrors?: VaultQueryPlaceResult['errors'];
}

export function collectedPlacesOf(prepared: PreparedPlacesRender): CollectedPlaces | undefined {
  if (!prepared.liveVisibility) return undefined;

  return { signature: prepared.collectionSignature, places: [...prepared.places], queryErrors: prepared.queryErrors };
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
  transformBlock?: (parsedBlock: ParsedCodeBlock) => Promise<{
    parameterSignature: string;
    parameterErrors?: string[];
    parameterMarkers?: QueryParameterMapMarker[];
  }>;
  previousDataFingerprint?: string;
  collectionReuse?: CollectedPlaces;
  mapConfigOverrides?: MapConfigPatch;
  supportsLiveVisibility?: (providerName: string) => boolean;
  onPhase?: (phase: PreparePhase) => void;
  vaultQueryReadiness?: () => Promise<void> | null;
  onSettingsReady?: (settings: PreparedMapSettings) => void;
  onBatch?: (prepared: PreparedPlacesRender) => Promise<void>;
  isPriorityPlace?: (place: MapPlace) => boolean;
  isCanceled?: () => boolean;
}

export type PreparedMapSettings = Pick<PreparedPlacesRender, 'rawBlockSettings' | 'blockSettings' | 'providerName'> & {
  resolvedSettings: ResolvedMapSettings;
};

interface InFlightPrepare {
  promise: Promise<PreparedPlacesRender>;
  phase: { listeners: Set<(phase: PreparePhase) => void>; last?: PreparePhase };
  settings: { listeners: Set<(settings: PreparedMapSettings) => void>; last?: PreparedMapSettings };
  callers: Set<PreparePlacesRenderOptions>;
}

export class PlacesRenderPreparer {
  constructor(
    private placeDataService: PlaceDataService,
    private overlayService: OverlayService,
    private routeOverlayGenerator?: RouteOverlayGenerator,
    private templateNotes?: TemplateNoteService,
    private defaultTemplate?: () => string
  ) {}

  private async applyBlockTemplate(parsedBlock: ParsedCodeBlock, sourcePath: string): Promise<ConfigWarning[]> {
    const references = collectTemplateNames(parsedBlock.settings);
    const vaultDefault = optsOutOfDefaultTemplate(parsedBlock.settings) ? undefined : this.defaultTemplate?.().trim();

    if (references.length === 0 && !vaultDefault) {
      mergeBlockTemplates(parsedBlock, []);

      return [];
    }

    const warnings: ConfigWarning[] = [];
    const bodies: string[] = [];

    if (vaultDefault) {
      const body = await this.templateNotes?.readBody(vaultDefault, sourcePath);

      if (body === undefined) {
        warnings.push({
          path: 'defaultTemplate',
          message: `The default template ${vaultDefault} was not found. Check the note exists and holds a places-template block, or clear the setting.`,
        });
      } else {
        bodies.push(body);
      }
    }

    const missing: string[] = [];

    for (const reference of references) {
      const body = await this.templateNotes?.readBody(reference, sourcePath);

      if (body === undefined) missing.push(reference);
      else bodies.push(body);
    }

    if (missing.length > 0) {
      throw new TemplateNotFoundError(missing);
    }

    warnings.push(...mergeBlockTemplates(parsedBlock, bodies).map(reference => ({
      path: 'fromTemplate',
      message: `The template references ${reference} with its own fromTemplate. Templates do not chain, so that reference was ignored; move its keys into this template or into the block.`,
    })));

    return warnings;
  }

  private readonly inFlight = new Map<string, InFlightPrepare>();
  private readonly labelCaches = new PlaceLabelCaches();
  private readonly preparedGenerations = new Map<string, { rows: WeakMap<MapPlace, MapPlace>; labels: WeakMap<MapPlace, PlaceLabelOutcome> }>();
  private static readonly PREPARED_GENERATIONS = 8;
  // Settled results, answering re-renders that arrive after the pipeline finished.
  private readonly completed = new Map<string, { result: PreparedPlacesRender; expiresAt: number }>();
  private static readonly COMPLETED_TTL_MS = 5000;
  private generation = 0;
  private dataviewGeneration = 0;
  private scopedChanges: Array<{ id: number; tables: readonly string[] }> = [];
  private scopedChangeId = 0;
  private static readonly SCOPED_CHANGE_HISTORY = 50;

  private preparedGeneration(key: string): { rows: WeakMap<MapPlace, MapPlace>; labels: WeakMap<MapPlace, PlaceLabelOutcome> } {
    let generation = this.preparedGenerations.get(key);

    if (generation) this.preparedGenerations.delete(key);
    else generation = { rows: new WeakMap(), labels: new WeakMap() };

    this.preparedGenerations.set(key, generation);
    while (this.preparedGenerations.size > PlacesRenderPreparer.PREPARED_GENERATIONS) this.preparedGenerations.delete(this.preparedGenerations.keys().next().value!);

    return generation;
  }

  invalidateCompleted(change: MapDataChange = 'all'): void {
    if (typeof change === 'object') {
      this.scopedChangeId++;
      this.scopedChanges.push({ id: this.scopedChangeId, tables: change.tables });
      if (this.scopedChanges.length > PlacesRenderPreparer.SCOPED_CHANGE_HISTORY) this.scopedChanges.shift();

      for (const [key, entry] of this.completed) {
        if (PlacesRenderPreparer.readsChangedTables(entry.result.blockSettings.query, change.tables)) this.completed.delete(key);
      }

      return;
    }

    if (change === 'dataview') {
      this.dataviewGeneration++;

      for (const [key, entry] of this.completed) {
        if (entry.result.blockSettings.dataview) this.completed.delete(key);
      }

      for (const [key, entry] of this.inFlight) {
        if (entry.settings.last?.blockSettings.dataview) this.inFlight.delete(key);
      }

      return;
    }

    this.completed.clear();
    this.inFlight.clear();
    this.generation++;
  }

  private static readsChangedTables(query: string | undefined, tables: readonly string[]): boolean {
    return queryReadsTables(query, tables);
  }

  private scopedDataChanged(since: number, settings: PreparedMapSettings | undefined): boolean {
    if (this.scopedChanges.length && since < this.scopedChanges[0].id - 1) return true;
    const changes = this.scopedChanges.filter(change => change.id > since);

    if (!changes.length) return false;
    if (!settings) return true;
    const query = settings.blockSettings.query;

    if (!query) return false;

    return changes.some(change => queryReadsTables(query, change.tables));
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

  async prepare(options: PreparePlacesRenderOptions): Promise<PreparedPlacesRender> {
    const dataviewGeneration = this.dataviewGeneration;
    const key = PlacesRenderPreparer.coalesceKey(options);

    if (!key) {
      if (options.mode !== 'initial') return this.runPrepare(options);
      const generation = this.generation;
      const scopedSince = this.scopedChangeId;
      let usesDataview = false;
      let lastSettings: PreparedMapSettings | undefined;
      const result = await this.runPrepare({
        ...options,
        onSettingsReady: settings => {
          usesDataview = Boolean(settings.blockSettings.dataview);
          lastSettings = settings;
          options.onSettingsReady?.(settings);
        },
        isCanceled: () => generation !== this.generation
          || (usesDataview && dataviewGeneration !== this.dataviewGeneration)
          || options.isCanceled?.() === true,
      });

      return { ...result, isDataStale: () => generation !== this.generation
        || (usesDataview && dataviewGeneration !== this.dataviewGeneration)
        || this.scopedDataChanged(scopedSince, lastSettings) };
    }

    const settled = this.completed.get(key);

    if (settled) {
      if (settled.expiresAt > Date.now()) return PlacesRenderPreparer.cloneForCaller(settled.result);
      this.completed.delete(key);
    }

    const existing = this.inFlight.get(key);

    if (existing) {
      existing.callers.add(options);

      if (options.onSettingsReady) {
        existing.settings.listeners.add(options.onSettingsReady);
        if (existing.settings.last) options.onSettingsReady(existing.settings.last);
      }

      if (options.onPhase) {
        existing.phase.listeners.add(options.onPhase);
        if (existing.phase.last !== undefined) options.onPhase(existing.phase.last);
      }

      return PlacesRenderPreparer.cloneForCaller(await existing.promise);
    }

    const phase: InFlightPrepare['phase'] = { listeners: new Set(options.onPhase ? [options.onPhase] : []) };
    const settings: InFlightPrepare['settings'] = { listeners: new Set(options.onSettingsReady ? [options.onSettingsReady] : []) };
    const callers = new Set([options]);
    const generation = this.generation;
    const scopedSince = this.scopedChangeId;
    const promise = this.runPrepare({
      ...options,
      isCanceled: () => generation !== this.generation
        || (Boolean(settings.last?.blockSettings.dataview) && dataviewGeneration !== this.dataviewGeneration)
        || [...callers].every(caller => caller.isCanceled?.()),
      isPriorityPlace: place => [...callers].some(caller => !caller.isCanceled?.() && caller.isPriorityPlace?.(place)),
      onBatch: options.onBatch ? async prepared => {
        await Promise.all([...callers].filter(caller => !caller.isCanceled?.()).flatMap(caller =>
          caller.onBatch ? [caller.onBatch(PlacesRenderPreparer.cloneForCaller(prepared))] : []));
      } : undefined,
      onPhase: next => {
        phase.last = next;
        for (const listener of phase.listeners) listener(next);
      },
      onSettingsReady: next => {
        settings.last = next;
        for (const listener of settings.listeners) listener(next);
      },
    }).then(result => ({ ...result, isDataStale: () => generation !== this.generation
      || (Boolean(result.blockSettings.dataview) && dataviewGeneration !== this.dataviewGeneration)
      || this.scopedDataChanged(scopedSince, settings.last) }));

    this.inFlight.set(key, { promise, phase, settings, callers });

    try {
      const result = await promise;

      if (!result.isDataStale()) {
        this.storeCompleted(key, result);
      }

      return PlacesRenderPreparer.cloneForCaller(result);
    } finally {
      if (this.inFlight.get(key)?.promise === promise) this.inFlight.delete(key);
    }
  }

  private storeCompleted(key: string, result: PreparedPlacesRender): void {
    if (result.places.length === 0 && result.initialOverlays.length === 0) return;

    const now = Date.now();

    for (const [staleKey, entry] of this.completed) {
      if (entry.expiresAt <= now) this.completed.delete(staleKey);
    }

    this.completed.set(key, { result, expiresAt: now + PlacesRenderPreparer.COMPLETED_TTL_MS });
  }

  private async runPrepare(options: PreparePlacesRenderOptions): Promise<PreparedPlacesRender> {
    if (options.bypassOverlayCache) this.labelCaches.clear();
    const prepareStartTime = Date.now();
    const sourceTimings: MapPrepareSourceTiming[] = [];
    const parsedBlock = parseCodeBlock(options.source);
    const templateWarnings = await this.applyBlockTemplate(parsedBlock, options.ctx?.sourcePath ?? '');
    const visibleUsesParameters = parsedBlock.settings.markerFilter !== undefined && settingsUseParameters(parsedBlock.settings.markerFilter);
    const debugModes = parseDebugModes(parsedBlock.settings.debug);
    const parameterizedBefore = debugModes.parameters ? captureParameterizedSettings(parsedBlock.settings) : [];
    const transformResult = options.transformBlock ? await options.transformBlock(parsedBlock) : undefined;
    const parameterSignature = transformResult?.parameterSignature ?? '';
    const parameterErrors = transformResult?.parameterErrors;
    const rawBlockSettings = { ...parsedBlock.settings };
    const configInput = omitNonMapSettings(rawBlockSettings);

    if (parsedBlock.settings.debug !== undefined) {
      configInput.debug = debugModes.overlay;
    }

    const configWarnings: ConfigWarning[] = [...templateWarnings];
    const blockPatch = parseMapConfigPatch(configInput);
    const blockSettings: MapBlockSettings = { ...CODED_MAP_DEFAULTS, ...blockPatch };
    const providerName = PlacesPlugin.resolveMapProvider(blockSettings.mapProvider);
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
    const hasGeneratedOverlayWork = Boolean(blockSettings.directions?.length || blockSettings.isochrones?.length);
    const hasAsyncOverlayWork = hasRequestedOverlayWork || hasGeneratedOverlayWork;

    if (options.mode === 'initial' && (blockSettings.query || blockSettings.dataview)) {
      options.onSettingsReady?.({
        rawBlockSettings, blockSettings, providerName,
        resolvedSettings: resolveMapSettings({
          providerName, rawBlockSettings: configInput, blockPatch,
          warnings: [...configWarnings], blockOverrides: options.mapConfigOverrides, placeCount: 0,
        }),
      });
    }

    if (blockSettings.query || blockSettings.dataview) {
      const readiness = blockSettings.query ? options.vaultQueryReadiness?.() ?? null : null;

      if (readiness) {
        options.onPhase?.('waiting-for-index');
        void readiness.then(() => options.onPhase?.('querying'), () => options.onPhase?.('querying'));
      } else {
        options.onPhase?.('querying');
      }
    }

    const collectionSignature = stableSignature({
      ...parsedBlock.settings, markerFilter: undefined, queryParameters: undefined,
      parameterMarkers: transformResult?.parameterMarkers,
    });
    const visibleRules = normalizeVisibilityRules(parsedBlock.settings.markerFilter);
    const hasSelfReferencingQuery = typeof parsedBlock.settings.query === 'string' && /\{this\./i.test(parsedBlock.settings.query);
    const reuse = options.collectionReuse;

    if (options.mode === 'refresh' && reuse !== undefined && reuse.signature === collectionSignature && liveVisibilityEligible
      && !options.bypassOverlayCache && !hasSelfReferencingQuery && !debugModes.any && options.previousDataFingerprint !== undefined) {
      perf.mark('reused-collection', { places: reuse.places.length });

      return {
        parsedBlock, rawBlockSettings, blockSettings, providerName, places: reuse.places, queryErrors: reuse.queryErrors, initialOverlays: [],
        dataFingerprint: options.previousDataFingerprint, collectionSignature, unchangedData: true,
        liveVisibility: { hiddenIds: hiddenPlaceIds(reuse.places, visibleRules) }, parameterErrors,
        prepareTimings: { startTime: prepareStartTime, collectMs: 0, sources: [], fingerprintMs: 0, stylesMs: 0, labelsMs: 0, totalMs: Date.now() - prepareStartTime },
      };
    }

    const collectStarted = Date.now();
    const presentationSignature = stableSignature({
      ...parsedBlock.settings, query: undefined, dataview: undefined, queryParameters: undefined,
      markerFilter: liveVisibilityEligible ? undefined : parsedBlock.settings.markerFilter,
      mapConfigOverrides: options.mapConfigOverrides,
      parameterMarkers: transformResult?.parameterMarkers,
      debugParameters: debugModes.any ? parameterSignature : undefined,
    });
    const { rows: preparedRows, labels: labelOutcomes } = options.mode === 'refresh' && !options.bypassOverlayCache && !hasSelfReferencingQuery && !debugModes.any
      ? this.preparedGeneration(stableSignature({
        source: options.source, presentationSignature, providerName,
        defaults: [PlacesPlugin.settings.defaultIconStyles, PlacesPlugin.settings.defaultLabelStyles, PlacesPlugin.settings.defaultLabelTemplate],
      }))
      : { rows: new WeakMap<MapPlace, MapPlace>(), labels: new WeakMap<MapPlace, PlaceLabelOutcome>() };
    let streamedStylesMs = 0;
    let streamedLabelsMs = 0;
    const baseCss = blockSettings.css;
    const prepareRows = async (rows: MapPlace[]) => {
      const fresh: MapPlace[] = [];
      const preparedPlaces = rows.map(row => {
        let place = preparedRows.get(row);

        if (!place) {
          place = { ...row, overlay: row.overlay ? { ...row.overlay } : undefined };
          preparedRows.set(row, place);
          fresh.push(place);
        }

        return place;
      });
      const settings = { ...blockSettings, css: baseCss };
      const processed = await postProcessPlaces(fresh, settings, {
        labelCaches: this.labelCaches, providerName, rawBlockSettings: configInput, blockPatch,
        labelOutcomes,
        warnings: [...configWarnings], blockOverrides: options.mapConfigOverrides,
        placeCount: rows.length, selfNoteMap: isSelfNoteMap(blockSettings), perf,
      });

      streamedStylesMs += processed.stylesMs;
      streamedLabelsMs += processed.labelsMs;
      const badgeCss = MarkerStyleService.buildBadgeCss(preparedPlaces);

      settings.css = badgeCss ? (baseCss ? `${baseCss}\n${badgeCss}` : badgeCss) : baseCss;
      const resolvedSettings = resolveMapSettings({
        providerName, rawBlockSettings: configInput, blockPatch, warnings: [...configWarnings],
        blockOverrides: { ...(settings.css !== baseCss ? { css: settings.css } : {}), ...options.mapConfigOverrides },
        placeCount: rows.length,
      });

      return { places: preparedPlaces, blockSettings: settings, resolvedSettings };
    };
    const collected = await perf.measureAsync(
      'collect-places',
      () => this.placeDataService.collectAllPlaces(blockSettings, options.ctx, perf, sourceTimings, {
        isCanceled: options.isCanceled,
        isPriorityPlace: options.isPriorityPlace ? place => options.isPriorityPlace!(place) && MarkerStyleService.filterVisiblePlaces([place], visibleRules).length > 0 : undefined,
        onBatch: options.mode === 'initial' && options.onBatch ? async batch => {
          const rows = liveVisibilityEligible ? batch.places : MarkerStyleService.filterVisiblePlaces(batch.places, visibleRules);

          if (!rows.length) return;
          const partial = await prepareRows(rows);

          if (options.isCanceled?.()) throw new QueryPreparationCanceled();

          await options.onBatch!({
            parsedBlock, rawBlockSettings, providerName, ...partial,
            initialOverlays: [], queryErrors: batch.errors, dataFingerprint: '', collectionSignature,
            liveVisibility: liveVisibilityEligible ? { hiddenIds: hiddenPlaceIds(batch.places, visibleRules) } : undefined,
            popupDebug: debugModes.any ? { markerFilter: visibleRules } : undefined,
          });
        } : undefined,
      }),
      { hasQuery: Boolean(blockSettings.query), hasDataview: Boolean(blockSettings.dataview) },
    );

    if (options.isCanceled?.()) throw new QueryPreparationCanceled();
    const resolvedParameterMarkers = this.routeOverlayGenerator?.resolveParameterMarkers(
      transformResult?.parameterMarkers ?? [],
      collected.places,
      options.ctx.sourcePath,
    ) ?? [];
    const collectedPlaces = mergeParameterMarkers(collected.places, resolvedParameterMarkers);
    const sourcesUnreadable = collected.sourcesUnreadable;
    const queryErrors = collected.queryErrors ?? [];
    const collectMs = Math.max(0, Date.now() - collectStarted - streamedStylesMs - streamedLabelsMs);

    options.onPhase?.('building');
    let places: MapPlace[];
    let liveVisibility: { hiddenIds: string[] } | undefined;

    if (liveVisibilityEligible) {
      places = collectedPlaces;
      liveVisibility = { hiddenIds: hiddenPlaceIds(collectedPlaces, visibleRules) };
    } else {
      places = MarkerStyleService.filterVisiblePlaces(collectedPlaces, visibleRules);
    }

    const popupDebug = debugModes.any ? { markerFilter: visibleRules } : undefined;
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

    const fingerprintSource = `${options.source}\u0001${presentationSignature}\u0001${JSON.stringify(queryErrors)}`;
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

    if (options.mode === 'refresh' && !options.bypassOverlayCache && !hasSelfReferencingQuery && options.previousDataFingerprint !== undefined && options.previousDataFingerprint === dataFingerprint) {
      perf.mark('skipped-unchanged', { places: places.length });

      return { parsedBlock, rawBlockSettings, blockSettings, providerName, places, queryErrors, labelTemplateResult: undefined, initialOverlays: [], dataFingerprint, collectionSignature, unchangedData: true, liveVisibility, parameterDebug, popupDebug, parameterErrors, prepareTimings: buildPrepareTimings(0, 0) };
    }

    const waypointLabelTemplate = blockSettings.waypointLabelTemplate ?? (PlacesPlugin.settings.waypointLabelTemplate || undefined);
    const overlayLoadPromise = overlaysSetting
      ? this.overlayService.loadOverlays(overlaysSetting, waypointLabelTemplate)
      : Promise.resolve({ overlays: [], errors: [] });

    const processed = await (async () => {
      const final = await prepareRows(places);
      const diagnosticsStarted = performance.now();
      const labelTemplateResult = summarizeLabelOutcomes(final.places, blockSettings, labelOutcomes);

      streamedLabelsMs += performance.now() - diagnosticsStarted;
      places = final.places;
      blockSettings.css = final.blockSettings.css;

      return { resolvedSettings: final.resolvedSettings, labelTemplateResult, stylesMs: streamedStylesMs, labelsMs: streamedLabelsMs };
    })();
    const { resolvedSettings, labelTemplateResult, stylesMs, labelsMs } = processed;

    if (options.isCanceled?.()) throw new QueryPreparationCanceled();

    if (options.mode === 'refresh') {
      const [overlayResult, generatedOverlayResult] = await perf.measureAsync('load-overlays', () => Promise.all([
        overlayLoadPromise,
        this.generateRouteOverlays(resolvedSettings.config, places, providerName, options.ctx, options.bypassOverlayCache)
      ]));

      perf.mark('complete', { places: places.length, overlays: overlayResult.overlays.length + generatedOverlayResult.overlays.length });
      reportHeapPressure(usage => logger.warn('Heap pressure', {
        usedMB: usage.usedMB, limitMB: usage.limitMB, percent: Math.round(usage.ratio * 100),
        places: places.length, sourcePath: options.ctx?.sourcePath,
      }));

      return {
        parsedBlock,
        rawBlockSettings,
        blockSettings,
        providerName,
        resolvedSettings,
        places,
        sourcesUnreadable,
        queryErrors,
        labelTemplateResult,
        dataFingerprint,
        collectionSignature,
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
      sourcesUnreadable,
      queryErrors,
      labelTemplateResult,
      dataFingerprint,
      collectionSignature,
      initialOverlays: [],
      asyncOverlayLoad,
      liveVisibility,
      parameterDebug,
      popupDebug,
      parameterErrors,
      prepareTimings: buildPrepareTimings(stylesMs, labelsMs),
    };
  }

  // No query, dataview, or explicit places: the map renders the note's own frontmatter location.
  private async generateRouteOverlays(config: ResolvedMapConfig, places: MapPlace[], providerName: string, ctx: MarkdownPostProcessorContext, bypassCache?: boolean): Promise<OverlayResult> {
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

function hiddenPlaceIds(places: readonly MapPlace[], visibleRules: readonly string[]): string[] {
  const visibleIds = new Set(MarkerStyleService.filterVisiblePlaces([...places], visibleRules).map(getPlaceId));

  return places.filter(place => !visibleIds.has(getPlaceId(place))).map(getPlaceId);
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

export interface PostProcessPlacesOptions {
  readonly labelCaches?: PlaceLabelCaches;
  readonly labelOutcomes?: WeakMap<MapPlace, PlaceLabelOutcome>;
  readonly providerName: string;
  readonly rawBlockSettings: Readonly<Record<string, unknown>>;
  readonly blockPatch: MapConfigPatch;
  readonly warnings?: ConfigWarning[];
  readonly blockOverrides?: MapConfigPatch;
  readonly placeCount: number;
  readonly selfNoteMap: boolean;
  readonly perf: PerformanceMonitor;
}

export interface PostProcessedPlaces {
  readonly resolvedSettings: ResolvedMapSettings;
  readonly labelTemplateResult?: LabelTemplateResult;
  readonly stylesMs: number;
  readonly labelsMs: number;
}

export async function postProcessPlaces(places: MapPlace[], blockSettings: MapBlockSettings, options: PostProcessPlacesOptions): Promise<PostProcessedPlaces> {
  const { perf } = options;
  const stylesStarted = performance.now();
  const cssBeforeStyles = blockSettings.css;

  perf.measure('process-styles', () => processStyles(places, blockSettings, options.selfNoteMap, perf), { places: places.length });
  const resolvedSettings = perf.measure('resolve-settings', () => resolveMapSettings({
    providerName: options.providerName,
    rawBlockSettings: options.rawBlockSettings,
    blockPatch: options.blockPatch,
    warnings: options.warnings,
    blockOverrides: {
      ...(blockSettings.css !== cssBeforeStyles ? { css: blockSettings.css } : {}),
      ...(options.blockOverrides ?? {}),
    },
    placeCount: options.placeCount,
  }));

  perf.measure('apply-track-settings', () => {
    for (const place of places) applyPlaceTrackSettings(place, resolvedSettings.config);
  }, { places: places.length });
  const stylesMs = performance.now() - stylesStarted;
  const labelsStarted = performance.now();
  const markerCacheBefore = options.labelCaches?.markers.stats();
  const pathCacheBefore = options.labelCaches?.paths.stats();
  const labelTemplateResult = await perf.measureAsync('process-labels', () => processLabels(places, blockSettings, options.labelCaches, options.labelOutcomes));

  await perf.measureAsync('resolve-icon-rotation', () => applyIconRotation(places, blockSettings.iconRotation));

  if (blockSettings.iconImage || places.some(place => place.settings?.iconImage)) {
    const app = PlacesPlugin.getApp();

    if (app) await perf.measureAsync('resolve-icon-images', () => applyIconImages(app, places, blockSettings.iconImage));
  }

  const pathLabelProfile = await perf.measureAsync('inject-path-labels', () => injectPathLabels(places, blockSettings, PlacesPlugin.settings, options.labelCaches?.paths));

  perf.mark('path-label-profile', pathLabelProfile);

  for (const [kind, cache, before] of [
    ['marker', options.labelCaches?.markers, markerCacheBefore],
    ['path', options.labelCaches?.paths, pathCacheBefore],
  ] as const) {
    if (!cache || !before) continue;
    const after = cache.stats();

    perf.mark('label-cache', {
      kind, hits: after.hits - before.hits, misses: after.misses - before.misses,
      bypasses: after.bypasses - before.bypasses, entries: after.entries,
    });
  }

  const labelsMs = performance.now() - labelsStarted;

  return { resolvedSettings, labelTemplateResult, stylesMs, labelsMs };
}

function isSelfNoteMap(blockSettings: MapBlockSettings): boolean {
  return !blockSettings.query && !blockSettings.dataview && blockSettings.places === undefined;
}

function getStyleRules(defaultRules: string | undefined, blockRules: string | readonly string[] | undefined, selfNoteMap: boolean) {
  const defaults = MarkerStyleService.parseRules(defaultRules);
  const applicableDefaults = selfNoteMap ? MarkerStyleService.withoutZoomVisibility(defaults) : defaults;

  return [...applicableDefaults, ...MarkerStyleService.parseRules(blockRules)];
}

function processStyles(places: MapPlace[], blockSettings: MapBlockSettings, selfNoteMap: boolean, perf: PerformanceMonitor): void {
  const styleConfig: MarkerStyleConfig = {
    ...blockSettings,
    css: blockSettings.css,
    iconStyles: getStyleRules(PlacesPlugin.settings.defaultIconStyles, blockSettings.iconStyles, selfNoteMap),
    iconImageStyles: MarkerStyleService.parseRules(blockSettings.iconImageStyles),
    labelStyles: getStyleRules(PlacesPlugin.settings.defaultLabelStyles, blockSettings.labelStyles, selfNoteMap)
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

  const badgeCss = perf.measure('style-badge-css', () => MarkerStyleService.buildBadgeCss(places), { places: places.length });

  if (badgeCss) {
    blockSettings.css = [blockSettings.css, badgeCss].filter(Boolean).join('\n');
  }
}

function groupLabelTemplates(places: MapPlace[], blockSettings: MapBlockSettings): Map<string, MapPlace[]> | undefined {
  const labelTemplate = blockSettings.labelTemplate || PlacesPlugin.settings.defaultLabelTemplate;

  if (!labelTemplate && !places.some(place => place.settings?.labelTemplate !== undefined)) {
    return undefined;
  }

  const groups = new Map<string, MapPlace[]>();

  for (const place of places) {
    const template = place.settings?.labelTemplate ?? labelTemplate ?? '';
    const group = groups.get(template) ?? [];

    group.push(place);
    groups.set(template, group);
  }

  return groups;
}

export function summarizeLabelOutcomes(places: MapPlace[], blockSettings: MapBlockSettings, outcomes: WeakMap<MapPlace, PlaceLabelOutcome>): LabelTemplateResult | undefined {
  const groups = groupLabelTemplates(places, blockSettings);

  if (!groups) return undefined;
  const result: LabelTemplateResult = { successCount: 0, errors: [] };

  for (const group of groups.values()) {
    let reportedValidation = false;

    for (const place of group) {
      const outcome = outcomes.get(place);

      if (!outcome?.error) result.successCount++;
      else if (!outcome.templateError || !reportedValidation) {
        result.errors.push(outcome.error);
        reportedValidation ||= outcome.templateError === true;
      }
    }
  }

  return result;
}

async function processLabels(places: MapPlace[], blockSettings: MapBlockSettings, caches?: PlaceLabelCaches, outcomes?: WeakMap<MapPlace, PlaceLabelOutcome>): Promise<LabelTemplateResult | undefined> {
  const groups = groupLabelTemplates(places, blockSettings);

  if (!groups) return undefined;
  const labelService = getLabelTemplateService();
  const report = outcomes ? (place: MapPlace, outcome: PlaceLabelOutcome) => { outcomes.set(place, outcome); } : undefined;
  const results = await Promise.all(Array.from(groups, ([template, group]) => labelService.processPlaces(group, template, caches?.markers, report)));
  const result: LabelTemplateResult = { successCount: results.reduce((sum, entry) => sum + entry.successCount, 0), errors: results.flatMap(entry => entry.errors) };

  if (result.errors.length > 0) {
    logger.warn(`${result.errors.length} label template error(s)`);
  }

  return result;
}

function omitNonMapSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const mapSettings = { ...settings };

  delete mapSettings.overlays;
  delete mapSettings.heatmapLayer;

  return mapSettings;
}

function mergeParameterMarkers(places: MapPlace[], markers: readonly MapPlace[]): MapPlace[] {
  if (markers.length === 0) return places;
  const merged = [...places];
  const pathIndexes = new Map<string, number>();
  const coordinateIndexes = new Map<string, number>();
  const coordinateKey = (place: MapPlace): string => `${place.latitude.toFixed(7)},${place.longitude.toFixed(7)}`;

  merged.forEach((place, index) => {
    if (place.filePath) pathIndexes.set(place.filePath, index);
    coordinateIndexes.set(coordinateKey(place), index);
  });

  for (const marker of markers) {
    const existingIndex = (marker.filePath ? pathIndexes.get(marker.filePath) : undefined)
      ?? coordinateIndexes.get(coordinateKey(marker));

    if (existingIndex !== undefined) {
      const existing = merged[existingIndex];

      merged[existingIndex] = {
        ...existing,
        icon: marker.icon,
        metadata: { ...(existing.metadata ?? {}), ...(marker.metadata ?? {}) },
      };
      continue;
    }

    const index = merged.push(marker) - 1;

    if (marker.filePath) pathIndexes.set(marker.filePath, index);
    coordinateIndexes.set(coordinateKey(marker), index);
  }

  return merged;
}

export function computePlaceDataFingerprint(places: MapPlace[], source: string): string {
  const parts: string[] = [source, String(places.length)];

  for (const place of places) {
    parts.push(
      getPlaceId(place), place.name, place.icon,
      String(place.latitude), String(place.longitude),
      place.filePath ?? '', String(place.trackDefaultVisibility ?? ''),
      place.queryRow ? stableSignatureCached(place.queryRow) : '',
      place.metadata ? stableSignatureCached(place.metadata) : '',
      place.settings ? stableSignatureCached(place.settings) : '',
      overlayShapeSignature(place),
    );
  }

  return fnvHash(parts.join('\u0001'));
}
