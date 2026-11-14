import { autocompletion, completionStatus, startCompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { App, TFile } from "obsidian";
import { parseNamedCoordinate } from "places-shared/geo";
import { parameterValueOptions, type ParameterDefinition } from "places-shared/services";
import { CACHE_PARAMETER_DESCRIPTION, CACHE_VALUE_SUGGESTIONS, getYamlColumn, PLACE_SETTINGS_PATHS, STYLE_RULE_KEYS, valueDetail } from "places-shared/settings";
import { normalizePropertyName, readNormalizedProperty } from "places-shared/utils";
import { IMAGE_OVERLAY_FILE_EXTENSIONS, isImageOverlayDefinition } from "places-shared/overlay";
import { CodeBlockRegistry } from "../services/CodeBlockRegistry";
import { TileJsonLayerIndex } from "../services/TileJsonLayerIndex";
import type { ProviderStyle } from "../services/ProviderStyles";
import { getPlacesYamlLine, yamlScopeValues, getPlacesFenceAtPos, getPreviousMeaningfulLine, getYamlEmptyKey, type PlacesFence } from "./PlacesEditorContext";

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

type CompletionMode = "key" | "value" | "nestedKey" | "listItem" | "placeKey" | "placeValue";

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
  placeStartLine?: number;
}

interface PlacesCompletionServices {
  app: App;
  getMapProviders: () => string[];
  getRouteProviders: () => string[];
  getSnapProviders: () => string[];
  getElevationProviders: () => string[];
  getTrackMatchProviders: () => string[];
  getTerrainProviders: () => string[];
  getStylesForProvider: (providerName: string) => ProviderStyle[];
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

const GENERIC_KEY_DESCRIPTIONS: Record<string, string> = {
  bounds: "Image overlay bounds",
  cache: CACHE_PARAMETER_DESCRIPTION,
  cellSelection: "Weather grid cell preference for coastal areas",
  clusterGeoJsonOverlays: "Include GeoJSON overlay points in marker clustering",
  clusterStyle: "Draw clusters as counted circles or as a density heatmap",
  iconImageDetail: "Detail each iconImage photograph is drawn with",
  clusterThreshold: "Viewport point count above which markers collapse into clusters; 0 disables clustering",
  debug: "Render a diagnostic panel instead of, or alongside, the normal output",
  gradeDistance: "Deprecated spelling of gradeWindow, in feet",
  gradeWindow: "Rolling-grade window: maps accept distance; charts also accept time",
  speedWindow: "Span speed and pace are averaged over: a distance such as 200m, or a time such as 30s",
  poiDiscovery: "Allow clicking points of interest baked into the base map (vector tile styles only)",
  showCurrentDevicePosition: "Available on mobile.",
  queryParameters: "Interactive controls whose values substitute into the query and other settings as {parameter.name}",
  costing: "Valhalla costing name, overriding the one mode resolves to",
  costingOptions: "Options for the effective costing, passed through verbatim",
  shapeMatch: "Valhalla matching strategy",
  traceOptions: "Valhalla trace options that tune the matcher itself",
  wayDetails: "Report the named ways and surfaces the match ran along",
  tidy: "Collapse near-duplicate points before matching (Mapbox)",
  timestamps: "Send recorded point times to the matcher",
  exclude: "Way classes to keep the match off (Mapbox)",
  queryParametersCollapsed: "Start the parameter strip collapsed",
  queryParametersPosition: "Where the parameter strip sits relative to the block",
  radius: "Filter results to those within a distance of one or more points",
  centers: "Isochrone center points",
  columns: "Columns to display",
  corners: "Image overlay corner coordinates",
  css: "Inline CSS for this block",
  current: "Current weather variables",
  daily: "Daily weather variables",
  days: "Calendar days to display",
  directions: "Directions overlay configuration",
  endDate: "Inclusive end date",
  endTime: "End hour filter",
  overlays: "Overlay files (geodata, image, or vector tile)",
  height: "Rendered block height",
  iconImageStyles: "Picture marker style rules",
  iconStyles: "Marker icon style rules",
  isochrones: "Isochrone overlay configuration",
  labelStyles: "Map label style rules",
  labelTemplate: "Marker label template",
  iconRotation: "Marker rotation in degrees clockwise from north; a number or a per-place template",
  places: "Linked files and manual place properties",
  location: "Location name or coordinates",
  markerRenderer: "Marker rendering mode",
  minutely15: "15-minute weather variables",
  routeProvider: "Directions or isochrone provider",
  startTime: "Start hour filter",
  style: "Style from the selected map provider",
  waypointLabelTemplate: "Waypoint marker label template (route endpoints and GPX <wpt>)",
  width: "Rendered block width",
};

const MULTI_VALUE_KEYS = new Set([
  "columns",
  "current",
  "daily",
  "hourly",
  "ignoreRoadClasses",
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
  "iconImageStyles",
  "iconStyles",
  "isochrones",
  "labelStyles",
  "query",
  "routes",
  "centers",
]);

const TRACK_FILE_EXTENSIONS = new Set(["md", "gpx", "fit", "geojson", "json", "csv"]);
const IMAGE_FILE_EXTENSIONS = new Set<string>(IMAGE_OVERLAY_FILE_EXTENSIONS);
const OVERLAY_FILE_EXTENSIONS = new Set([...TRACK_FILE_EXTENSIONS, ...IMAGE_FILE_EXTENSIONS]);

function getNestedKeyItems(blockType: string, parentKey: string): SuggestionItem[] {
  const definitions = CodeBlockRegistry.instance.getNestedKeys(blockType, parentKey) ?? [];

  return definitions.map((definition) => ({
    label: definition.name,
    apply: definition.apply ?? `${definition.name}: `,
    detail: definition.description,
    type: "property",
  }));
}

function getContextualNestedKeyItems(state: EditorState, context: PlacesCompletionContext, parentKey: string): SuggestionItem[] {
  const items = getNestedKeyItems(context.fence.language, parentKey);

  if (parentKey === 'content.options') {
    const scope = getPlacesYamlLine(state, context.fence, state.doc.lineAt(context.from).number).scope;
    const renderer = yamlScopeValues(scope, true).get('renderer');

    return renderer && renderer !== 'knap'
      ? getNestedKeyItems(context.fence.language, `content.options.${renderer}`) : items;
  }

  if (context.fence.language !== 'places-image-align' || parentKey !== 'overlays') return items;
  const scope = getPlacesYamlLine(state, context.fence, state.doc.lineAt(context.from).number).scope;
  const entry = Object.fromEntries(yamlScopeValues(scope));

  if (!entry.path && !entry.type && !entry.bounds && !entry.corners) return items;
  const imageKeys = new Set(['path', 'type', 'bounds', 'corners', 'opacity', 'alignment']);

  return isImageOverlayDefinition(entry)
    ? items.filter(item => imageKeys.has(item.label))
    : items.filter(item => !['bounds', 'corners', 'opacity', 'alignment'].includes(item.label));
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

const DISTANCE_WINDOW_ITEMS: SuggestionItem[] = ["100ft", "200m", "0.25mi"].map(value => ({ label: value, apply: value, type: "enum" }));
const METRIC_WINDOW_ITEMS: SuggestionItem[] = [
  ...DISTANCE_WINDOW_ITEMS,
  ...["30s", "5min"].map(value => ({ label: value, apply: value, type: "enum" })),
];

const FORMAT_VALUE_ITEMS: Record<string, SuggestionItem[]> = {
  axisColor: [exampleItem("#3388ff", "Hex color, rgb(), or CSS color")],
  cache: CACHE_VALUE_SUGGESTIONS.map((suggestion) => ({
    label: suggestion.value,
    apply: suggestion.value,
    detail: suggestion.detail,
    type: "enum",
  })),
  bounds: [exampleItem("41.407,-75.663,41.409,-75.661", "Southwest then northeast corner")],
  corners: [exampleItem("41.409,-75.663,41.409,-75.662,41.408,-75.662,41.408,-75.663", "Four corners clockwise from NW (NW, NE, SE, SW)")],
  tiles: [exampleItem("https://api.maptiler.com/tiles/contours-v2/{z}/{x}/{y}.pbf?key=YOUR_KEY", "Vector tile URL with {z}/{x}/{y}")],
  url: [exampleItem("https://tiles.openstreetmap.us/vector/contours-feet.json", "TileJSON endpoint URL")],
  sourceLayer: [exampleItem("contours", "Source layer name inside the tiles")],
  color: [exampleItem("#3388ff", "#RRGGBB")],
  colorScheme: [{
    label: "#ffffcc, #fd8d3c, #e31a1c",
    apply: "#ffffcc, #fd8d3c, #e31a1c",
    detail: "custom gradient colors ordered from low to high intensity",
    type: "text",
  }],
  colors: [exampleItem("#3388ff, #22c55e", "Comma-separated hex colors")],
  coordinates: [exampleItem("Scranton: 41.408, -75.662", "Optional name, then latitude and longitude; separate multiple with ;")],
  options: [exampleItem("small, medium, large", "Comma-separated allowed values for an enum or list parameter")],
  timezone: [exampleItem("America/New_York", "IANA timezone name, or UTC")],
  clusterThreshold: [exampleItem("100", "0 to disable clustering, or a positive threshold")],
  elevationColor: [exampleItem("#3388ff", "Hex color, rgb(), or CSS color")],
  fillOpacity: [exampleItem("0.25", "Decimal from 0 to 1, or percentage")],
  fontSize: [exampleItem("14", "Number in pixels")],
  gradeColor: [exampleItem("#3388ff", "Hex color, rgb(), or CSS color")],
  gradeDistance: [exampleItem("100", "Distance in feet; gradeWindow takes precedence")],
  gradeWindow: METRIC_WINDOW_ITEMS,
  "track.gradeWindow": DISTANCE_WINDOW_ITEMS,
  "track.directionArrows": [
    { label: "0", apply: "0", detail: "Hide arrows", type: "enum" },
    { label: "0.5", apply: "0.5", detail: "Half-size arrows", type: "enum" },
    { label: "1", apply: "1", detail: "Default arrow size", type: "enum" },
    { label: "2", apply: "2", detail: "Double-size arrows", type: "enum" },
  ],
  "labels.visibility": ["all", "none", "start", "midpoint", "end"].map(value => ({ label: value, apply: value, type: "enum" })),
  lineStyle: [
    { label: "solid", apply: "solid", detail: "Continuous line", type: "enum" },
    { label: "dashed", apply: "dashed", detail: "Default dash pattern", type: "enum" },
    { label: '"2,5"', apply: '"2,5"', detail: "Dash 2 line widths, gap 5 line widths", type: "text" },
  ],
  speedWindow: METRIC_WINDOW_ITEMS,
  gridSize: [exampleItem("100m", "Grid cell size in feet/meters")],
  height: [exampleItem("500px", "CSS size such as px, %, vh, or calc()")],
  initialCenter: [exampleItem("41.408,-75.662", "Latitude,longitude")],
  initialZoom: [exampleItem(12, "Zoom level from 0 to 24")],
  labelTemplate: [exampleItem("{this.name}", "Template using {this.property}")],
  iconRotation: [
    exampleItem("45", "A fixed bearing applied to every marker"),
    exampleItem("{this.wind_direction_10m}", "A column holding degrees clockwise from north"),
    exampleItem("{(this.wind_direction_10m + 270) % 360}", "An expression, for glyphs that do not point north at 0"),
  ],
  lineOpacity: [exampleItem("0.8", "Decimal from 0 to 1")],
  lineWidth: [exampleItem("4", "Line width in pixels")],
  location: [
    exampleItem("Scranton: 41.408,-75.662", "Optional name followed by latitude,longitude"),
    exampleItem("{note.Location}", "A frontmatter property of this note"),
  ],
  markerFilter: [
    exampleItem("tag IN {parameter.show}", "Show markers whose field matches any listed value; pairs with a multiselect parameter (tag IN for tags)"),
    exampleItem("tag NOT IN closed, private", "Hide markers whose field matches any listed value"),
    exampleItem("category == restaurant", "Show only markers whose field equals the value"),
    exampleItem("status != closed", "Hide markers whose field equals the value"),
    exampleItem("rating >= 4", "Numeric comparison; also <, >, and <="),
    exampleItem("favorite", "Show only markers where the field is present and truthy"),
    exampleItem("rating >= 4 AND tag IN food", "Combine two conditions with AND or OR"),
  ],
  maxOpacity: [exampleItem("1.0", "Decimal from 0 to 1")],
  maxResults: [exampleItem(100, "Positive integer; omit for all matches")],
  maxSegments: [exampleItem(200, "Positive integer; defaults to 100")],
  minFrequency: [exampleItem("2", "Positive integer")],
  minOpacity: [exampleItem("0.1", "Decimal from 0 to 1")],
  minOverlap: [exampleItem("70", "Percentage or decimal")],
  minSimilarity: [exampleItem("70", "Percentage or decimal")],
  minZoom: [exampleItem(8, "Zoom level from 0 to 24")],
  maxZoom: [exampleItem(12, "Zoom level from 0 to 24")],
  metricLabels: [
    exampleItem("total", "Show only the total route distance and duration label"),
    exampleItem("legs", "Show distance and duration between each stop"),
    exampleItem("both", "Show both total route and per-stop labels"),
    exampleItem("none", "Hide generated route metric labels"),
  ],
  name: [exampleItem("My Overlay")],
  "queryParameters.name": [exampleItem("days", "Required. Referenced as {parameter.name} in the query or any other block setting")],
  "queryParameters.width": [exampleItem("240px", "Fixed lengths size the input; a percentage sizes the complete parameter relative to the control strip. Fixed lengths have no effect on toggle, segmented, and multiselect")],
  "queryParameters.default": [
    { label: "all", apply: "all", detail: "List parameters: start with every option selected, including options an optionsQuery resolves later", type: "enum" },
    exampleItem(7),
  ],
  "places-similar.tolerance": [exampleItem(0.01, "Degrees; defaults to 0.01")],
  "style.radius": [exampleItem(4, "Circle radius in pixels")],
  "hoverStyle.radius": [exampleItem(4, "Circle radius in pixels")],
  circleRadius: [exampleItem(4, "Circle radius in pixels")],
  "overlays.icon": [],
  "style.width": [exampleItem("4", "Line width in pixels")],
  "hoverStyle.width": [exampleItem("4", "Line width in pixels")],
  "style.colors": [exampleItem("#3388ff, #22c55e", "Isochrone contour colors from first to last range; repeat when there are more contours than colors")],
  "hoverStyle.colors": [exampleItem("#3388ff, #22c55e", "Isochrone contour colors from first to last range; repeat when there are more contours than colors")],
  "colorRelief.colors": [exampleItem("viridis", "Elevation tint: a preset (hypsometric, viridis, spectral, grayscale) or a list of <elevation in meters>: <color> stops")],
  opacity: [exampleItem(0.8, "Decimal from 0 to 1")],
  overlapTolerance: [exampleItem(25, "Distance in meters")],
  paceColor: [exampleItem("#3388ff", "Hex color, rgb(), or CSS color")],
  radius: [
    exampleItem("10mi", "Only show places within this distance of the center; a bare number uses the vault's unit system"),
    exampleItem("50 from 41.408, -75.662", "Inline center; otherwise the location setting or the note's frontmatter Location supplies it"),
  ],
  ranges: [
    { label: "[10 min, 30 min, 5 mi]", apply: "[10 min, 30 min, 5 mi]", detail: "Each value includes a time or distance unit; types may be mixed", type: "text" },
  ],
  routeLabelTemplate: [exampleItem("{this.distance_text}", "Template using route properties")],
  legLabelTemplate: [exampleItem("{this.from_name} → {this.to_name}: {this.distance_text} · {this.duration_text}", "Template using leg properties")],
  waypointLabelTemplate: [exampleItem("{this.role_label}: {this.name}", "Template using waypoint properties ({this.name}, {this.role_label}, ...)")],
  selectableLayers: [
    {
      label: "[transportation]",
      apply: "[transportation]",
      detail: "Source-layer name (default)",
      type: "enum",
    },
    {
      label: "[highway-path, highway-minor]",
      apply: "[highway-path, highway-minor]",
      detail: "Rendered layer IDs",
      type: "enum",
    },
  ],
  speedColor: [exampleItem("#3388ff", "Hex color, rgb(), or CSS color")],
  strokeOpacity: [exampleItem("0.85", "Decimal from 0 to 1, or percentage")],
  strokeWidth: [exampleItem("4", "Line width in pixels")],
  tolerance: [exampleItem("25m", "Distance in meters or feet")],
  width: [exampleItem("500px", "CSS size such as px, %, vw, or calc()")],
};

function exampleItem(sample: string | number, detail?: string): SuggestionItem {
  return {
    label: String(sample),
    apply: JSON.stringify(sample),
    detail,
    type: "text",
  };
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

const MANUAL_PLACE_FIELDS = [
  { name: "Location", description: "Required latitude, longitude; optionally Name: latitude, longitude", boost: 10 },
  { name: "Name", description: "Marker name; overrides a name included in Location", boost: 9 },
  { name: "icon", description: "Marker emoji or text glyph", boost: 8 },
  { name: "tags", description: "Comma-separated tags for marker rules", boost: 7 },
  { name: "Overlay Source", description: "Serialized track or overlay geometry for this place" },
  { name: "Overlay Cache", description: "Precomputed GeoJSON for this place" },
];

function getManualPlaceKeyItems(state: EditorState, context: PlacesCompletionContext): SuggestionItem[] {
  const currentLine = state.doc.lineAt(context.from).number;
  const scope = getPlacesYamlLine(state, context.fence, currentLine).scope;
  const used = new Set([...scope.fields]
    .filter(([, field]) => field.line + context.fence.startLine + 1 !== currentLine)
    .map(([key]) => normalizePropertyName(key)));
  const items: SuggestionItem[] = MANUAL_PLACE_FIELDS.map(field => ({
    label: field.name, apply: `${field.name}: `, detail: field.description, boost: field.boost, type: "property",
  }));

  for (const path of PLACE_SETTINGS_PATHS) {
    const parts = path.split(".");
    const key = parts[parts.length - 1];
    const parent = parts[parts.length - 2];
    const detail = parent
      ? CodeBlockRegistry.instance.getNestedKeys("places", parent)?.find(item => item.name === key)?.description
      : describeKey("places", key, key);

    items.push({ label: path, apply: `${path}: `, detail, type: "property" });
  }

  const indexed = context.query.match(/^(popup\.content|iconStyles|iconImageStyles|labelStyles)\.(\d+)(?:\.|$)/iu);

  if (indexed) {
    const root = indexed[1].toLowerCase() === "popup.content" ? "popup.content"
      : [...STYLE_RULE_KEYS].find(key => key.toLowerCase() === indexed[1].toLowerCase())!;
    const paths = root === "popup.content" ? ["renderer", "options", "options.templateFile"].map(key => `${root}.${indexed[2]}.${key}`) : [`${root}.${indexed[2]}`];

    for (const path of paths) items.push({ label: path, apply: `${path}: `, type: "property" });
  }

  const entryText = state.doc.line(context.placeStartLine!).text;
  const keyIndent = " ".repeat(getYamlColumn(entryText, getPlacesYamlLine(state, context.fence, context.placeStartLine!).keyOffset));

  items.push({ label: "popup", apply: reindentMultilineApply("popup:\n  content:\n    - renderer: knap\n      options:\n        templateFile: Places Templates/Popup.knap.md", keyIndent), detail: describeKey("places", "popup", "popup"), type: "property" });
  const usesNestedPopup = used.has("popup");
  const usesFlatPopup = [...used].some(key => key.startsWith("popup."));

  return items.filter(item => {
    const key = normalizePropertyName(item.label);

    if (used.has(key)) return false;
    if (key === "popup") return !usesFlatPopup;
    if (key.startsWith("popup.")) return !usesNestedPopup;

    return true;
  });
}

function getManualPlaceValueItems(services: PlacesCompletionServices, rawKey: string): SuggestionItem[] {
  const normalized = normalizePropertyName(rawKey);
  const key = [...MANUAL_PLACE_FIELDS.map(field => field.name), ...PLACE_SETTINGS_PATHS]
    .find(path => normalizePropertyName(path) === normalized) ?? rawKey;

  if (normalized === "location") {
    const file = services.app.workspace?.getActiveFile?.();
    const frontmatter = file ? services.app.metadataCache?.getFileCache?.(file)?.frontmatter : undefined;
    const values = Object.entries(frontmatter ?? {}).flatMap(([property, value]) => {
      const coordinate = parseNamedCoordinate(value);

      return coordinate ? [exampleItem(`${coordinate.latitude}, ${coordinate.longitude}`, property)] : [];
    });

    return [...values, exampleItem("41.408, -75.662", "Latitude, longitude"), exampleItem("Scranton: 41.408, -75.662", "Name: latitude, longitude")];
  }

  if (normalized === "name") return [exampleItem("Dunder Mifflin Scranton")];

  if (normalized === "icon") {
    const used = vaultIconCounts(services.app);

    if (used.length === 0) return ["📍", "🏠", "🏢", "🥾", "👀", "🍽️", "🅿️", "➤"].map(icon => exampleItem(icon));

    return used.map(([icon]) => exampleItem(icon));
  }

  if (normalized === "tags") return [exampleItem("hiking, viewpoint", "Comma-separated tags")];
  if (/^(iconstyles|labelstyles)(\.\d+)?$/u.test(normalized)) return [exampleItem("=> color: #16a34a", "An unconditional style rule"), exampleItem("rating >= 4 => opacity: 1", "A rule using this place's rating property")];
  if (normalized === "track.style") return [exampleItem("4 solid #16a34a", "Width, pattern, and color"), exampleItem("4 dashed #16a34a 0.9; 8 solid #000000 0.3", "Line style followed by outline style")];
  if (/^popup\.content(?:\.\d+)?$/u.test(normalized)) return [exampleItem("none", "Hide the popup body")];
  if (/^popup\.content(?:\.\d+)?\.renderer$/u.test(normalized)) return getKnownValueItems("places", "renderer", "renderer");
  if (/^popup\.content(?:\.\d+)?\.options\.templatefile$/u.test(normalized)) return getVaultFileItems(services, "templateFile");
  if (key === "track.labels.visibility") return FORMAT_VALUE_ITEMS["labels.visibility"];
  if (/^track\.labels\.(start|midpoint|end)$/u.test(key)) return [exampleItem("{this.name}", "Use this place's name")];
  if (/(MinZoom|MaxZoom)$/u.test(key)) return [exampleItem("12", "Zoom from 0 to 24")];
  if (key === "labelTemplate" || key === "iconRotation") return FORMAT_VALUE_ITEMS[key];

  if (key === "track.colorBy" || key === "track.defaultVisibility" || key === "track.outline") {
    const leaf = key.slice("track.".length);

    return getKnownValueItems("places", leaf, leaf);
  }

  return [];
}

function addItems(target: SuggestionItem[], seen: Set<string>, items: SuggestionItem[]): void {
  for (const item of items) {
    const key = item.type === "enum" ? item.apply.toLowerCase() : item.apply;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    target.push(item);
  }
}

function describeKey(blockType: string, key: string, canonicalKey: string): string | undefined {
  const registry = CodeBlockRegistry.instance;
  const definition = registry.getDefinition(blockType);
  const parameter = definition?.parameters.find((item) => item.name === key || item.name === canonicalKey);

  if (parameter) return parameter.description;

  return registry.findNestedKeyDescription(blockType, key)
    ?? registry.findNestedKeyDescription(blockType, canonicalKey)
    ?? GENERIC_KEY_DESCRIPTIONS[canonicalKey];
}

function describeValue(blockType: string, key: string, canonicalKey: string, value: string, parentKey?: string | null): string | undefined {
  const registry = CodeBlockRegistry.instance;

  return registry.getValueDetailForBlock(blockType, `${parentKey}.${canonicalKey}`, value)
    ?? registry.getValueDetailForBlock(blockType, key, value)
    ?? registry.getValueDetailForBlock(blockType, canonicalKey, value)
    ?? valueDetail(canonicalKey, value)
    ?? valueDetail(key, value)
    ?? registry.getProvidedValueDescription(canonicalKey, value)
    ?? registry.getProvidedValueDescription(key, value);
}

function getKnownValueItems(blockType: string, key: string, canonicalKey: string, parentKey?: string): SuggestionItem[] {
  if (canonicalKey === "style" || canonicalKey === "cache") {
    return [];
  }

  const registry = CodeBlockRegistry.instance;
  const blockValues = registry.getKnownValuesForBlock(blockType, key)
    ?? registry.getKnownValuesForBlock(blockType, canonicalKey);

  if (!blockValues || blockValues.size === 0) {
    return [];
  }

  return Array.from(blockValues)
    .sort((left, right) => left.localeCompare(right))
    .map((value) => ({
      label: value,
      apply: value,
      detail: describeValue(blockType, key, canonicalKey, value, parentKey),
      type: "enum",
    }));
}

function vaultIconCounts(app: App): Array<[icon: string, notes: number]> {
  const counts = new Map<string, number>();

  for (const file of app.vault.getMarkdownFiles?.() ?? []) {
    const icon = readNormalizedProperty(app.metadataCache?.getFileCache?.(file)?.frontmatter, 'icon');

    if (typeof icon !== 'string' || icon.trim() === '') continue;
    counts.set(icon.trim(), (counts.get(icon.trim()) ?? 0) + 1);
  }

  return [...counts].sort(([left, leftNotes], [right, rightNotes]) => rightNotes - leftNotes || left.localeCompare(right));
}

function getDefinitionValueItems(blockType: string, key: string, canonicalKey: string, parentKey: string | null): SuggestionItem[] {
  const scopedItems = FORMAT_VALUE_ITEMS[`${parentKey}.${canonicalKey}`]
    ?? FORMAT_VALUE_ITEMS[`${blockType}.${canonicalKey}`];

  if (scopedItems) return scopedItems;
  const registry = CodeBlockRegistry.instance;
  const parameter = registry.getDefinition(blockType)?.parameters.find(item => item.name === key || item.name === canonicalKey);
  const values = parameter ? parameterValueOptions(parameter.values) : [];

  if (!values.length) return FORMAT_VALUE_ITEMS[canonicalKey] ?? [];

  return values.map(value => ({
    label: value,
    apply: value,
    detail: describeValue(blockType, key, canonicalKey, value, parentKey),
    type: 'enum',
  }));
}

// The TileJSON URL a vector tile overlay entry points at, if it declares one.
function getEntryTileJsonUrl(entry: Map<string, string>): string | undefined {
  return entry.get("url") ?? entry.get("tileJson") ?? entry.get("tilejson");
}

function getTileJsonItems(state: EditorState, fence: PlacesFence, currentLine: number, canonicalKey: string): { items: SuggestionItem[]; authoritative: boolean } {
  if (canonicalKey !== "sourceLayer" && canonicalKey !== "sourceLayers" && canonicalKey !== "filter") {
    return { items: [], authoritative: false };
  }

  const entry = yamlScopeValues(getPlacesYamlLine(state, fence, currentLine).scope);
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
    return {
      authoritative: false,
      items: index.isLoading(url)
        ? [{ label: "Loading source layers...", apply: "", detail: url, type: "text" }]
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

function getVaultFileItems(services: PlacesCompletionServices, key: string, parentKey?: string | null): SuggestionItem[] {
  if (key === 'track' || key === 'track1' || key === 'track2') return trackFileSuggestions(services.app.vault.getFiles());
  if (key === 'fromTemplate') return noteFileSuggestions(services.app.vault.getFiles());

  if (key === 'templateFile') return services.app.vault.getFiles()
    .filter(file => file.path.endsWith('.knap.md'))
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(file => exampleItem(file.path));

  if (key !== 'overlays' && !(key === 'path' && parentKey === 'overlays')) return [];

  return services.app.vault.getFiles()
    .filter(file => OVERLAY_FILE_EXTENSIONS.has(file.extension.toLowerCase()))
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(file => {
      const isImage = IMAGE_FILE_EXTENSIONS.has(file.extension.toLowerCase());
      const path = JSON.stringify(file.path);

      return {
        label: file.path,
        apply: key === 'path' ? path : `- path: ${path}${isImage ? '\n  bounds: ' : ''}`,
        type: 'text',
      };
    });
}

function trackFileSuggestions(files: TFile[]): SuggestionItem[] {
  return files
    .filter((file) => TRACK_FILE_EXTENSIONS.has(file.extension.toLowerCase()))
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => ({
      label: file.path,
      apply: file.extension.toLowerCase() === "md"
        ? `[[${file.path.replace(/\.md$/iu, "")}]]`
        : JSON.stringify(file.path),
      type: "text",
    }));
}

function noteFileSuggestions(files: TFile[]): SuggestionItem[] {
  return files
    .filter((file) => file.extension.toLowerCase() === "md")
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => ({
      label: file.path,
      apply: `[[${file.path.replace(/\.md$/iu, "")}]]`,
      type: "text",
    }));
}

const COORDINATE_ITEM = exampleItem("Scranton: 41.408, -75.662", "Optional name, then latitude and longitude");

function getCurrentNoteCoordinateItems(services: PlacesCompletionServices): SuggestionItem[] {
  const file = services.app.workspace?.getActiveFile?.();
  const frontmatter = file
    ? services.app.metadataCache?.getFileCache?.(file)?.frontmatter
    : undefined;

  if (!frontmatter) {
    return [
      { label: "{this.location}", apply: "{this.location}", detail: "Current note Location property", type: "text" },
      { label: "{this}", apply: "{this}", detail: "Current note location (shorthand)", type: "text" },
    ];
  }

  const items = Object.entries(frontmatter)
    .filter(([property, value]) => property !== "position" && parseNamedCoordinate(value) !== null)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([property, value]) => ({
      label: `{this.${property}}`,
      apply: `{this.${property}}`,
      detail: `Current note: ${String(value)}`,
      type: "text",
    }));
  const location = items.find(item => item.label.replace(/[\s_-]+/gu, "").toLowerCase() === "{this.location}");

  if (location) {
    items.splice(items.indexOf(location) + 1, 0, {
      label: "{this}",
      apply: "{this}",
      detail: `Shorthand for ${location.label}`,
      type: "text",
    });
  }

  return items;
}

const VAULT_REFERENCE_LIST_KEYS: Record<string, "track" | "note" | "template"> = {
  places: "track",
  fromTemplate: "template",
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

  if (kind === "track") return trackFileSuggestions(files);
  if (kind === "template") return noteFileSuggestions(files);

  return [...getCurrentNoteCoordinateItems(services), COORDINATE_ITEM, ...noteFileSuggestions(files)];
}

function getContextualValueItems(state: EditorState, fence: PlacesFence, currentLine: number, key: string, canonicalKey: string): SuggestionItem[] {
  const registry = CodeBlockRegistry.instance;
  const contextPairs = yamlScopeValues(getPlacesYamlLine(state, fence, currentLine).scope, true);

  for (const [contextKey, contextValue] of contextPairs) {
    const values = registry.getContextualKnownValuesForBlock(fence.language, key, contextKey, contextValue.toLowerCase())
      ?? registry.getContextualKnownValuesForBlock(fence.language, canonicalKey, contextKey, contextValue.toLowerCase());

    if (!values || values.size === 0) {
      continue;
    }

    return Array.from(values)
      .sort((left, right) => left.localeCompare(right))
      .map((value) => {
        const detail = registry.getValueDetailForBlock(fence.language, canonicalKey, value) ?? valueDetail(canonicalKey, value);

        return { label: value, apply: value, ...(detail ? { detail } : {}), type: "enum" };
      });
  }

  return [];
}

function getMapProviderForFence(services: PlacesCompletionServices, state: EditorState, fence: PlacesFence, currentLine: number): string | null {
  let scope = getPlacesYamlLine(state, fence, currentLine).scope;

  while (scope.parent) scope = scope.parent;
  const contextPairs = yamlScopeValues(scope);

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
  const scope = getPlacesYamlLine(state, fence, currentLine).scope;

  if (scope.path.endsWith('content.options')) {
    const renderer = yamlScopeValues(scope, true).get('renderer');
    const optionKey = `content.options.${renderer}.${canonicalKey}`;
    const declared = getKnownValueItems(fence.language, optionKey, optionKey);

    if (declared.length) return declared;
  }

  const parentKey = getPlacesYamlLine(state, fence, currentLine).scope.path.split(".").slice(-1)[0] ?? "";

  if (canonicalKey === "style" && parentKey === "track") return getManualPlaceValueItems(services, "track.style");
  const items: SuggestionItem[] = [];
  const seen = new Set<string>();
  const fenceProvider = canonicalKey === "style"
    ? getMapProviderForFence(services, state, fence, currentLine)?.toLowerCase() ?? null
    : null;

  addItems(items, seen, getContextualValueItems(state, fence, currentLine, key, canonicalKey));

  if (canonicalKey !== "style" || !fenceProvider) {
    addItems(items, seen, getKnownValueItems(fence.language, key, canonicalKey, parentKey));
  }

  if (canonicalKey === "mapProvider") {
    addItems(items, seen, toProviderItems(services.getMapProviders(), services.resolveMapProvider()));
  }

  if (canonicalKey === "routeProvider" || canonicalKey === "provider") {
    const underTerrain = canonicalKey === "provider"
      && parentKey === "terrain";
    const isSnapFence = fence.language === "places-snap";
    const isElevationFence = fence.language === "places-elevation";
    const providers = underTerrain
      ? services.getTerrainProviders()
      : isElevationFence
        ? services.getElevationProviders()
        : isSnapFence
          ? services.getSnapProviders()
          : services.getRouteProviders();
    const routeDefault = getMapProviderForFence(services, state, fence, currentLine)?.toLowerCase();
    const defaultProvider = underTerrain
      ? undefined
      : !isElevationFence && !isSnapFence && routeDefault && providers.includes(routeDefault)
        ? routeDefault
        : providers[0];

    addItems(items, seen, toProviderItems(providers, defaultProvider));
  }

  if (canonicalKey === "matchProvider") {
    addItems(items, seen, toProviderItems(services.getTrackMatchProviders(), "valhalla"));
  }

  if (canonicalKey === "style") {
    const providerNames = fenceProvider
      ? [fenceProvider]
      : services.getStyleProviders().sort((left, right) => left.localeCompare(right));
    const styles = providerNames.flatMap(provider => services.getStylesForProvider(provider));
    const mixedKinds = new Set(styles.map(style => style.kind)).size > 1;

    for (const providerName of providerNames) {
      addItems(items, seen, services.getStylesForProvider(providerName)
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((style) => {
          const detail = [providerNames.length > 1 ? providerName : undefined, mixedKinds ? style.kind : undefined].filter(Boolean).join(" ");

          return {
            label: style.id,
            apply: style.id,
            ...(detail ? { detail } : {}),
            type: "enum",
          };
        }));
    }
  }

  const tileJson = getTileJsonItems(state, fence, currentLine, canonicalKey);

  addItems(items, seen, tileJson.items);

  const overlayParentKey = canonicalKey === "path"
    ? parentKey
    : null;

  addItems(items, seen, getVaultFileItems(services, canonicalKey, overlayParentKey));

  if (!tileJson.authoritative && canonicalKey !== "templateFile") {
    addItems(items, seen, getDefinitionValueItems(fence.language, key, canonicalKey, parentKey));
  }

  if (canonicalKey === "type") {
    const inQueryParameters = parentKey === "queryParameters";

    return items.filter((item) => item.type !== "enum" || QUERY_PARAMETER_TYPE_VALUES.has(item.label) === inQueryParameters);
  }

  if (canonicalKey === "visibility"
    && parentKey === "labels") {
    return items.filter(item => item.label !== "mid" && item.label !== "middle");
  }

  return items;
}

const QUERY_PARAMETER_TYPE_VALUES = new Set(["int", "float", "string", "date", "datetime", "time", "boolean", "enum", "list", "location"]);

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

function isMultiValueKey(blockType: string, key: string): boolean {
  const canonicalKey = KEY_ALIASES[key] ?? key;

  if (MULTI_VALUE_KEYS.has(canonicalKey)) {
    return true;
  }

  const definition = CodeBlockRegistry.instance.getDefinition(blockType);
  const parameter = definition?.parameters.find((item) => item.name === key || item.name === canonicalKey);

  return parameter?.multiValue ?? CodeBlockRegistry.instance.getMultiValueKeysForBlock(blockType).has(canonicalKey);
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

function nestedKeyForPath(blockType: string, path: string): string | undefined {
  const registry = CodeBlockRegistry.instance;

  if (path.endsWith('content.options') && registry.hasNestedKeys(blockType, 'content.options')) return 'content.options';
  if (registry.hasNestedKeys(blockType, path)) return path;
  const leaf = path.split('.').slice(-1)[0];

  return registry.hasNestedKeys(blockType, leaf) ? leaf : undefined;
}

export function getCompletionContext(state: EditorState, pos: number): PlacesCompletionContext | null {
  const fence = getPlacesFenceAtPos(state, pos);

  if (!fence) return null;
  const docLine = state.doc.lineAt(pos);
  const structure = getPlacesYamlLine(state, fence, docLine.number);

  if (!structure || structure.literal || docLine.text.trimStart().startsWith('#')) return null;
  const { scope, key, keyOffset, dash } = structure;
  const line = docLine.text;
  const cursorCh = pos - docLine.from;
  const beforeCursor = line.slice(0, cursorCh);
  const colon = structure.colon;
  const isValue = colon >= 0 && cursorCh > colon;
  const isMapBlock = fence.language === 'places' || fence.language === 'places-template';
  const parentKey = scope.path.split('.').slice(-1)[0] ?? '';
  const path = scope.path ? `${scope.path}.${key}` : key ?? '';

  if (scope.path === 'places') {
    if (!isMapBlock) return null;

    if (/^(\s*(?:-\s+)?)([A-Za-z][\w. -]*)?(?::(.*))?$/u.test(line)) {
      const start = isValue ? getTriggerStartForSegment(line, colon + 1, cursorCh) : keyOffset;

      if (cursorCh < start) return null;

      return {
        mode: isValue ? 'placeValue' : 'placeKey', fence,
        placeStartLine: scope.entryLine === undefined ? docLine.number : fence.startLine + 1 + scope.entryLine,
        from: docLine.from + start,
        to: !isValue && colon >= 0 ? docLine.from + skipWhitespace(line, colon + 1) : pos,
        query: beforeCursor.slice(start).trim(), key,
      };
    }
  }

  if (dash && !isValue) {
    if (cursorCh < keyOffset) return null;
    const registry = CodeBlockRegistry.instance;
    const listParentKey = registry.hasListItemTemplates(fence.language, scope.path) || registry.hasNestedKeys(fence.language, scope.path)
      ? scope.path : parentKey;

    if (!registry.hasListItemTemplates(fence.language, listParentKey) && !nestedKeyForPath(fence.language, scope.path) && !VAULT_REFERENCE_LIST_KEYS[parentKey]) return null;

    return { mode: 'listItem', fence, from: docLine.from + keyOffset, to: pos, query: beforeCursor.slice(keyOffset).trim(), listParentKey };
  }

  if (!isValue) {
    if (!/^\s*[A-Za-z][\w.-]*(?:\s*:.*)?$/u.test(line) && line.trim()) return null;
    const query = beforeCursor.slice(keyOffset).trim();
    const previous = !query && !line.trim() ? getPreviousNestedBlock(state, fence, docLine.number) : null;
    const nestedBlockKey = nestedKeyForPath(fence.language, scope.path) ?? previous?.key;

    if (!nestedBlockKey && (!query || scope.path)) return null;

    return {
      mode: nestedBlockKey ? 'nestedKey' : 'key', fence, from: docLine.from + keyOffset,
      to: colon < 0 ? pos : docLine.from + skipWhitespace(line, colon + 1), query, nestedBlockKey,
      applyPrefix: previous && structure.indent <= getYamlColumn(previous.indent) ? `${previous.indent}  ` : undefined,
    };
  }

  if (isMapBlock && path === 'places' && !beforeCursor.slice(colon + 1).trim()) {
    return { mode: 'listItem', fence, from: pos, to: pos, query: '', listParentKey: 'places', applyPrefix: '\n  - ' };
  }

  const nestedBlockKey = nestedKeyForPath(fence.language, path);

  if (key !== 'overlays' && path !== 'style' && path !== 'track.style' && nestedBlockKey && !beforeCursor.slice(colon + 1).trim()) {
    return { mode: 'nestedKey', fence, from: pos, to: pos, query: '', nestedBlockKey, applyPrefix: `\n${' '.repeat(getYamlColumn(line, keyOffset) + 2)}` };
  }

  const segmentStart = getValueSegmentStart(line, colon + 1, fence.language, key!, cursorCh);
  const start = getTriggerStartForSegment(line, segmentStart, cursorCh);

  if (start > cursorCh) return null;
  const query = beforeCursor.slice(start).trim();

  if (!query && beforeCursor.slice(-1) !== '.' && QUIET_EMPTY_VALUE_KEYS.has(KEY_ALIASES[key!] ?? key!)) return null;

  return { mode: 'value', fence, from: docLine.from + start, to: pos, query, key };
}

export function getCompletionItems(services: PlacesCompletionServices, state: EditorState, context: PlacesCompletionContext): SuggestionItem[] {
  if (context.fence.language.endsWith('-vaultquery')) {
    return [];
  }

  if (context.mode === "placeKey") {
    const items = getManualPlaceKeyItems(state, context);

    return state.doc.lineAt(context.from).number === context.placeStartLine && !state.doc.lineAt(context.from).text.includes(':')
      ? [...items, ...getVaultReferenceListItems(services, 'places')] : items;
  }

  if (context.mode === "placeValue" && context.key) return getManualPlaceValueItems(services, context.key);

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
    if (context.listParentKey === 'places') {
      return withApplyPrefix([
        ...getManualPlaceKeyItems(state, { ...context, placeStartLine: state.doc.lineAt(context.from).number }),
        ...getVaultReferenceListItems(services, 'places'),
      ]);
    }

    if (VAULT_REFERENCE_LIST_KEYS[context.listParentKey]) {
      return withApplyPrefix(getVaultReferenceListItems(services, context.listParentKey));
    }

    const templates = getListItemTemplateItems(context.fence.language, context.listParentKey);

    if (templates.length > 0) {
      const dashLine = state.doc.lineAt(context.from);
      const dashIndent = " ".repeat(getYamlColumn(dashLine.text));

      return withApplyPrefix(templates.map(item => ({
        ...item,
        apply: reindentMultilineApply(item.apply, dashIndent),
      })));
    }

    const dashLine = state.doc.lineAt(context.from);
    const dashIndent = getYamlColumn(dashLine.text);
    const previousEntryKeys = getPlacesYamlLine(state, context.fence, dashLine.number).scope.previousEntry?.fields;
    const entryIndent = " ".repeat(dashIndent + 2);

    return withApplyPrefix(getContextualNestedKeyItems(state, context, context.listParentKey).map((item) => {
      if (context.fence.language === 'places-image-align' || !previousEntryKeys || previousEntryKeys.has(item.label)) {
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

    return withApplyPrefix(getContextualNestedKeyItems(state, context, context.nestedBlockKey).map((item) => ({
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
    apply: replaceLineWith === undefined && !item.apply.startsWith('"')
      ? item.apply
      : (view, _completion, from, to) => {
        const line = view.state.doc.lineAt(from);

        if (replaceLineWith === undefined) {
          const quote = view.state.doc.sliceString(from - 1, from);

          if (quote === '"' || quote === "'") {
            from--;
            if (view.state.doc.sliceString(to, to + 1) === quote) to++;
          }
        }

        const start = replaceLineWith === undefined ? from : line.from;
        const insert = replaceLineWith ?? item.apply;

        view.dispatch({
          changes: { from: start, to, insert },
          selection: { anchor: start + insert.length },
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
    const placesContext = getCompletionContext(context.state, context.pos);

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

function shouldStartCompletionAfterUpdate(update: ViewUpdate): boolean {
  if (!update.docChanged || completionStatus(update.state) !== null) {
    return false;
  }

  const selection = update.state.selection;

  if (selection.ranges.length !== 1 || !selection.main.empty) {
    return false;
  }

  const context = getCompletionContext(update.state, selection.main.head);

  if (context && isIndentOnlyEmptyKeyContext(update.state, selection.main.head, context)) {
    return false;
  }

  return Boolean(context && context.query === "" && (context.mode === "nestedKey" || context.mode === "value" || context.mode === "listItem" || context.mode === "placeKey" || context.mode === "placeValue"));
}

function placesCompletionStarter(): Extension {
  return ViewPlugin.fromClass(class {
    private pendingStart: number | null = null;

    update(update: ViewUpdate): void {
      if (!shouldStartCompletionAfterUpdate(update)) {
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
    Prec.lowest(placesCompletionStarter()),
    tileJsonCompletionRefresher(),
  ];
}
