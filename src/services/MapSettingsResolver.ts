import { Platform } from 'obsidian';
import {
  CODED_MAP_DEFAULTS,
  parseMapConfigPatch,
  resolveMapConfiguration,
  type ConfigWarning,
  type MapConfigPatch,
  type ResolvedMapConfig,
  type SettingsTraceLayer,
} from 'places-shared/settings';
import { shouldClusterCount } from 'places-shared/map';
import PlacesPlugin from '../main';

export interface ResolveMapSettingsOptions {
  readonly providerName: string;
  readonly rawBlockSettings: Readonly<Record<string, unknown>>;
  readonly placeCount: number;
  readonly blockOverrides?: MapConfigPatch;
  // When supplied, rawBlockSettings is NOT re-parsed - the render path parses the block
  // once (for both collection and rendering) and passes the result here.
  readonly blockPatch?: MapConfigPatch;
  // Warnings collector shared with the caller's parse; returned verbatim when blockPatch is supplied.
  readonly warnings?: ConfigWarning[];
}

export interface ResolvedMapSettings {
  readonly config: ResolvedMapConfig;
  readonly clusteringEnabled: boolean;
  readonly layers: readonly SettingsTraceLayer[];
  readonly traceNotes: Readonly<Record<string, string>>;
  // Non-fatal warnings from parsing the block config (e.g. unknown keys in sub-nodes).
  readonly warnings: readonly ConfigWarning[];
}

export function resolveMapSettings(options: ResolveMapSettingsOptions): ResolvedMapSettings {
  const globalThreshold = Platform.isMobile
    ? PlacesPlugin.settings.clusterThresholdMobile
    : PlacesPlugin.settings.clusterThresholdDesktop;
  const globalPatch: MapConfigPatch = {
    poiDiscovery: PlacesPlugin.settings.poiDiscovery,
    poiFilterPatterns: PlacesPlugin.settings.poiFilterPatterns,
    labelTemplate: PlacesPlugin.settings.defaultLabelTemplate || undefined,
    routeLabelTemplate: PlacesPlugin.settings.defaultRouteLabelTemplate || undefined,
    waypointLabelTemplate: PlacesPlugin.settings.waypointLabelTemplate || undefined,
    trackLabelsStart: PlacesPlugin.settings.pathStartLabelTemplate || undefined,
    trackLabelsMidpoint: PlacesPlugin.settings.pathMidpointLabelTemplate || undefined,
    trackLabelsEnd: PlacesPlugin.settings.pathEndLabelTemplate || undefined,
    iconStyles: PlacesPlugin.settings.defaultIconStyles || undefined,
    labelStyles: PlacesPlugin.settings.defaultLabelStyles || undefined,
    clusterThreshold: globalThreshold,
    clusterGeoJsonOverlays: PlacesPlugin.settings.clusterGeoJsonOverlays,
  };
  const providerPatch = PlacesPlugin.getMapProviderDefaults(options.providerName);
  // rawBlockSettings is already template-merged and parameter-substituted, and
  // this block patch is the final per-block layer.
  const configWarnings: ConfigWarning[] = options.warnings ?? [];
  const parsedBlock = options.blockPatch ?? parseMapConfigPatch(options.rawBlockSettings, configWarnings);
  const blockPatch = { ...parsedBlock, ...(options.blockOverrides ?? {}) };
  const threshold = Math.max(0, Math.floor(blockPatch.clusterThreshold ?? globalThreshold));
  // The clustering comparison (behavior contract #1).
  const clusteringEnabled = shouldClusterCount(options.placeCount, threshold);
  const effectiveBlockPatch: MapConfigPatch = { ...blockPatch, clusterThreshold: threshold, clusteringEnabled };
  const resolved = resolveMapConfiguration([
    { source: 'global', values: globalPatch },
    { source: 'provider', values: providerPatch },
    { source: 'block', values: effectiveBlockPatch },
  ]);
  return {
    config: resolved.config,
    clusteringEnabled,
    layers: [
      { name: 'Default', values: { ...CODED_MAP_DEFAULTS } },
      { name: 'Global', values: { ...globalPatch } },
      { name: `Provider (${options.providerName})`, values: { ...providerPatch } },
      { name: 'Block', values: { ...effectiveBlockPatch } },
    ],
    traceNotes: {
      clusterThreshold: Platform.isMobile ? 'global value for mobile' : 'global value for desktop',
      poiFilterPatterns: 'global only',
      clusteringEnabled: `${options.placeCount} places vs threshold ${threshold}`,
    },
    warnings: configWarnings,
  };
}
