import { segmentLabelValues } from 'places/core';
import { MapPlace } from "places-shared/overlay";
import { resolveCascadedLabelTemplate, DEFAULT_PATH_START_LABEL_TEMPLATE, DEFAULT_PATH_MIDPOINT_LABEL_TEMPLATE, DEFAULT_PATH_END_LABEL_TEMPLATE, type IPlacesPluginSettings } from "places-shared/settings";
import { buildPathLabelFeatures, buildSegmentedPathLabelFeatures, getPathLabelSegments } from "places-shared/services";
import { createPlaceLabelResolver, resolvePlaceLabelTemplate } from "./PlaceLabelTemplate";
import type * as GeoJSON from 'geojson';
import { overlayGeometrySignature } from "places-shared/track";
import { labelInputSignature, type LabelResultCache } from './LabelResultCache';
import { LoopYieldController } from 'places/core/strategies';

type PathLabelRole = "start" | "mid" | "end";

// The block-setting fields used for path-overlay labels (the resolved track.labels.* values).
interface PathLabelBlockSettings {
  showLabels?: boolean | string;
  trackLabelsVisibility?: string;
  trackLabelsStart?: string;
  trackLabelsMidpoint?: string;
  trackLabelsEnd?: string;
}

interface PathLabelSlot {
  role: PathLabelRole;
  blockValue: string | undefined;
  settingKey: string;
  globalDefault: string;
  codedDefault: string;
}

// Parse the block `track.labels.visibility` toggle: empty/"all" => all, "none" => none, else a list of start/mid/end.
function parseEnabledRoles(visibility: string | undefined): Set<PathLabelRole> {
  const raw = (visibility ?? "").trim().toLowerCase();
  const all = () => new Set<PathLabelRole>(["start", "mid", "end"]);

  if (!raw || raw === "all" || raw === "true") return all();
  if (raw === "none" || raw === "false") return new Set<PathLabelRole>();
  const enabled = new Set<PathLabelRole>();

  for (const token of raw.split(/[\s,]+/)) {
    if (token === "start" || token === "end") enabled.add(token);
    else if (token === "mid" || token === "middle" || token === "midpoint") enabled.add("mid");
    else if (token === "all" || token === "true") return all();
    else if (token === "none" || token === "false") return new Set<PathLabelRole>();
  }

  return enabled.size > 0 ? enabled : all();
}

function placeOverride(place: MapPlace, key: string): string | undefined {
  const value = place.settings?.[key as keyof NonNullable<MapPlace['settings']>];

  return typeof value === "string" ? value : undefined;
}

function labelsEnabled(block: PathLabelBlockSettings): boolean {
  if (block.showLabels === false) return false;

  if (typeof block.showLabels === "string") {
    return block.showLabels.trim().toLowerCase() !== "false";
  }

  return true;
}

export async function injectPathLabels(
  places: MapPlace[],
  block: PathLabelBlockSettings,
  settings: IPlacesPluginSettings,
  cache?: LabelResultCache<GeoJSON.Feature[]>,
): Promise<{ resolvedSegments: number; labels: number; yieldCount: number; yieldMs: number }> {
  const shouldBuildLabels = labelsEnabled(block);
  const loop = new LoopYieldController({ batchSize: Infinity, maxIntervalMs: 8 });
  let processed = 0;
  let resolvedSegments = 0;
  let labels = 0;

  const processPlace = async (place: MapPlace): Promise<void> => {
    const roles = parseEnabledRoles(place.settings?.trackLabelsVisibility ?? block.trackLabelsVisibility);
    const overlay = place.overlay;
    const geojson = overlay?.geojson;

    if (!overlay || !geojson?.features) return;

    overlay.pathLabels = [];
    if (!shouldBuildLabels || roles.size === 0 || !place.filePath) return;

    const slots: PathLabelSlot[] = [
      { role: "start", blockValue: block.trackLabelsStart, settingKey: "trackLabelsStart", globalDefault: settings.pathStartLabelTemplate, codedDefault: DEFAULT_PATH_START_LABEL_TEMPLATE },
      { role: "mid", blockValue: block.trackLabelsMidpoint, settingKey: "trackLabelsMidpoint", globalDefault: settings.pathMidpointLabelTemplate, codedDefault: DEFAULT_PATH_MIDPOINT_LABEL_TEMPLATE },
      { role: "end", blockValue: block.trackLabelsEnd, settingKey: "trackLabelsEnd", globalDefault: settings.pathEndLabelTemplate, codedDefault: DEFAULT_PATH_END_LABEL_TEMPLATE },
    ];

    const templates: Record<PathLabelRole, string> = { start: "", mid: "", end: "" };

    for (const slot of slots) {
      if (!roles.has(slot.role)) continue;
      templates[slot.role] = resolveCascadedLabelTemplate(placeOverride(place, slot.settingKey), slot.blockValue, slot.globalDefault, slot.codedDefault);
    }

    if (!Object.values(templates).some(Boolean)) return;
    const inputKey = cache ? labelInputSignature(place, Object.values(templates)) : undefined;
    const cacheKey = inputKey ? `${inputKey}:${overlayGeometrySignature(geojson)}:${settings.units}` : undefined;
    const cached = cache?.get(cacheKey);

    if (cached) {
      overlay.pathLabels = cloneLabels(cached);

      return;
    }

    let emptyResolution = false;

    const resolveSet = async (overrides?: Record<string, unknown>): Promise<Record<PathLabelRole, string>> => {
      let resolver: ReturnType<typeof createPlaceLabelResolver> | undefined;
      const resolved: Record<PathLabelRole, string> = { start: "", mid: "", end: "" };

      await Promise.all(slots.map(async (slot) => {
        if (!templates[slot.role]) return;
        resolver ??= createPlaceLabelResolver(place, overrides);
        resolved[slot.role] = await resolvePlaceLabelTemplate(place, templates[slot.role], resolver);
        if (!resolved[slot.role]) emptyResolution = true;
      }));

      return resolved;
    };

    const segments = getPathLabelSegments(geojson);

    resolvedSegments += segments.length;

    if (segments.length <= 1) {
      overlay.pathLabels = buildPathLabelFeatures(geojson, await resolveSet());
    } else {
      const perSegment: Record<PathLabelRole, string>[] = [];

      for (let index = 0; index < segments.length; index++) {
        perSegment.push(await resolveSet(segmentLabelValues(segments[index], index, segments.length, settings.units)));

        await loop.yieldIfNeeded(++processed);
      }

      overlay.pathLabels = buildSegmentedPathLabelFeatures(segments, perSegment);
    }

    if (cacheKey && !emptyResolution) cache?.set(cacheKey, cloneLabels(overlay.pathLabels));
  };

  for (const place of places) {
    await processPlace(place);
    labels += place.overlay?.pathLabels?.length ?? 0;

    await loop.yieldIfNeeded(++processed);
  }

  return { resolvedSegments, labels, ...loop.getStats() };
}

function cloneLabels(features: GeoJSON.Feature[]): GeoJSON.Feature[] {
  return features.map(feature => ({ ...feature, properties: { ...feature.properties }, geometry: {
    ...feature.geometry, coordinates: [...(feature.geometry as GeoJSON.Point).coordinates],
  } as GeoJSON.Point }));
}
