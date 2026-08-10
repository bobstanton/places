import {
  autocompletion,
  completionStatus,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { App, TFile } from "obsidian";
import type { ParameterDefinition } from "places-shared/services";
import { CACHE_PARAMETER_DESCRIPTION, CACHE_VALUE_SUGGESTIONS, valueDetail } from "places-shared/settings";
import { CodeBlockRegistry } from "../services/CodeBlockRegistry";
import { TileJsonLayerIndex } from "../services/TileJsonLayerIndex";
import { getLineIndent, getPlacesFenceAtPos, getPreviousMeaningfulLine, getYamlEmptyKey, type PlacesFence } from "./PlacesEditorContext";

interface SuggestionItem {
  label: string;
  apply: string;
  detail?: string;
  type?: string;
  // CodeMirror ranks higher-boost completions first.
  boost?: number;
  // When set, accepting the completion replaces the whole line with this text.
  replaceLineWith?: string;
}

type CompletionMode = "key" | "value" | "nestedKey" | "listItem";

interface PlacesCompletionContext {
  mode: CompletionMode;
  fence: PlacesFence;
  from: number;
  to: number;
  query: string;
  key?: string;
  nestedBlockKey?: string;
  listParentKey?: string;
  applyPrefix?: string;
}

interface PlacesCompletionServices {
  app: App;
  getMapProviders: () => string[];
  getRouteProviders: () => string[];
  getSnapProviders: () => string[];
  getElevationProviders: () => string[];
  getTrackMatchProviders: () => string[];
  getTerrainProviders: () => string[];
  getStylesForProvider: (providerName: string) => string[];
  getStyleProviders: () => string[];
  resolveMapProvider: (explicitProvider?: string) => string;
}

const KEY_ALIASES: Record<string, string> = {
  ignoreRoads: "ignoreRoadClasses",
  maxSamples: "maxSamplesPerTrack",
  naming: "trailNaming",
  prefer: "preferHighlights",
  sample: "sampleDistance",
  water: "waterDetection",
};

// Descriptions for keys a block accepts without declaring a ParameterDefinition
// of its own. A key that reaches completion with neither a ParameterDefinition
// nor an entry here falls back to a placeholder, and anything added to a block's
// validKeys belongs in one of the two places.
const GENERIC_KEY_DESCRIPTIONS: Record<string, string> = {
  averageSegments: "Average overlapping heatmap segments instead of stacking them",
  bounds: "Image overlay bounds",
  cache: CACHE_PARAMETER_DESCRIPTION,
  cellSelection: "Weather grid cell preference for coastal areas",
  clusterGeoJsonOverlays: "Include GeoJSON overlay points in marker clustering",
  clusterThreshold: "Viewport point count above which markers collapse into clusters; 0 disables clustering",
  debug: "Render a diagnostic panel instead of, or alongside, the normal output",
  embeddedPlaces: "Places written in the block body after the --- delimiter",
  gradeDistance: "Deprecated spelling of gradeWindow, in feet",
  gradeWindow: "Span the rolling grade is measured over: a distance such as 100ft, or a time such as 10min",
  speedWindow: "Span speed and pace are averaged over: a distance such as 200m, or a time such as 30s",
  poiDiscovery: "Allow clicking points of interest baked into the base map (vector tile styles only)",
  queryParameters: "Interactive controls whose values substitute into the query and other settings as {parameter.name}",
  costing: "Valhalla costing name, overriding the one mode resolves to",
  costingOptions: "Options for the effective costing, passed through verbatim",
  shapeMatch: "Valhalla matching strategy",
  traceOptions: "Valhalla trace options that tune the matcher itself",
  wayDetails: "Report the named ways and surfaces the match ran along",
  tidy: "Collapse near-duplicate points before matching (Mapbox)",
  timestamps: "Send recorded point times so elapsed time constrains the match",
  exclude: "Way classes to keep the match off (Mapbox)",
  queryParametersCollapsed: "Start the parameter strip collapsed",
  queryParametersLayout: "Parameter strip layout direction",
  queryParametersPosition: "Where the parameter strip sits relative to the block",
  radius: "Filter results to those within a distance of one or more points",
  centers: "Isochrone center points",
  columns: "Columns to display",
  coordinates: "Latitude and longitude",
  corners: "Image overlay corner coordinates",
  css: "Inline CSS for this block",
  current: "Current weather variables",
  daily: "Daily weather variables",
  dataview: "Dataview DQL query",
  days: "Calendar days to display",
  directions: "Directions overlay configuration",
  endDate: "Inclusive end date",
  endTime: "End hour filter",
  overlays: "Overlay files (geodata, image, or vector tile)",
  height: "Rendered block height",
  hourly: "Hourly weather variables",
  iconStyles: "Marker icon style rules",
  initialCenter: "Initial map center",
  initialZoom: "Initial map zoom",
  isochrones: "Isochrone overlay configuration",
  labelStyles: "Map label style rules",
  labelTemplate: "Marker label template",
  iconRotation: "Marker rotation in degrees clockwise from north; a number or a per-place template",
  linkedPlaces: "Additional place notes to append",
  location: "Location name or coordinates",
  mapProvider: "Map rendering provider",
  markerRenderer: "Marker rendering mode",
  minutely15: "15-minute weather variables",
  mode: "Display mode",
  query: "VaultQuery SQL query",
  routeProvider: "Directions or isochrone provider",
  startDate: "Start date",
  startTime: "Start hour filter",
  style: "Values depend on the map provider; completion narrows to that provider's styles",
  tables: "Tables to populate",
  units: "Unit system",
  waypointLabelTemplate: "Waypoint marker label template (route endpoints and GPX <wpt>)",
  width: "Rendered block width",
};

const MULTI_VALUE_KEYS = new Set([
  "columns",
  "current",
  "daily",
  "hourly",
  "ignoreRoadClasses",
  "linkedPlaces",
  "mapProvider",
  "minutely15",
  "overlays",
  "preferHighlights",
  "stats",
  "tables",
]);

const EXPANDED_LIST_VALUE_KEYS = new Set([
  "overlays",
]);

const QUIET_EMPTY_VALUE_KEYS = new Set([
  "css",
  "queryParameters",
  "dataview",
  "directions",
  "iconStyles",
  "isochrones",
  "labelStyles",
  "query",
  "routes",
  "centers",
]);

const TRACK_FILE_EXTENSIONS = new Set(["md", "gpx", "geojson", "json", "csv"]);
const GEOJSON_OVERLAY_FILE_EXTENSIONS = new Set(["md", "gpx", "geojson", "json", "csv"]);
const IMAGE_OVERLAY_FILE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "tiff", "tif"]);
const IMAGE_FILE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "tiff", "tif"]);

function getNestedKeyItems(blockType: string, parentKey: string): SuggestionItem[] {
  const definitions = CodeBlockRegistry.instance.getNestedKeys(blockType, parentKey) ?? [];
  return definitions.map((definition) => ({
    label: definition.name,
    apply: definition.apply ?? `${definition.name}: `,
    detail: definition.description,
    type: "property",
  }));
}

function getListItemTemplateItems(blockType: string, parentKey: string): SuggestionItem[] {
  const templates = CodeBlockRegistry.instance.getListItemTemplates(blockType, parentKey) ?? [];
  return templates.map((template) => ({
    label: template.label,
    apply: template.insert,
    detail: template.description,
    type: "text",
  }));
}

// Shared by every rolling-metric window: a distance or a time, always unit-tagged.
const METRIC_WINDOW_ITEMS: SuggestionItem[] = [
  { label: "100ft", apply: "100ft", detail: "Distance window - 100 feet", type: "enum" },
  { label: "200m", apply: "200m", detail: "Distance window - 200 metres", type: "enum" },
  { label: "0.25mi", apply: "0.25mi", detail: "Distance window - a quarter mile", type: "enum" },
  { label: "30s", apply: "30s", detail: "Time window - 30 seconds", type: "enum" },
  { label: "5min", apply: "5min", detail: "Time window - 5 minutes; smooths across stops", type: "enum" },
];

const FORMAT_VALUE_ITEMS: Record<string, SuggestionItem[]> = {
  axisColor: [formatItem("color format", "#RRGGBB", "Format: hex color, rgb(), or CSS color", "#3388ff")],
  // One list for every block's `cache:`. Built from the same source the parser and
  // the VaultQuery definition blocks use.
  cache: CACHE_VALUE_SUGGESTIONS.map((suggestion) => ({
    label: suggestion.value,
    apply: suggestion.value,
    detail: suggestion.detail,
    type: "enum",
  })),
  bounds: [formatItem("bounds", "<swLat>,<swLng>,<neLat>,<neLng>", "Format: southwest then northeast corner", "40.654,-74.095,40.833,-73.877")],
  corners: [formatItem("corner coordinates", "<nwLat>,<nwLng>,<neLat>,<neLng>,<seLat>,<seLng>,<swLat>,<swLng>", "Format: four corners clockwise from NW (NW, NE, SE, SW)", "41.409,-75.663,41.409,-75.662,41.408,-75.662,41.408,-75.663")],
  tiles: [formatItem("tile URL template", "https://host/{z}/{x}/{y}.pbf", "Format: vector tile URL with {z}/{x}/{y}", "https://tiles.example.com/{z}/{x}/{y}.pbf")],
  url: [formatItem("TileJSON URL", "https://host/tiles.json", "Format: TileJSON endpoint URL", "https://tiles.example.com/tiles.json")],
  sourceLayer: [formatItem("layer name", "<name>", "Format: source layer name inside the tiles", "roads")],
  color: [formatItem("hex color", "#RRGGBB", "Format: #RRGGBB", "#3388ff")],
  colorScheme: [{
    label: "#ffffcc, #fd8d3c, #e31a1c",
    apply: "#ffffcc, #fd8d3c, #e31a1c",
    detail: "custom gradient colors ordered from low to high intensity",
    type: "text",
  }],
  colors: [formatItem("hex color list", "#RRGGBB, #RRGGBB", "Format: comma-separated hex colors", "#3388ff, #22c55e")],
  // A coordinate pair contains a comma, and the definition's example splits into
  // two half-coordinates when offered as plain enum values. Same for an option
  // list.
  coordinates: [formatItem("coordinates", "[<name>: ]<lat>,<lng>", "Format: optional name, then latitude and longitude; separate multiple with ;", "Scranton: 41.408, -75.662")],
  options: [formatItem("option list", "<a>, <b>, <c>", "Format: comma-separated allowed values for an enum or list parameter", "small, medium, large")],
  timezone: [formatItem("IANA timezone", "<Area>/<Location>", "Format: IANA timezone name, or UTC", "America/New_York")],
  clusterThreshold: [formatItem("count", "<number>", "Format: 0 to disable clustering, or a positive threshold", "100")],
  elevationColor: [formatItem("color format", "#RRGGBB", "Format: hex color, rgb(), or CSS color", "#3388ff")],
  fillOpacity: [formatItem("opacity", "<0-1 or percent>", "Format: decimal from 0 to 1, or percentage", "0.25")],
  fontSize: [formatItem("font size", "<number>", "Format: number in pixels", "14")],
  gradeColor: [formatItem("color format", "#RRGGBB", "Format: hex color, rgb(), or CSS color", "#3388ff")],
  gradeDistance: [formatItem("distance", "<feet>", "Format: bare number of feet. Prefer gradeWindow, which carries its own unit", "100")],
  gradeWindow: METRIC_WINDOW_ITEMS,
  speedWindow: METRIC_WINDOW_ITEMS,
  gridSize: [formatItem("distance", "<distance>", "Format: grid cell size in feet/meters", "100m")],
  height: [formatItem("CSS size", "<number>px", "Format: CSS size such as px, %, vh, or calc()", "500px")],
  initialCenter: [formatItem("coordinates", "<lat>,<lng>", "Format: latitude,longitude", "42.3601,-71.0589")],
  initialZoom: [formatItem("zoom", "<zoom>", "Format: number, or auto when supported", "12")],
  labelTemplate: [formatItem("label template", "{this.property}", "Format: template using {this.property}", "{this.name}")],
  iconRotation: [
    formatItem("degrees", "<0-359>", "Format: a fixed bearing applied to every marker", "45"),
    formatItem("per-place bearing", "{this.property}", "Format: a column holding degrees clockwise from north", "{this.wind_direction_10m}"),
    formatItem("corrected bearing", "{(this.property + <offset>) % 360}", "Format: an expression, for glyphs that do not point north at 0", "{(this.wind_direction_10m + 270) % 360}"),
  ],
  lineOpacity: [formatItem("opacity", "<0-1>", "Format: decimal from 0 to 1", "0.8")],
  lineThickness: [formatItem("pixel width", "<number>", "Format: line width in pixels", "4")],
  location: [
    formatItem("coordinates", "[<name>: ]<lat>,<lng>", "Format: optional name followed by latitude,longitude", "Boston: 42.3601,-71.0589"),
    formatItem("note property", "{note.<Property>}", "Format: a frontmatter property of this note", "{note.Location}"),
  ],
  // One entry per operator the condition parser supports (MarkerStyleService).
  markerFilter: [
    formatItem("set membership", "<field> IN <a>, <b>", "Show markers whose field matches any listed value; pairs with a multiselect parameter (tag IN for tags)", "tag IN {parameter.show}"),
    formatItem("set exclusion", "<field> NOT IN <a>, <b>", "Hide markers whose field matches any listed value", "tag NOT IN closed, private"),
    formatItem("equality", "<field> == <value>", "Show only markers whose field equals the value", "category == restaurant"),
    formatItem("inequality", "<field> != <value>", "Hide markers whose field equals the value", "status != closed"),
    formatItem("threshold", "<field> >= <number>", "Numeric comparison; also <, >, and <=", "rating >= 4"),
    formatItem("truthy", "<field>", "Show only markers where the field is present and truthy", "favorite"),
    formatItem("compound", "<condition> AND <condition>", "Combine two conditions with AND or OR", "rating >= 4 AND tag IN food"),
  ],
  maxOpacity: [formatItem("opacity", "<0-1>", "Format: decimal from 0 to 1", "1.0")],
  maxResults: [formatItem("count", "<number or unlimited>", "Format: integer, or unlimited when supported", "unlimited")],
  maxSegments: [formatItem("count", "<number or unlimited>", "Format: integer, or unlimited when supported", "200")],
  minFrequency: [formatItem("count", "<number>", "Format: positive integer", "2")],
  minOpacity: [formatItem("opacity", "<0-1>", "Format: decimal from 0 to 1", "0.1")],
  minOverlap: [formatItem("similarity", "<0-100 or 0-1>", "Format: percentage or decimal", "70")],
  minSimilarity: [formatItem("similarity", "<0-100 or 0-1>", "Format: percentage or decimal", "70")],
  minZoom: [formatItem("zoom", "<zoom>", "Format: number", "8")],
  maxZoom: [formatItem("zoom", "<zoom>", "Format: number", "12")],
  metricLabels: [
    formatItem("total", "total", "Show only the total route distance and duration label", "total"),
    formatItem("legs", "legs", "Show distance and duration between each stop", "legs"),
    formatItem("both", "both", "Show both total route and per-stop labels", "both"),
    formatItem("none", "none", "Hide generated route metric labels", "none"),
  ],
  name: [formatItem("text", "<name>", "Format: free text name", "My Overlay")],
  "queryParameters.name": [formatItem("parameter name", "<name>", "Required. Referenced as {parameter.name} in the query or any other block setting", "days")],
  "queryParameters.width": [formatItem("control width", "<length or percent>", "Fixed lengths size the input; a percentage sizes the complete parameter relative to the control strip. Fixed lengths have no effect on toggle, segmented, and multiselect", "240px")],
  "queryParameters.default": [
    { label: "all", apply: "all", detail: "List parameters: start with every option selected, including options an optionsQuery resolves later", type: "enum" },
    formatItem("initial value", "<value>", "Initial value for the parameter", "7"),
  ],
  "style.width": [formatItem("line width", "<number>", "Line width in pixels", "4")],
  "hoverStyle.width": [formatItem("line width", "<number>", "Line width in pixels", "4")],
  "style.colors": [formatItem("contour colors", "#RRGGBB, #RRGGBB", "Isochrone contour colors from first to last range; repeat when there are more contours than colors", "#3388ff, #22c55e")],
  "hoverStyle.colors": [formatItem("contour colors", "#RRGGBB, #RRGGBB", "Isochrone contour colors from first to last range; repeat when there are more contours than colors", "#3388ff, #22c55e")],
  "colorRelief.colors": [formatItem("elevation ramp", "<preset>", "Elevation tint: a preset (hypsometric, viridis, spectral, grayscale) or a list of <elevation in metres>: <color> stops", "viridis")],
  opacity: [formatItem("opacity", "<0-1>", "Format: decimal from 0 to 1", "0.8")],
  overlapTolerance: [formatItem("distance", "<distance>", "Format: distance in meters/feet", "25m")],
  paceColor: [formatItem("color format", "#RRGGBB", "Format: hex color, rgb(), or CSS color", "#3388ff")],
  // Serves the places block, whose radius has no definition entry; blocks that
  // document their own radius (similar, snap, classify) surface those values
  // instead via BLOCK_SPECIFIC_FORMAT_KEYS.
  radius: [
    formatItem("distance", "<distance>", "Only show places within this distance of the center; a bare number uses the vault's unit system", "10mi"),
    formatItem("distance with center", "<distance> from <lat>, <lng>", "Inline center; otherwise the location setting or the note's frontmatter Location supplies it", "50 from 41.408, -75.662"),
  ],
  ranges: [
    formatItem("time and distance contours", "unit list", "Each value includes a time or distance unit; types may be mixed", "\n  - 10 min\n  - 30 min\n  - 5 mi"),
  ],
  routeLabelTemplate: [formatItem("route label template", "{this.property}", "Format: template using route properties", "{this.distance_text}")],
  legLabelTemplate: [formatItem("leg label template", "{this.property}", "Format: template using leg properties", "{this.from_name} → {this.to_name}: {this.distance_text} · {this.duration_text}")],
  waypointLabelTemplate: [formatItem("waypoint label template", "{this.property}", "Format: template using waypoint properties ({this.name}, {this.role_label}, ...)", "{this.role_label}: {this.name}")],
  // A flow sequence: these cannot go through formatItem - it quotes any
  // sample containing '[', which would make the value a string and fail the
  // "must be a list of text values" check.
  selectableLayers: [
    {
      label: "[transportation]",
      apply: "[transportation]",
      detail: "A source-layer name: every road, path, and rail line the tiles carry. The default",
      type: "enum",
    },
    {
      label: "[highway-path, highway-minor]",
      apply: "[highway-path, highway-minor]",
      detail: "Rendered layer IDs, to restrict building to particular road classes. The map's Choose selectable map layers button lists this style's IDs with live feature counts",
      type: "enum",
    },
  ],
  speedColor: [formatItem("color format", "#RRGGBB", "Format: hex color, rgb(), or CSS color", "#3388ff")],
  strokeOpacity: [formatItem("opacity", "<0-1 or percent>", "Format: decimal from 0 to 1, or percentage", "0.85")],
  strokeWidth: [formatItem("pixel width", "<number>", "Format: line width in pixels", "4")],
  tolerance: [formatItem("distance", "<distance>", "Format: distance in meters/feet or degrees, depending on block", "25m")],
  width: [formatItem("CSS size", "<number>px", "Format: CSS size such as px, %, vw, or calc()", "500px")],
};

function formatItem(label: string, format: string, detail: string, sample: string): SuggestionItem {
  // A named coordinate ("Name: lat,lng") or a [[link]] must be quoted to stay
  // valid YAML - the ':' would otherwise read as a key, '[[' as a flow sequence.
  const apply = sample.includes(':') || sample.includes('[') ? `"${sample}"` : sample;
  return {
    label: format,
    apply,
    detail: label ? `${label} - ${detail}. Inserts sample: ${apply}` : `${detail}. Inserts sample: ${apply}`,
    type: "text",
  };
}

// Keys already present in the list entry immediately above a fresh "- " line.
// Returns null when no previous entry exists (the fresh dash starts the list).
// Keys from deeper nested structures may leak in; callers only compare against
// the parent's own sub-key names, and they are inert.
function getPreviousEntryKeys(state: EditorState, fence: PlacesFence, dashLineNumber: number, dashIndent: number): Set<string> | null {
  const keys = new Set<string>();

  for (let lineNumber = dashLineNumber - 1; lineNumber > fence.startLine; lineNumber--) {
    const text = state.doc.line(lineNumber).text;
    const trimmed = text.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const indent = getLineIndent(text);
    if (indent < dashIndent) {
      return null;
    }

    const isDash = /^-(\s|$)/u.test(trimmed);
    if (indent === dashIndent && !isDash) {
      return null;
    }

    const content = isDash ? trimmed.replace(/^-\s?/u, "") : trimmed;
    const keyMatch = content.match(/^([A-Za-z][\w-]*)\s*:/u);
    if (keyMatch) {
      keys.add(keyMatch[1]);
    }

    if (isDash && indent === dashIndent) {
      return keys;
    }
  }

  return null;
}

function reindentMultilineApply(apply: string, indent: string): string {
  if (!apply.includes("\n")) {
    return apply;
  }

  return apply
    .split("\n")
    .map((line, index) => (index === 0 ? line : `${indent}${line}`))
    .join("\n");
}

// Nearest structural ancestor `key:` for a line, per YAML semantics: walk up,
// skip deeper lines, and skip list-entry lines of the enclosing list (their
// dash lowers the search threshold, finding the list's own key above them).
// The first ancestor key decides the context - a valued `key: x` line cannot
// have children, and hitting one returns null.
// Keys whose value is SQL; matches the highlighter's tokenizeSql set.
const SQL_VALUE_KEYS = new Set(["query", "dataview", "optionsQuery"]);

// True when a bare (colon-less) indented line continues the multi-line value
// of a `query:`/`dataview:`/`optionsQuery:` key. Those lines are query text,
// and YAML key suggestions there are noise - the completion stays silent, the
// same treatment the highlighter gives them (SQL tokens, not key marks).
function isSqlContinuationLine(state: EditorState, fence: PlacesFence, currentLine: number, indentThreshold: number): boolean {
  if (indentThreshold <= 0) {
    return false;
  }

  let threshold = indentThreshold;
  for (let lineNumber = currentLine - 1; lineNumber > fence.startLine; lineNumber--) {
    const text = state.doc.line(lineNumber).text;
    const trimmed = text.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const indent = getLineIndent(text);
    if (indent >= threshold) {
      continue;
    }

    if (/^-(\s|$)/u.test(trimmed)) {
      threshold = indent + 1;
      continue;
    }

    const key = trimmed.match(/^([A-Za-z][\w-]*)\s*:/u)?.[1] ?? null;
    if (key === null) {
      // A value-continuation line itself; keep climbing to its key.
      threshold = indent;
      continue;
    }

    return SQL_VALUE_KEYS.has(key);
  }

  return false;
}

export function getEnclosingParentKey(state: EditorState, fence: PlacesFence, currentLine: number, indentThreshold: number): string | null {
  if (indentThreshold <= 0) {
    return null;
  }

  let threshold = indentThreshold;
  for (let lineNumber = currentLine - 1; lineNumber > fence.startLine; lineNumber--) {
    const line = state.doc.line(lineNumber).text;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const indent = getLineIndent(line);
    if (indent >= threshold) {
      continue;
    }

    if (/^-(\s|$)/u.test(trimmed)) {
      threshold = indent + 1;
      continue;
    }

    return getYamlEmptyKey(trimmed);
  }

  return null;
}

// The key that introduces the list a `- ` item belongs to: the nearest ancestor
// line with less indentation, whether written as `key:` or `- key:`. The
// innermost list key wins - items under `- waypoints:` resolve to `waypoints`
// rather than the enclosing `routes`.
function getListParentKey(state: EditorState, fence: PlacesFence, currentLine: number, dashIndent: number): string | null {
  for (let lineNumber = currentLine - 1; lineNumber > fence.startLine; lineNumber--) {
    const text = state.doc.line(lineNumber).text;
    const trimmed = text.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    if (getLineIndent(text) >= dashIndent) {
      continue;
    }
    return getYamlEmptyKey(trimmed.replace(/^-\s+/u, ""));
  }
  return null;
}

function getPreviousNestedBlock(state: EditorState, fence: PlacesFence, currentLine: number): { key: string; indent: string } | null {
  const previous = getPreviousMeaningfulLine(state, fence, currentLine);
  if (!previous) {
    return null;
  }

  const key = getYamlEmptyKey(previous.text.trim());
  if (!key || !CodeBlockRegistry.instance.hasNestedKeys(fence.language, key)) {
    return null;
  }

  return {
    key,
    indent: previous.text.match(/^\s*/u)?.[0] ?? "",
  };
}

function getKeyItems(blockType: string): SuggestionItem[] {
  const registry = CodeBlockRegistry.instance;
  // Root completion offers only top-level keys; nested-only sub-keys (mode,
  // optimize, waypoints, path, ...) are completed under their parent instead.
  // Blocks that declare no rootKeys fall back to the full validKeys union.
  const rootKeys = registry.getRootKeys(blockType);
  const isRootKey = (key: string) => !rootKeys || rootKeys.has(key);
  const validKeys = registry.getValidKeys(blockType) ?? new Set<string>();
  const definition = registry.getDefinition(blockType);
  const parameterMap = new Map<string, ParameterDefinition>();
  const items: SuggestionItem[] = [];

  definition?.parameters.forEach((parameter) => {
    parameterMap.set(parameter.name, parameter);
    if (!isRootKey(parameter.name)) {
      return;
    }
    items.push({
      label: parameter.name,
      apply: `${parameter.name}: `,
      detail: parameter.description,
      type: "property",
    });
  });

  for (const key of validKeys) {
    if (parameterMap.has(key) || !isRootKey(key)) {
      continue;
    }

    const canonicalKey = KEY_ALIASES[key];
    const aliasOf = canonicalKey && parameterMap.has(canonicalKey)
      ? parameterMap.get(canonicalKey)?.name
      : undefined;

    items.push({
      label: key,
      apply: `${key}: `,
      detail: aliasOf ? `Alias for ${aliasOf}` : describeKey(blockType, key, canonicalKey ?? key),
      type: "property",
    });
  }

  return items;
}

function addItems(target: SuggestionItem[], seen: Set<string>, items: SuggestionItem[]): void {
  for (const item of items) {
    const key = item.apply.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    target.push(item);
  }
}

// What a suggestion for `key` should say, or nothing. The block's own
// ParameterDefinition wins; GENERIC_KEY_DESCRIPTIONS covers keys a block
// accepts without documenting (shared/nested keys). A key whose name says
// everything carries no description at all.
function describeKey(blockType: string, key: string, canonicalKey: string): string | undefined {
  const registry = CodeBlockRegistry.instance;
  const definition = registry.getDefinition(blockType);
  const parameter = definition?.parameters.find((item) => item.name === key || item.name === canonicalKey);
  return parameter?.description
    ?? registry.findNestedKeyDescription(blockType, key)
    ?? registry.findNestedKeyDescription(blockType, canonicalKey)
    ?? GENERIC_KEY_DESCRIPTIONS[canonicalKey];
}

function getKnownValueItems(blockType: string, key: string, canonicalKey: string): SuggestionItem[] {
  // Styles come from the loaded providers (tagged with their provider) instead
  // of the registry's merged highlighting list. `cache` is offered from the one
  // shared list, with a per-value explanation the registry cannot carry.
  if (canonicalKey === "style" || canonicalKey === "cache") {
    return [];
  }

  const registry = CodeBlockRegistry.instance;
  const blockValues = registry.getKnownValuesForBlock(blockType, key)
    ?? registry.getKnownValuesForBlock(blockType, canonicalKey);

  if (!blockValues || blockValues.size === 0) {
    return [];
  }

  const keyDetail = describeKey(blockType, key, canonicalKey);
  return Array.from(blockValues)
    .sort((left, right) => left.localeCompare(right))
    .map((value) => ({
      label: value,
      apply: value,
      // A closed set of named choices explains each option; everything else
      // (booleans, examples) is best described by what the key itself does.
      detail: valueDetail(canonicalKey, value) ?? valueDetail(key, value) ?? keyDetail,
      type: "enum",
    }));
}

// These keys are populated from the live list of registered providers (see getValueItems),
// and their `values` doc strings are prose ("any installed map provider, e.g. ...") and must
// never be parsed into selectable suggestions.
const DYNAMIC_VALUE_KEYS = new Set(["mapProvider", "routeProvider", "provider", "matchProvider", "style"]);

// Keys whose value is a vault note/file reference. Real suggestions come from
// getVaultFileItems (track1/track2) or Obsidian's own `[[` link suggester; the
// registry's example values (e.g. "[[Lake Scranton Weekend Run]]") are just
// documentation and would sit confusingly above the real files if offered.
const VAULT_REFERENCE_VALUE_KEYS = new Set(["track", "track1", "track2", "linkedPlaces", "fromTemplate"]);

// Keys whose meaning differs per block (a tide table's display name, the
// places block's radius filter): the block's own documented values describe
// the field and beat the generic format entry, which only covers blocks
// that leave the key undocumented.
const BLOCK_SPECIFIC_FORMAT_KEYS = new Set(["name", "radius"]);

function getDefinitionValueItems(blockType: string, key: string, canonicalKey: string, parentKey: string | null): SuggestionItem[] {
  if (DYNAMIC_VALUE_KEYS.has(canonicalKey) || VAULT_REFERENCE_VALUE_KEYS.has(canonicalKey)) {
    return [];
  }

  const scopedItems = parentKey ? FORMAT_VALUE_ITEMS[`${parentKey}.${canonicalKey}`] : undefined;
  if (scopedItems) {
    return scopedItems;
  }

  const definitionItems = (): SuggestionItem[] => {
    const definition = CodeBlockRegistry.instance.getDefinition(blockType);
    const parameter = definition?.parameters.find((item) => item.name === key || item.name === canonicalKey);
    if (!parameter || isFreeformValueDescription(parameter.values)) {
      return [];
    }

    return splitValueExamples(parameter.values)
      .map(normalizeValueExample)
      .filter((value): value is string => Boolean(value))
      .map((value) => ({
        label: value,
        apply: value,
        detail: valueDetail(canonicalKey, value) ?? valueDetail(key, value) ?? parameter.description,
        type: "enum",
      }));
  };

  if (BLOCK_SPECIFIC_FORMAT_KEYS.has(canonicalKey)) {
    const items = definitionItems();
    if (items.length > 0) {
      return items;
    }
  }

  return FORMAT_VALUE_ITEMS[canonicalKey] ?? definitionItems();
}

// The key/value pairs of the `overlays:` list entry containing `lineNumber`.
//
// A vector tile entry's `sourceLayer` and `filter` completions depend on the
// entry's own `url`/`tiles`, and need the sibling keys rather than the
// block-wide ones getFenceKeyValues collects.
function getEnclosingEntryValues(state: EditorState, fence: PlacesFence, lineNumber: number): Map<string, string> {
  const values = new Map<string, string>();
  const startIndent = getLineIndent(state.doc.line(lineNumber).text);
  let entryIndent: number | null = null;

  for (let current = lineNumber; current > fence.startLine; current--) {
    const text = state.doc.line(current).text;
    const trimmed = text.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const indent = getLineIndent(text);
    if (indent > startIndent && current !== lineNumber) continue;
    const isDash = /^-(\s|$)/u.test(trimmed);
    // A shallower non-dash line is the parent key: the entry ended.
    if (entryIndent === null && indent < startIndent && !isDash) break;

    const content = isDash ? trimmed.replace(/^-\s?/u, "") : trimmed;
    const match = content.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/u);
    if (match && !values.has(match[1])) {
      values.set(match[1], match[2].trim().replace(/^['"]|['"]$/gu, ""));
    }

    if (isDash) {
      entryIndent = indent;
      break;
    }
  }

  return values;
}

// The TileJSON URL a vector tile overlay entry points at, if it declares one.
function getEntryTileJsonUrl(entry: Map<string, string>): string | undefined {
  return entry.get("url") ?? entry.get("tileJson") ?? entry.get("tilejson");
}

// `sourceLayer` and `filter` completed from the tileset itself; the names are
// not guessable.
function getTileJsonItems(state: EditorState, fence: PlacesFence, currentLine: number, canonicalKey: string): { items: SuggestionItem[]; authoritative: boolean } {
  if (canonicalKey !== "sourceLayer" && canonicalKey !== "sourceLayers" && canonicalKey !== "filter") {
    return { items: [], authoritative: false };
  }

  const entry = getEnclosingEntryValues(state, fence, currentLine);
  const url = getEntryTileJsonUrl(entry);
  if (!url) return { items: [], authoritative: false };

  const index = TileJsonLayerIndex.instance;

  if (canonicalKey === "filter") {
    const fields = index.fields(url, entry.get("sourceLayer"));
    if (!fields) return { items: [], authoritative: false };
    return {
      authoritative: true,
      items: Object.entries(fields)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, type]) => ({
          label: name,
          apply: `${name} `,
          detail: `${type} field on ${entry.get("sourceLayer")}`,
          type: "property",
          boost: 1,
        })),
    };
  }

  const layers = index.peek(url);
  if (!layers) {
    // The fetch was scheduled by peek; report that rather than showing nothing, and
    // the popup refills when it lands. Not authoritative - the format hint
    // still helps someone who would rather just type the name.
    return {
      authoritative: false,
      items: index.isLoading(url)
        ? [{ label: "Loading layers...", apply: "", detail: `Reading vector_layers from ${url}`, type: "text" }]
        : [],
    };
  }

  return { authoritative: true, items: layers.map(layer => {
    const fieldCount = Object.keys(layer.fields).length;
    const zoom = layer.minzoom !== undefined && layer.maxzoom !== undefined ? `, z${layer.minzoom}-${layer.maxzoom}` : "";
    return {
      label: layer.id,
      apply: layer.id,
      detail: layer.description ?? `${fieldCount} field${fieldCount === 1 ? "" : "s"}${zoom}`,
      type: "enum",
      boost: 1,
    };
  }) };
}

function getVaultFileItems(services: PlacesCompletionServices, fence: PlacesFence, canonicalKey: string, overlayParentKey?: string | null): SuggestionItem[] {
  const files = services.app.vault.getFiles();

  // `path:` inside an overlay entry completes to vault files (geodata + image
  // in a places block; images only in a places-image-align block).
  if (canonicalKey === "path" && overlayParentKey) {
    const allowedExtensions = overlayParentKey === "overlays"
      ? fence.language === "places-image-align"
        ? IMAGE_OVERLAY_FILE_EXTENSIONS
        : new Set([...GEOJSON_OVERLAY_FILE_EXTENSIONS, ...IMAGE_OVERLAY_FILE_EXTENSIONS])
      : null;
    if (!allowedExtensions) {
      return [];
    }

    return files
      .filter((file) => allowedExtensions.has(file.extension.toLowerCase()))
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => ({
        label: file.path,
        apply: file.path,
        detail: IMAGE_OVERLAY_FILE_EXTENSIONS.has(file.extension.toLowerCase()) ? "Vault image overlay" : "Vault overlay file",
        type: "text",
      }));
  }

  if (canonicalKey === "overlays") {
    // `overlays` accepts both geodata and image files; images need bounds to georeference.
    const allowedExtensions = fence.language === "places-image-align"
      ? IMAGE_FILE_EXTENSIONS
      : new Set([...GEOJSON_OVERLAY_FILE_EXTENSIONS, ...IMAGE_OVERLAY_FILE_EXTENSIONS]);

    const isImageFile = (file: TFile) => IMAGE_OVERLAY_FILE_EXTENSIONS.has(file.extension.toLowerCase());
    return files
      .filter((file) => allowedExtensions.has(file.extension.toLowerCase()))
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => ({
        label: file.path,
        apply: isImageFile(file) ? `- path: ${file.path}\n  bounds: ` : `- path: ${file.path}`,
        detail: fence.language === "places-image-align" || isImageFile(file) ? "Vault image overlay" : "Vault overlay file",
        type: "text",
      }));
  }

  // `track` (places-snap/places-elevation, single track) reaches value mode only
  // where it is a file reference; the places block's own `track:` is a nested
  // config key resolved as nestedKey mode, and never lands here.
  if (canonicalKey === "track" || canonicalKey === "track1" || canonicalKey === "track2") {
    return trackFileSuggestions(files);
  }

  // `linkedPlaces` appends place notes; offer vault notes as wiki links (the
  // native `[[` suggester does not fire inside a code fence).
  if (canonicalKey === "linkedPlaces") {
    return noteFileSuggestions(files, "Place note");
  }

  // A template is any note holding a places-template block: every note is a
  // candidate.
  if (canonicalKey === "fromTemplate") {
    return noteFileSuggestions(files, "Template note");
  }

  return [];
}

// Track notes and track data files, as wiki links (md) or quoted paths (gpx/csv/...).
function trackFileSuggestions(files: TFile[]): SuggestionItem[] {
  return files
    .filter((file) => TRACK_FILE_EXTENSIONS.has(file.extension.toLowerCase()))
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => ({
      label: file.path,
      apply: file.extension.toLowerCase() === "md"
        ? `[[${file.path.replace(/\.md$/iu, "")}]]`
        : `"${file.path}"`,
      detail: file.extension.toLowerCase() === "md" ? "Track note" : "Track/overlay file",
      type: "text",
    }));
}

// Vault notes as wiki links, for keys that reference a note.
function noteFileSuggestions(files: TFile[], detail: string): SuggestionItem[] {
  return files
    .filter((file) => file.extension.toLowerCase() === "md")
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => ({
      label: file.path,
      apply: `[[${file.path.replace(/\.md$/iu, "")}]]`,
      detail,
      type: "text",
    }));
}

// The current-note token and coordinate format offered alongside real notes for
// list keys that accept a note, a coordinate, or the current note.
const NOTE_OR_COORD_EXTRAS: SuggestionItem[] = [
  { label: "{this}", apply: "{this}", detail: "Current note location", type: "text" },
  formatItem("coordinates", "<name>: <lat>, <lng>", "Optional name, then latitude and longitude", "Home: 41.408, -75.662"),
];

// List keys whose ITEMS are note/file references. Their list items offer real
// vault files (never a fabricated "[[Start]]"/"[[Home]]" example): "track" ->
// track files; "note" -> vault notes plus the {this}/coordinate scaffolds.
const VAULT_REFERENCE_LIST_KEYS: Record<string, "track" | "note"> = {
  fromTemplate: "note",
  tracks: "track",
  centers: "note",
  waypoints: "note",
};

function getVaultReferenceListItems(services: PlacesCompletionServices, listKey: string): SuggestionItem[] {
  const kind = VAULT_REFERENCE_LIST_KEYS[listKey];
  if (!kind) {
    return [];
  }
  const files = services.app.vault.getFiles();
  return kind === "track"
    ? trackFileSuggestions(files)
    : [...NOTE_OR_COORD_EXTRAS, ...noteFileSuggestions(files, "Note")];
}

function getFenceKeyValues(state: EditorState, fence: PlacesFence, currentLine: number): Map<string, string> {
  const pairs = new Map<string, string>();

  for (let lineNumber = fence.startLine + 1; lineNumber <= Math.min(currentLine, fence.endLine); lineNumber++) {
    const line = state.doc.line(lineNumber).text;
    const match = line.match(/^\s*([A-Za-z][\w-]*)\s*:\s*(.+?)\s*$/u);
    if (!match) {
      continue;
    }

    const [, rawKey, rawValue] = match;
    const value = rawValue
      .trim()
      .replace(/^['"]|['"]$/gu, "")
      .split(",")[0]
      ?.trim()
      .toLowerCase();

    if (value) {
      pairs.set(rawKey.trim(), value);
    }
  }

  return pairs;
}

function getContextualValueItems(state: EditorState, fence: PlacesFence, currentLine: number, key: string, canonicalKey: string): SuggestionItem[] {
  const registry = CodeBlockRegistry.instance;
  const contextPairs = getFenceKeyValues(state, fence, currentLine);

  for (const [contextKey, contextValue] of contextPairs) {
    const values = registry.getContextualKnownValuesForBlock(fence.language, key, contextKey, contextValue)
      ?? registry.getContextualKnownValuesForBlock(fence.language, canonicalKey, contextKey, contextValue);
    if (!values || values.size === 0) {
      continue;
    }

    // The key being completed and the context line are both on screen already,
    // so a detail naming them carries nothing. Better none than that.
    return Array.from(values)
      .sort((left, right) => left.localeCompare(right))
      .map((value) => {
        const detail = valueDetail(canonicalKey, value);
        return { label: value, apply: value, ...(detail ? { detail } : {}), type: "enum" };
      });
  }

  return [];
}

function getMapProviderForFence(services: PlacesCompletionServices, state: EditorState, fence: PlacesFence, currentLine: number): string | null {
  const contextPairs = getFenceKeyValues(state, fence, currentLine);
  return contextPairs.get("mapProvider")
    ?? contextPairs.get("provider")
    ?? services.resolveMapProvider()
    ?? null;
}

// Provider names, alphabetical, with the one that applies when the key is
// omitted marked.
function toProviderItems(providers: readonly string[], defaultProvider: string | undefined): SuggestionItem[] {
  return [...providers]
    .sort((left, right) => left.localeCompare(right))
    .map((provider) => ({
      label: provider,
      apply: provider,
      ...(provider === defaultProvider ? { detail: "Default" } : {}),
      type: "enum",
    }));
}

function getValueItems(services: PlacesCompletionServices, state: EditorState, fence: PlacesFence, currentLine: number, key: string): SuggestionItem[] {
  const canonicalKey = KEY_ALIASES[key] ?? key;
  const items: SuggestionItem[] = [];
  const seen = new Set<string>();
  const fenceProvider = canonicalKey === "style"
    ? getMapProviderForFence(services, state, fence, currentLine)?.toLowerCase() ?? null
    : null;

  addItems(items, seen, getContextualValueItems(state, fence, currentLine, key, canonicalKey));
  // The registry's style values are the union used by syntax highlighting.
  // Once a provider is known, autocomplete must not offer styles belonging to
  // other providers.
  if (canonicalKey !== "style" || !fenceProvider) {
    addItems(items, seen, getKnownValueItems(fence.language, key, canonicalKey));
  }

  if (canonicalKey === "mapProvider") {
    addItems(items, seen, toProviderItems(services.getMapProviders(), services.resolveMapProvider()));
  }

  if (canonicalKey === "routeProvider" || canonicalKey === "provider") {
    // `provider` is shared: under `terrain` it names a DEM source, everywhere else a route provider.
    const underTerrain = canonicalKey === "provider"
      && getEnclosingParentKey(state, fence, currentLine, getLineIndent(state.doc.line(currentLine).text)) === "terrain";
    const isSnapFence = fence.language === "places-snap";
    const isElevationFence = fence.language === "places-elevation";
    const providers = underTerrain
      ? services.getTerrainProviders()
      : isElevationFence
        ? services.getElevationProviders()
        : isSnapFence
          ? services.getSnapProviders()
          : services.getRouteProviders();
    // Snap and elevation resolve to the first registered service; a route
    // group prefers the map's own provider and falls back the same way. No
    // documented rule picks a terrain default, and none is claimed.
    const routeDefault = getMapProviderForFence(services, state, fence, currentLine)?.toLowerCase();
    const defaultProvider = underTerrain
      ? undefined
      : !isElevationFence && !isSnapFence && routeDefault && providers.includes(routeDefault)
        ? routeDefault
        : providers[0];
    addItems(items, seen, toProviderItems(providers, defaultProvider));
  }

  if (canonicalKey === "matchProvider") {
    // places-classify names valhalla outright rather than taking the first registered.
    addItems(items, seen, toProviderItems(services.getTrackMatchProviders(), "valhalla"));
  }

  if (canonicalKey === "style") {
    const providerNames = fenceProvider
      ? [fenceProvider]
      : services.getStyleProviders().sort((left, right) => left.localeCompare(right));
    // Naming the provider separates two providers offering the same style name.
    // Inside a block that already names one, every style listed is that
    // provider's, and repeating it says nothing the key does not.
    for (const providerName of providerNames) {
      addItems(items, seen, services.getStylesForProvider(providerName)
        .sort((left, right) => left.localeCompare(right))
        .map((style) => ({
          label: style,
          apply: style,
          ...(fenceProvider ? {} : { detail: providerName }),
          type: "enum",
        })));
    }
  }

  // The tileset's own layer and field names beat the generic format hint, and
  // when known they replace it rather than sitting above it.
  const tileJson = getTileJsonItems(state, fence, currentLine, canonicalKey);
  addItems(items, seen, tileJson.items);

  const overlayParentKey = canonicalKey === "path"
    ? getEnclosingParentKey(state, fence, currentLine, getLineIndent(state.doc.line(currentLine).text))
    : null;
  addItems(items, seen, getVaultFileItems(services, fence, canonicalKey, overlayParentKey));
  if (!tileJson.authoritative) {
    const parentKey = getEnclosingParentKey(state, fence, currentLine, getLineIndent(state.doc.line(currentLine).text));
    addItems(items, seen, getDefinitionValueItems(fence.language, key, canonicalKey, parentKey));
  }

  // "type" is shared by query parameters (int, float, ...) and overlay kind
  // overrides (geodata, image, vector-tile); scope the suggestions to the
  // enclosing block.
  if (canonicalKey === "type") {
    const parent = getEnclosingParentKey(state, fence, currentLine, getLineIndent(state.doc.line(currentLine).text));
    const inQueryParameters = parent === "queryParameters";
    return items.filter((item) => item.type !== "enum" || QUERY_PARAMETER_TYPE_VALUES.has(item.label) === inQueryParameters);
  }

  return items;
}

const QUERY_PARAMETER_TYPE_VALUES = new Set(["int", "float", "string", "date", "datetime", "time", "boolean", "enum", "list"]);

function indentExpandedListSnippet(snippet: string, parentIndent: string): string {
  const itemIndent = `${parentIndent}  `;
  return snippet
    .split("\n")
    .map((line) => `${itemIndent}${line}`)
    .join("\n");
}

function prepareValueItemsForContext(state: EditorState, context: PlacesCompletionContext, items: SuggestionItem[]): SuggestionItem[] {
  if (context.mode !== "value" || !context.key) {
    return items;
  }

  const canonicalKey = KEY_ALIASES[context.key] ?? context.key;
  if (!EXPANDED_LIST_VALUE_KEYS.has(canonicalKey)) {
    return items;
  }

  const line = state.doc.lineAt(context.from);
  const parentIndent = line.text.match(/^\s*/u)?.[0] ?? "";
  return items.map((item) => {
    if (!item.apply.startsWith("- ")) {
      return item;
    }

    return {
      ...item,
      apply: `\n${indentExpandedListSnippet(item.apply, parentIndent)}`,
    };
  });
}

function hasEmptyValueSuggestions(state: EditorState, services: PlacesCompletionServices, fence: PlacesFence, currentLine: number, key: string): boolean {
  const canonicalKey = KEY_ALIASES[key] ?? key;
  return !QUIET_EMPTY_VALUE_KEYS.has(canonicalKey)
    && getValueItems(services, state, fence, currentLine, key).length > 0;
}

function splitValueExamples(source: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === "\"") {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }

    if (char === "," && !inQuotes) {
      parts.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  if (current) {
    parts.push(current);
  }

  return parts;
}

function normalizeValueExample(rawValue: string): string | null {
  const withoutBold = rawValue.replace(/\*\*/gu, "").trim();
  if (!withoutBold) {
    return null;
  }

  // No "/" handling: a slash in an example is part of the value (IANA
  // timezones, paths), never an "either/or" separator.
  const withoutParens = withoutBold.replace(/\s*\([^)]*\)\s*$/u, "").trim();
  const cleaned = withoutParens
    .replace(/\s+or\s+.+$/iu, "")
    .replace(/^default:\s*/iu, "")
    .trim();

  // A "[[Note]]" example is a vault-specific note reference, never a selectable
  // enum value - dropped, leaving real files (or Obsidian's link suggester) to stand alone.
  return cleaned && !cleaned.includes("...") && !cleaned.includes("[[")
    ? cleaned
    : null;
}

function isFreeformValueDescription(source: string): boolean {
  const normalized = source.toLowerCase();
  return normalized.includes("sql query string")
    || normalized.includes("multi-line css block")
    || normalized.includes("condition =>")
    || normalized.includes("emoji")
    || normalized.includes("note's ")
    || normalized.includes("or note's ")
    || normalized.includes("(varies by provider)")
    || normalized.startsWith("(first available provider)");
}

function isMultiValueKey(blockType: string, key: string): boolean {
  const canonicalKey = KEY_ALIASES[key] ?? key;
  if (MULTI_VALUE_KEYS.has(canonicalKey)) {
    return true;
  }

  const definition = CodeBlockRegistry.instance.getDefinition(blockType);
  const parameter = definition?.parameters.find((item) => item.name === key || item.name === canonicalKey);
  return parameter?.description?.toLowerCase().includes("comma-separated") ?? false;
}

function getValueSegmentStart(line: string, valueStart: number, blockType: string, key: string, cursorCh: number): number {
  if (!isMultiValueKey(blockType, key)) {
    return valueStart;
  }

  const beforeCursor = line.slice(0, cursorCh);
  return beforeCursor.lastIndexOf(",") >= valueStart
    ? beforeCursor.lastIndexOf(",") + 1
    : valueStart;
}

function skipWhitespace(line: string, start: number): number {
  let index = start;
  while (index < line.length && /\s/u.test(line[index])) {
    index++;
  }
  return index;
}

function getTriggerStartForSegment(line: string, segmentStart: number, cursorCh: number): number {
  const contentStart = skipWhitespace(line, segmentStart);
  if (contentStart >= line.length) {
    return contentStart;
  }

  const quote = line[contentStart];
  return (quote === "\"" || quote === "'") && cursorCh > contentStart
    ? contentStart + 1
    : contentStart;
}

export function getCompletionContext(state: EditorState, services: PlacesCompletionServices, pos: number): PlacesCompletionContext | null {
  const fence = getPlacesFenceAtPos(state, pos);
  if (!fence) {
    return null;
  }

  const docLine = state.doc.lineAt(pos);
  const lineNumber = docLine.number;
  if (lineNumber >= fence.endLine) {
    return null;
  }

  const line = docLine.text;
  const cursorCh = pos - docLine.from;
  const beforeCursor = line.slice(0, cursorCh);
  const listMatch = line.match(/^(\s*)-\s*(.*)$/u);
  if (listMatch) {
    const [, indent = "", value = ""] = listMatch;
    const valueStartCh = indent.length + 1 + (line[indent.length + 1] === " " ? 1 : 0);
    if (cursorCh < valueStartCh) {
      return null;
    }

    // "- key: value" entries complete the value like any key line would.
    const entryKeyMatch = value.match(/^([A-Za-z][\w-]*)\s*:\s?/u);
    if (entryKeyMatch && cursorCh >= valueStartCh + entryKeyMatch[0].length) {
      const entryKey = entryKeyMatch[1];
      const entryValueStartCh = valueStartCh + entryKeyMatch[0].length;
      const query = beforeCursor.slice(entryValueStartCh).trim();
      if (!query && !hasEmptyValueSuggestions(state, services, fence, lineNumber, entryKey)) {
        return null;
      }

      return {
        mode: "value",
        fence,
        from: docLine.from + entryValueStartCh,
        to: pos,
        query,
        key: entryKey,
      };
    }

    const query = value.slice(0, Math.max(0, cursorCh - valueStartCh)).trim();
    const listParentKey = getListParentKey(state, fence, lineNumber, indent.length);
    const registry = CodeBlockRegistry.instance;
    if (!listParentKey || (!registry.hasListItemTemplates(fence.language, listParentKey) && !registry.hasNestedKeys(fence.language, listParentKey) && !VAULT_REFERENCE_LIST_KEYS[listParentKey])) {
      return null;
    }

    return {
      mode: "listItem",
      fence,
      from: docLine.from + valueStartCh,
      to: pos,
      query,
      listParentKey,
    };
  }

  const keyMatch = line.match(/^(\s*)([A-Za-z][\w-]*)?\s*(?::\s*(.*))?$/u);
  if (!keyMatch) {
    return null;
  }

  const [, indent = "", rawKey = ""] = keyMatch;
  const colonIndex = line.indexOf(":");
  if (colonIndex === -1 || cursorCh <= colonIndex) {
    const keyStartCh = indent.length;
    if (isSqlContinuationLine(state, fence, lineNumber, getLineIndent(line))) {
      return null;
    }
    const query = beforeCursor.slice(keyStartCh).trim();
    const previousRouteBlock = !query && line.trim() === ""
      ? getPreviousNestedBlock(state, fence, lineNumber)
      : null;
    const enclosingParent = getEnclosingParentKey(state, fence, lineNumber, getLineIndent(line));
    const nestedBlockKey = (enclosingParent && CodeBlockRegistry.instance.hasNestedKeys(fence.language, enclosingParent) ? enclosingParent : null)
      ?? previousRouteBlock?.key
      ?? null;
    if (!query && !nestedBlockKey) {
      return null;
    }

    return {
      mode: nestedBlockKey ? "nestedKey" : "key",
      fence,
      from: docLine.from + keyStartCh,
      // When renaming an existing key, consume its old colon and spacing as
      // well as the typed prefix. Completion items already insert `: `, and
      // leaving the delimiter behind produces `corners: : value`.
      to: colonIndex === -1
        ? pos
        : docLine.from + (line.slice(colonIndex + 1).match(/^\s*/u)?.[0].length ?? 0) + colonIndex + 1,
      query,
      nestedBlockKey: nestedBlockKey ?? undefined,
      applyPrefix: previousRouteBlock && indent.length <= previousRouteBlock.indent.length
        ? `${previousRouteBlock.indent}  `
        : undefined,
    };
  }

  const key = rawKey.trim();
  if (!key) {
    return null;
  }

  const isRootScalarStyle = key === 'style' && indent.length === 0;
  if (key !== "overlays" && !isRootScalarStyle && CodeBlockRegistry.instance.hasNestedKeys(fence.language, key) && beforeCursor.slice(colonIndex + 1).trim() === "") {
    return {
      mode: "nestedKey",
      fence,
      from: pos,
      to: pos,
      query: "",
      nestedBlockKey: key,
      applyPrefix: "\n  ",
    };
  }

  const valueStartCh = colonIndex + 1;
  const segmentStartCh = getValueSegmentStart(line, valueStartCh, fence.language, key, cursorCh);
  const triggerStartCh = getTriggerStartForSegment(line, segmentStartCh, cursorCh);
  if (triggerStartCh > cursorCh) {
    return null;
  }

  const query = beforeCursor.slice(triggerStartCh).trim();
  if (!query
    && (beforeCursor[beforeCursor.length - 1] ?? "") !== "."
    && !hasEmptyValueSuggestions(state, services, fence, lineNumber, key)
  ) {
    return null;
  }

  return {
    mode: "value",
    fence,
    from: docLine.from + triggerStartCh,
    to: pos,
    query,
    key,
  };
}

export function getCompletionItems(services: PlacesCompletionServices, state: EditorState, context: PlacesCompletionContext): SuggestionItem[] {
  // Provider-owned `*-vaultquery` blocks supply their own completions through VaultQuery;
  // suppress the places completion here, keeping keys/values from being suggested twice.
  if (context.fence.language.endsWith('-vaultquery')) {
    return [];
  }

  const withApplyPrefix = (items: SuggestionItem[]): SuggestionItem[] => {
    if (!context.applyPrefix) {
      return items;
    }

    return items.map((item) => ({
      ...item,
      apply: `${context.applyPrefix}${item.apply}`,
    }));
  };

  if (context.mode === "listItem" && context.listParentKey) {
    // List keys that reference notes/files offer real vault files, never a
    // fabricated example, matching the scalar note/file keys.
    if (VAULT_REFERENCE_LIST_KEYS[context.listParentKey]) {
      return withApplyPrefix(getVaultReferenceListItems(services, context.listParentKey));
    }

    // Structured lists (overlay entries, query parameters) start entries with a
    // sub-key; scalar lists (routes) get value templates.
    const templates = getListItemTemplateItems(context.fence.language, context.listParentKey);
    if (templates.length > 0) {
      const dashLine = state.doc.lineAt(context.from);
      const dashIndent = " ".repeat(getLineIndent(dashLine.text));
      // Templates are authored as though their list dash starts in column 0:
      // `- key:` begins at column 0 and continuation lines carry their own
      // relative indentation. Rebase those continuation lines to the actual
      // dash indentation while leaving the first line after the existing `- `.
      return withApplyPrefix(templates.map(item => ({
        ...item,
        apply: reindentMultilineApply(item.apply, dashIndent),
      })));
    }

    // A sub-key the entry above lacks usually continues that entry: accepting
    // it converts the fresh "- " into indentation. Keys the entry above already
    // has start a new entry (repeating a key is what begins entries).
    const dashLine = state.doc.lineAt(context.from);
    const dashIndent = getLineIndent(dashLine.text);
    const previousEntryKeys = getPreviousEntryKeys(state, context.fence, dashLine.number, dashIndent);
    const entryIndent = " ".repeat(dashIndent + 2);
    return withApplyPrefix(getNestedKeyItems(context.fence.language, context.listParentKey).map((item) => {
      if (!previousEntryKeys || previousEntryKeys.has(item.label)) {
        return { ...item, apply: reindentMultilineApply(item.apply, entryIndent) };
      }

      return {
        ...item,
        boost: 1,
        detail: item.detail ? `${item.detail} (continues the entry above)` : "Continues the entry above",
        replaceLineWith: `${entryIndent}${reindentMultilineApply(item.apply, entryIndent)}`,
      };
    }));
  }

  if (context.mode === "nestedKey" && context.nestedBlockKey) {
    const lineIndent = context.applyPrefix === undefined
      ? state.doc.lineAt(context.from).text.match(/^\s*/u)?.[0] ?? ""
      : "  ";
    return withApplyPrefix(getNestedKeyItems(context.fence.language, context.nestedBlockKey).map((item) => ({
      ...item,
      apply: reindentMultilineApply(item.apply, lineIndent),
    })));
  }

  if (context.mode === "value" && context.key) {
    const items = getValueItems(services, state, context.fence, state.doc.lineAt(context.from).number, context.key);
    return prepareValueItemsForContext(state, context, items);
  }

  return getKeyItems(context.fence.language);
}

function toCompletion(item: SuggestionItem): Completion {
  const replaceLineWith = item.replaceLineWith;
  return {
    label: item.label,
    apply: replaceLineWith === undefined
      ? item.apply
      : (view, _completion, from, to) => {
        const line = view.state.doc.lineAt(from);
        view.dispatch({
          changes: { from: line.from, to, insert: replaceLineWith },
          selection: { anchor: line.from + replaceLineWith.length },
          userEvent: "input.complete",
        });
      },
    detail: item.detail,
    type: item.type,
    boost: item.boost,
  };
}

function placesCompletionSource(services: PlacesCompletionServices) {
  return (context: CompletionContext): CompletionResult | null => {
    const placesContext = getCompletionContext(context.state, services, context.pos);
    if (!placesContext) {
      return null;
    }
    if (!context.explicit && isIndentOnlyEmptyKeyContext(context.state, context.pos, placesContext)) {
      return null;
    }

    const options = getCompletionItems(services, context.state, placesContext);
    if (options.length === 0) {
      return null;
    }

    return {
      from: placesContext.from,
      to: placesContext.to,
      options: options.map(toCompletion),
      validFor: /^[\w.#{}[\]/,"'-]*$/u,
    };
  };
}

function isIndentOnlyEmptyKeyContext(state: EditorState, pos: number, context: PlacesCompletionContext): boolean {
  if (context.applyPrefix) {
    return false;
  }

  if (context.query !== "" || (context.mode !== "key" && context.mode !== "nestedKey")) {
    return false;
  }

  const line = state.doc.lineAt(pos);
  return line.text.slice(0, pos - line.from).trim() === "";
}

function shouldStartCompletionAfterUpdate(update: ViewUpdate, services: PlacesCompletionServices): boolean {
  if (!update.docChanged || completionStatus(update.state) !== null) {
    return false;
  }

  const selection = update.state.selection;
  if (selection.ranges.length !== 1 || !selection.main.empty) {
    return false;
  }

  const context = getCompletionContext(update.state, services, selection.main.head);
  if (context && isIndentOnlyEmptyKeyContext(update.state, selection.main.head, context)) {
    return false;
  }
  return Boolean(context && context.query === "" && (context.mode === "nestedKey" || context.mode === "value" || context.mode === "listItem"));
}

function placesCompletionStarter(services: PlacesCompletionServices): Extension {
  return ViewPlugin.fromClass(class {
    private pendingStart: number | null = null;

    update(update: ViewUpdate): void {
      if (!shouldStartCompletionAfterUpdate(update, services)) {
        return;
      }

      if (this.pendingStart !== null) {
        window.clearTimeout(this.pendingStart);
      }

      this.pendingStart = window.setTimeout(() => {
        this.pendingStart = null;
        if (completionStatus(update.view.state) === null) {
          startCompletion(update.view);
        }
      }, 0);
    }

    destroy(): void {
      if (this.pendingStart !== null) {
        window.clearTimeout(this.pendingStart);
      }
    }
  });
}

function placesLiteralInputHandler(): Extension {
  return Prec.highest(EditorView.inputHandler.of((view, from, _to, text, insert) => {
    if ((text !== "*" && text !== "#") || !getPlacesFenceAtPos(view.state, from)) {
      return false;
    }

    view.dispatch(insert());
    return true;
  }));
}

// Completion sources are synchronous, and a TileJSON that was still loading
// produced a placeholder item. Re-running completion when the document lands
// swaps that for the real layer list without the user typing again.
function tileJsonCompletionRefresher(): Extension {
  return ViewPlugin.fromClass(class {
    private readonly unsubscribe: () => void;

    constructor(private readonly view: EditorView) {
      this.unsubscribe = TileJsonLayerIndex.instance.subscribe(() => {
        if (completionStatus(this.view.state) !== null) {
          startCompletion(this.view);
        }
      });
    }

    destroy(): void {
      this.unsubscribe();
    }
  });
}

export function createPlacesCompletionExtension(services: PlacesCompletionServices): Extension {
  const source = placesCompletionSource(services);

  return [
    autocompletion(),
    EditorState.languageData.of(() => [{ autocomplete: source }]),
    placesLiteralInputHandler(),
    Prec.lowest(placesCompletionStarter(services)),
    tileJsonCompletionRefresher(),
  ];
}
