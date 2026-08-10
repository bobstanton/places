import type * as GeoJSON from "geojson";
import { MapPlace } from "places-shared/overlay";
import {
  resolveCascadedLabelTemplate,
  DEFAULT_PATH_START_LABEL_TEMPLATE,
  DEFAULT_PATH_MIDPOINT_LABEL_TEMPLATE,
  DEFAULT_PATH_END_LABEL_TEMPLATE,
  type IPlacesPluginSettings,
} from "places-shared/settings";
import { buildPathLabelFeatures, buildSegmentedPathLabelFeatures, getPathLabelSegments } from "places-shared/services";
import { DistanceCalculator } from "places-shared/geo";
import { readNormalizedProperty } from "places-shared/utils";
import { formatKmInSystem, formatMetersInSystem, meters, type UnitsSystem } from "places-shared/units";
import { resolvePlaceLabelTemplate } from "./PlaceLabelTemplate";

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
  noteProperty: string;
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

function noteOverride(place: MapPlace, key: string): string | undefined {
  // A VaultQuery place carries SQL column names in metadata (`tracklabelsstart`).
  const value = readNormalizedProperty(place.metadata, key);
  return typeof value === "string" ? value : undefined;
}

function labelsEnabled(block: PathLabelBlockSettings): boolean {
  if (block.showLabels === false) return false;
  if (typeof block.showLabels === "string") {
    return block.showLabels.trim().toLowerCase() !== "false";
  }
  return true;
}

// Resolve and inject start/midpoint/end labels into each place's GPX/path overlay GeoJSON.
// Each slot resolves through the note frontmatter > code block > global > coded cascade, then the
// template is filled from the place's already-materialized frontmatter (placeholder-resolver +
// SimpleContextProvider). Both map engines render the resulting route_label_point features.
export async function injectPathLabels(
  places: MapPlace[],
  block: PathLabelBlockSettings,
  settings: IPlacesPluginSettings,
): Promise<void> {
  const roles = parseEnabledRoles(block.trackLabelsVisibility);
  const shouldBuildLabels = labelsEnabled(block);

  await Promise.all(places.map(async (place) => {
    const overlay = place.overlay;
    const geojson = overlay?.geojson;
    if (!overlay || !geojson?.features) return;

    // Recompute from scratch each render. Labels live on overlay.pathLabels, never mutated
    // into geojson: bounds/visibility read the track geometry without label points.
    overlay.pathLabels = [];
    if (!shouldBuildLabels || roles.size === 0 || !place.filePath) return;

    const slots: PathLabelSlot[] = [
      { role: "start", blockValue: block.trackLabelsStart, noteProperty: "trackLabelsStart", globalDefault: settings.pathStartLabelTemplate, codedDefault: DEFAULT_PATH_START_LABEL_TEMPLATE },
      { role: "mid", blockValue: block.trackLabelsMidpoint, noteProperty: "trackLabelsMidpoint", globalDefault: settings.pathMidpointLabelTemplate, codedDefault: DEFAULT_PATH_MIDPOINT_LABEL_TEMPLATE },
      { role: "end", blockValue: block.trackLabelsEnd, noteProperty: "trackLabelsEnd", globalDefault: settings.pathEndLabelTemplate, codedDefault: DEFAULT_PATH_END_LABEL_TEMPLATE },
    ];

    const templates: Record<PathLabelRole, string> = { start: "", mid: "", end: "" };
    for (const slot of slots) {
      if (!roles.has(slot.role)) continue;
      templates[slot.role] = resolveCascadedLabelTemplate(noteOverride(place, slot.noteProperty), slot.blockValue, slot.globalDefault, slot.codedDefault);
    }

    const resolveSet = async (overrides?: Record<string, unknown>): Promise<Record<PathLabelRole, string>> => {
      const resolved: Record<PathLabelRole, string> = { start: "", mid: "", end: "" };
      await Promise.all(slots.map(async (slot) => {
        if (!templates[slot.role]) return;
        resolved[slot.role] = await resolvePlaceLabelTemplate(place, templates[slot.role], overrides);
      }));
      return resolved;
    };

    // One stretch: the note's own frontmatter already describes it.
    const segments = getPathLabelSegments(geojson);
    if (segments.length <= 1) {
      overlay.pathLabels = buildPathLabelFeatures(geojson, await resolveSet());
      return;
    }

    // Several stretches: label each one with its own figures.
    const perSegment = await Promise.all(segments.map((line, index) =>
      resolveSet(segmentLabelValues(line, index, segments.length, settings.units))));
    overlay.pathLabels = buildSegmentedPathLabelFeatures(segments, perSegment);
  }));
}

// The label context for one segment: what can be measured from its own geometry,
// plus blanks for the note-wide metrics that cannot be split. Templates guard
// with `this.X ? ... : ''`; a blank drops out of the label.
function segmentLabelValues(
  line: GeoJSON.Position[],
  index: number,
  total: number,
  units: UnitsSystem,
): Record<string, unknown> {
  const distanceKm = DistanceCalculator.calculatePolylineDistanceKm(
    line.map(position => ({ latitude: position[1] ?? 0, longitude: position[0] ?? 0 })),
  );
  const elevations = line.map(position => position[2]).filter((value): value is number => typeof value === "number");
  let gain = 0;
  let loss = 0;
  for (let point = 1; point < elevations.length; point++) {
    const delta = elevations[point] - elevations[point - 1];
    if (delta > 0) gain += delta;
    else loss -= delta;
  }
  const hasElevation = elevations.length > 0;

  return {
    "Distance": formatKmInSystem(distanceKm, units),
    "Total Points": line.length,
    "Segment": index + 1,
    "Segment Count": total,
    "Elevation Gain": hasElevation && gain > 0 ? formatMetersInSystem(meters(gain), units) : "",
    "Elevation Loss": hasElevation && loss > 0 ? formatMetersInSystem(meters(loss), units) : "",
    "Min Elevation": hasElevation ? formatMetersInSystem(meters(Math.min(...elevations)), units) : "",
    "Max Elevation": hasElevation ? formatMetersInSystem(meters(Math.max(...elevations)), units) : "",
    "Duration": "",
    "Moving Time": "",
    "Average Speed": "",
    "Average Pace": "",
    "Max Speed": "",
    "Best Pace": "",
    "Start Time": "",
    "End Time": "",
  };
}
