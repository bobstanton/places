import { CACHE_PARAMETER_DESCRIPTION, CACHE_PARAMETER_VALUES, COMMON_SIZE_PARAMS, COMMON_SIZE_KEYS, QUERY_PARAMETER_NESTED_KEYS } from "places-shared/settings";

// Nested `cache:` under a directions/isochrones group - same grammar as every block-level `cache:`.
const NESTED_CACHE_DESCRIPTION = `Route overlay cache for this group. ${CACHE_PARAMETER_DESCRIPTION}`;
import { CodeBlockDefinition, CodeBlockHighlightConfig, ParameterDefinition, NestedKeyDefinition, ListItemTemplate } from "places-shared/services";

// Aggregates definitions from the main plugin and all subplugins.
export class CodeBlockRegistry {
  private static _instance: CodeBlockRegistry;
  private definitions: CodeBlockDefinition[] = [];
  private highlightConfigs: Map<string, CodeBlockHighlightConfig> = new Map();
  private knownValues: Map<string, Set<string>> = new Map();
  private providedValues: Map<string, Set<string>> = new Map();
  // validKeys unioned with every nested sub-key, derived once per registration.
  // The highlighter validates keys lexically and calls this for every key-bearing
  // line on every re-highlight, and must not rebuild a Set per call.
  private validKeysByBlockType: Map<string, Set<string>> = new Map();

  static get instance(): CodeBlockRegistry {
    if (!CodeBlockRegistry._instance) {
      CodeBlockRegistry._instance = new CodeBlockRegistry();
    }
    return CodeBlockRegistry._instance;
  }

  registerDefinitions(defs: CodeBlockDefinition[]): void {
    this.definitions.push(...defs);
  }

  registerHighlightConfigs(configs: CodeBlockHighlightConfig[]): void {
    for (const incoming of configs) {
      const existing = this.highlightConfigs.get(incoming.blockType);
      const inherited = incoming.extendsBlockType
        ? this.highlightConfigs.get(incoming.extendsBlockType)
        : undefined;
      const inheritedConfig = inherited
        ? { ...mergeHighlightConfig(inherited, incoming), blockType: incoming.blockType }
        : incoming;
      const config = existing ? mergeHighlightConfig(existing, inheritedConfig) : inheritedConfig;
      this.highlightConfigs.set(config.blockType, config);
      this.highlightConfigs.set(`${config.blockType}-help`, config);

      const validKeys = new Set(config.validKeys);
      for (const definitions of Object.values(config.nestedKeys ?? {})) {
        for (const definition of definitions) {
          validKeys.add(definition.name);
        }
      }
      this.validKeysByBlockType.set(config.blockType, validKeys);
      this.validKeysByBlockType.set(`${config.blockType}-help`, validKeys);

      if (config.knownValues) {
        for (const [key, values] of Object.entries(config.knownValues)) {
          if (!this.knownValues.has(key)) {
            this.knownValues.set(key, new Set());
          }
          values.forEach(v => this.knownValues.get(key)!.add(v));
        }
      }
    }
  }

  getAllDefinitions(): CodeBlockDefinition[] {
    return this.definitions;
  }

  getDefinition(blockType: string): CodeBlockDefinition | undefined {
    const directMatch = this.definitions.find((definition) => definition.type === blockType);
    if (directMatch) {
      return directMatch;
    }

    if (blockType.endsWith("-help")) {
      const baseBlockType = blockType.slice(0, -"-help".length);
      return this.definitions.find((definition) => definition.type === baseBlockType);
    }

    return undefined;
  }

  // Every key the highlighter accepts anywhere in the block: declared validKeys
  // plus all nested sub-keys, since key validation is lexical (no YAML-path
  // awareness). Root-level narrowing goes through getRootKeys, which reads the
  // raw lists, and sub-keys never leak into top-level validation or completion.
  getValidKeys(blockType: string): ReadonlySet<string> | undefined {
    return this.validKeysByBlockType.get(blockType);
  }

  // Top-level keys for root completion; falls back to the full validKeys union when a block declares no rootKeys.
  getRootKeys(blockType: string): Set<string> | undefined {
    const config = this.highlightConfigs.get(blockType);
    if (!config) return undefined;
    return new Set(config.rootKeys ?? config.validKeys);
  }

  getAllBlockTypes(): string[] {
    return Array.from(this.highlightConfigs.keys());
  }

  // Values a provider supplies at run time. Map styles cannot be listed here:
  // each provider owns its own set, and a new provider must not require an edit
  // to the host. Replaces the previous set for the key, so a provider that
  // unloads takes its values with it.
  setProvidedValues(key: string, values: Iterable<string>): void {
    this.providedValues.set(key, new Set([...values].map(value => value.toLowerCase())));
  }

  private mergeProvided(key: string, declared: string[] | undefined): Set<string> | undefined {
    const provided = this.providedValues.get(key);
    if (!declared && !provided) return undefined;
    return new Set([...(declared ?? []), ...(provided ?? [])]);
  }

  getKnownValues(key: string): Set<string> | undefined {
    return this.mergeProvided(key, this.knownValues.get(key) ? [...this.knownValues.get(key)!] : undefined);
  }

  getKnownValuesForBlock(blockType: string, key: string): Set<string> | undefined {
    const config = this.highlightConfigs.get(blockType);
    return this.mergeProvided(key, config?.knownValues?.[key]);
  }

  getMultiValueKeysForBlock(blockType: string): Set<string> {
    const config = this.highlightConfigs.get(blockType);
    return new Set(config?.multiValueKeys ?? []);
  }

  getContextualKnownValuesForBlock(blockType: string, key: string, contextKey: string, contextValue: string): Set<string> | undefined {
    const config = this.highlightConfigs.get(blockType);
    const contextual = config?.contextualKnownValues?.find((entry) =>
      entry.key === key && entry.dependsOn === contextKey,
    );
    const values = contextual?.valuesByContext[contextValue];
    return values ? new Set(values) : undefined;
  }

  getNestedKeys(blockType: string, parentKey: string): NestedKeyDefinition[] | undefined {
    return this.highlightConfigs.get(blockType)?.nestedKeys?.[parentKey];
  }

  hasNestedKeys(blockType: string, parentKey: string): boolean {
    return Boolean(this.getNestedKeys(blockType, parentKey)?.length);
  }

  // The description of a sub-key regardless of which parent declares it.
  // Nested-only keys (colorBy, outline, details, ...) have no top-level
  // ParameterDefinition, and this is the only place their prose lives.
  findNestedKeyDescription(blockType: string, key: string): string | undefined {
    const nestedKeys = this.highlightConfigs.get(blockType)?.nestedKeys;
    if (!nestedKeys) return undefined;

    for (const definitions of Object.values(nestedKeys)) {
      const match = definitions.find(definition => definition.name === key);
      if (match?.description) return match.description;
    }
    return undefined;
  }

  getListItemTemplates(blockType: string, parentKey: string): ListItemTemplate[] | undefined {
    return this.highlightConfigs.get(blockType)?.listItemTemplates?.[parentKey];
  }

  hasListItemTemplates(blockType: string, parentKey: string): boolean {
    return Boolean(this.getListItemTemplates(blockType, parentKey)?.length);
  }

  // Keys whose child lines get an extra indent step on Enter (schema-declared structural parents).
  hasChildBlockKeys(blockType: string, key: string): boolean {
    return this.hasNestedKeys(blockType, key) || this.hasListItemTemplates(blockType, key);
  }

  hasBlockType(blockType: string): boolean {
    return this.highlightConfigs.has(blockType);
  }

  clear(): void {
    this.definitions = [];
    this.highlightConfigs.clear();
    this.knownValues.clear();
    this.validKeysByBlockType.clear();
  }
}

function mergeHighlightConfig(existing: CodeBlockHighlightConfig, incoming: CodeBlockHighlightConfig): CodeBlockHighlightConfig {
  const mergeNested = <T extends { name?: string; label?: string }>(left: readonly T[] = [], right: readonly T[] = []): T[] => {
    const merged = new Map<string, T>();
    for (const item of [...left, ...right]) merged.set(item.name ?? item.label ?? JSON.stringify(item), item);
    return [...merged.values()];
  };
  const nestedKeys: Record<string, NestedKeyDefinition[]> = { ...(existing.nestedKeys ?? {}) };
  for (const [parent, definitions] of Object.entries(incoming.nestedKeys ?? {})) {
    nestedKeys[parent] = mergeNested(nestedKeys[parent], definitions);
  }
  const listItemTemplates: Record<string, ListItemTemplate[]> = { ...(existing.listItemTemplates ?? {}) };
  for (const [parent, templates] of Object.entries(incoming.listItemTemplates ?? {})) {
    listItemTemplates[parent] = mergeNested(listItemTemplates[parent], templates);
  }
  const knownValues: Record<string, string[]> = { ...(existing.knownValues ?? {}) };
  for (const [key, values] of Object.entries(incoming.knownValues ?? {})) {
    knownValues[key] = [...new Set([...(knownValues[key] ?? []), ...values])];
  }
  return {
    ...existing,
    validKeys: [...new Set([...existing.validKeys, ...incoming.validKeys])],
    rootKeys: [...new Set([...(existing.rootKeys ?? existing.validKeys), ...(incoming.rootKeys ?? [])])],
    knownValues,
    multiValueKeys: [...new Set([...(existing.multiValueKeys ?? []), ...(incoming.multiValueKeys ?? [])])],
    contextualKnownValues: [...(existing.contextualKnownValues ?? []), ...(incoming.contextualKnownValues ?? [])],
    nestedKeys,
    listItemTemplates,
  };
}

// For use by PlacesHighlightExtension.
export const COMMON_KEYS = COMMON_SIZE_KEYS;

const COMMON_MAP_PARAMS: ParameterDefinition[] = [
  { name: "mapProvider", values: "(first available provider)" },
  { name: "style", description: "Map style variant", values: "streets, satellite, terrain, outdoors (varies by provider)" },
  { name: "initialZoom", description: "Initial map zoom level", values: "auto, 10, 14, 18" },
  { name: "initialCenter", description: "Initial map center as lat,lng", values: "41.408, -75.662" },
  { name: "minZoom", description: "Minimum map zoom level", values: "0, 3, 5" }
];

const COMMON_QUERY_PARAMS: ParameterDefinition[] = [
  { name: "dataview", description: "Dataview DQL query", values: "FROM \"folder\" WHERE location" },
  { name: "query", description: "VaultQuery SQL query", values: "SELECT n.path FROM notes n..." },
  { name: "linkedPlaces", description: "Additional place notes to append", values: "[[Place A]], [[Place B]]" }
];

export const MAP_KEYS = ['mapProvider', 'style', 'initialZoom', 'initialCenter', 'minZoom'];
export const QUERY_KEYS_HIGHLIGHT = ['query', 'dataview'];

const OVERLAY_KEYS = ['overlays'];
// Overlay-entry sub-keys (nested under an overlays list item), not root keys.
const STRUCTURED_OVERLAY_KEYS = ['path', 'bounds', 'corners', 'tiles', 'url', 'tileJson', 'sourceLayer', 'sourceLayers', 'type', 'layerType', 'style', 'hoverStyle', 'attribution', 'filter', 'textField', 'symbolPlacement', 'sprite', 'icon', 'visible'];

// Keys valid at the TOP LEVEL of a places block. Drives root key completion.
// Mirrors the accepted config/data keys (MapConfigResolver CONFIG_KEYS plus the
// overlays/query-parameter/track-builder/data-source keys parsed separately).
// Nested-only sub-keys (mode, optimize, waypoints, path, centers, ...) are NOT
// here - they live in PLACES_NESTED_KEYS and complete only under their parent.
const PLACES_ROOT_KEYS = [
  ...COMMON_KEYS, ...MAP_KEYS, ...QUERY_KEYS_HIGHLIGHT,
  'linkedPlaces', 'radius', 'location', 'embeddedPlaces',
  'showLabels', 'labelTemplate', 'iconRotation', 'markerRenderer', 'legend',
  'clusterThreshold', 'clusterGeoJsonOverlays',
  ...OVERLAY_KEYS,
  'css', 'iconStyles', 'labelStyles', 'markerFilter',
  'routeProvider', 'directions', 'isochrones',
  'routeLabelTemplate', 'metricLabels', 'legLabelTemplate',
  'waypointLabelTemplate',
  'queryParameters', 'queryParametersPosition', 'queryParametersLayout', 'queryParametersCollapsed', 'track', 'selection',
  'tools',
  'poiDiscovery', 'pitch', 'terrain', 'showHelpWithEmptyMap', 'debug',
  'fromTemplate',
];

// Sub-keys completable on lines nested under structural parent keys. Field
// lists mirror what OverlayService actually reads per entry kind; the unified
// `overlays` key offers the union because entry kind is inferred.
const OVERLAY_ZOOM_NESTED_KEYS: NestedKeyDefinition[] = [
  { name: "minZoom", description: "Minimum map zoom where this overlay is visible" },
  { name: "maxZoom", description: "Maximum map zoom where this overlay is visible" },
];

const OVERLAY_STYLE_NESTED_KEYS: NestedKeyDefinition[] = [
  { name: "color", description: "Line, circle, or fallback fill color" },
  { name: "opacity", description: "Line, circle, text, or icon opacity" },
  { name: "width", description: "Line width in pixels" },
  { name: "dashArray", description: "Line dash and gap lengths, e.g. 2,2" },
  { name: "fillColor", description: "Polygon or circle fill color" },
  { name: "fillOpacity", description: "Polygon fill opacity, 0-1" },
  { name: "circleRadius", description: "Circle radius in pixels" },
  { name: "strokeColor", description: "Polygon outline or circle stroke color" },
  { name: "strokeWidth", description: "Polygon outline or circle stroke width" },
  { name: "strokeOpacity", description: "Polygon outline or circle stroke opacity" },
  { name: "textSize" },
  { name: "textColor" },
  { name: "textHaloColor" },
  { name: "textHaloWidth" },
  { name: "iconSize", description: "Symbol icon scale" },
];

// The completion offered under any `style:`/`hoverStyle:` node. Union of the file/vector-tile
// overlay style fields plus the isochrone-only `colors` list: directions/isochrones/overlay
// style all complete (and never squiggle) from one shared set. Precise per-node acceptance is
// enforced at parse time (assertKnownKeys), not here.
const ALL_STYLE_NESTED_KEYS: NestedKeyDefinition[] = unionNestedKeys(OVERLAY_STYLE_NESTED_KEYS, [
  { name: "colors", description: "Isochrone contour colors (list); repeat when there are more contours than colors", apply: "colors:\n  - " },
]);

const IMAGE_OVERLAY_NESTED_KEYS: NestedKeyDefinition[] = [
  { name: "path", description: "Vault image file to overlay" },
  { name: "bounds", description: "Axis-aligned georeference: swLat,swLng,neLat,neLng" },
  { name: "corners", description: "Four-corner georeference, clockwise from NW: nwLat,nwLng, neLat,neLng, seLat,seLng, swLat,swLng" },
  { name: "style", description: "Image styling (opacity)", apply: "style:\n  opacity: " },
  ...OVERLAY_ZOOM_NESTED_KEYS,
];

const VECTOR_OVERLAY_NESTED_KEYS: NestedKeyDefinition[] = [
  { name: "tiles", description: "Vector tile URL template with {z}/{x}/{y}" },
  { name: "url", description: "TileJSON URL supplying the tile source" },
  { name: "tileJson", description: "TileJSON URL supplying the tile source" },
  { name: "sourceLayer", description: "Source layer name inside the tiles" },
  { name: "sourceLayers", description: "Source layer names inside the tiles", apply: "sourceLayers:\n  - " },
  { name: "layerType", description: "Layer rendering type: line, fill, circle, or symbol (labels)" },
  { name: "style", description: "Normal feature style", apply: "style:\n  color: " },
  { name: "hoverStyle", description: "Style overrides for the feature under the pointer", apply: "hoverStyle:\n  color: " },
  { name: "filter", description: "Show only matching features. DSL: `index == 1`, `ele >= 1000`, joined with AND. Comparisons: == != > < >= <=" },
  { name: "textField", description: "Symbol layers: feature property to label with (e.g. ele for contour elevations)" },
  { name: "sprite", description: "Symbol layers: external sprite sheet URL supplying icon images (base URL without .json/.png)" },
  { name: "icon", description: "Symbol layers: sprite image name rendered at each feature" },
  { name: "symbolPlacement", description: "Symbol layers: label placement - point, line, or line-center (default line)" },
  { name: "bounds", description: "Tile source bounds: swLat,swLng,neLat,neLng" },
  { name: "attribution", description: "Attribution text for the tile source" },
  ...OVERLAY_ZOOM_NESTED_KEYS,
];

const GEODATA_OVERLAY_NESTED_KEYS: NestedKeyDefinition[] = [
  { name: "path", description: "Vault GeoJSON, GPX, CSV, or note path" },
  { name: "labelTemplate", description: "Label template resolved against overlay features" },
  { name: "waypointLabelTemplate", description: "Label template for GPX <wpt> markers (and directions route endpoints). Defaults to the waypoint name; an empty value hides the labels. Cascades from the global setting of the same name." },
  { name: "style", description: "Normal feature style", apply: "style:\n  color: " },
  { name: "hoverStyle", description: "Style overrides for the feature under the pointer", apply: "hoverStyle:\n  color: " },
  ...OVERLAY_ZOOM_NESTED_KEYS,
];

function unionNestedKeys(...lists: NestedKeyDefinition[][]): NestedKeyDefinition[] {
  const byName = new Map<string, NestedKeyDefinition>();
  for (const list of lists) {
    for (const definition of list) {
      if (!byName.has(definition.name)) {
        byName.set(definition.name, definition);
      }
    }
  }
  return [...byName.values()];
}

const PLACES_NESTED_KEYS: Record<string, NestedKeyDefinition[]> = {
  style: ALL_STYLE_NESTED_KEYS,
  hoverStyle: ALL_STYLE_NESTED_KEYS,
  terrain: [
    { name: "provider", description: "DEM source; enables 3D terrain and turns on hillshade/color relief. Any installed DEM provider (uses that provider's key), `aws` for AWS Terrain Tiles, or a tile URL for a custom raster-DEM source. Unavailable provider is an error, not a fallback." },
    { name: "reliefProvider", description: "DEM for the hillshade and color-relief layers only; the map stays flat and pitch stays off. Takes the same values as `provider`. Applies when the map provider publishes no DEM of its own, or to draw relief from a different DEM than the 3D surface." },
    { name: "exaggeration", description: "Vertical exaggeration of the 3D surface. A constant factor (higher = more dramatic), or a zoom curve of @z stops. Default 1.4." },
    { name: "hillshade", description: "Shaded-relief layer settings", apply: "hillshade:\n  intensity: 0.8" },
    { name: "colorRelief", description: "Elevation-tint layer settings", apply: "colorRelief:\n  opacity: 0.4" },
  ],
  hillshade: [
    { name: "intensity", description: "Shaded-relief strength, 0-1. Defaults to 0.5 when terrain is on; 0 disables it." },
    { name: "method", description: "Shading algorithm: standard, basic, combined, igor, or multidirectional" },
    { name: "direction", description: "Light-source direction in degrees, 0-359 (default 335)" },
    { name: "shadowColor", description: "Color of slopes facing away from the light (default #000000)" },
    { name: "highlightColor", description: "Color of slopes facing the light (default #ffffff)" },
    { name: "accentColor", description: "Accent color applied to steep slopes (default #000000)" },
  ],
  colorRelief: [
    { name: "opacity", description: "Elevation-tint opacity, 0-1. Defaults to 0.4 when terrain is on; 0 disables it." },
    { name: "colors", description: "Elevation-to-color ramp: a preset name (hypsometric, viridis, spectral, grayscale) or a list of `<elevation in metres>: <color>` entries. Unset uses the default hypsometric tint.", apply: "colors: viridis" },
  ],
  track: [
    { name: "directionArrows", description: "Direction arrow scale along tracks (0 disables, 1 = default)" },
    { name: "details", description: "Clicked-point details presentation: popup or panel" },
    { name: "colorBy", description: "Color track lines by none, elevation, grade, speed, or pace" },
    { name: "outline", description: "Show an outline around track lines" },
    { name: "defaultVisibility", description: "Initial track visibility: hidden or visible" },
    { name: "gradeWindow", description: "Span the rolling grade is measured over: a distance such as 100ft or 50m, or a time such as 10min" },
    { name: "speedWindow", description: "Span speed and pace are averaged over: a distance such as 200m or 0.25mi, or a time such as 30s" },
    { name: "selection", description: "Parameters written by track and point selection", apply: "selection:\n  trackParameter: selected\n  pointParameter: selectedPoint" },
    { name: "labels", description: "Track start, midpoint, and end labels", apply: "labels:\n  visibility: all" },
  ],
  selection: [
    { name: "itemParameter", description: "Parameter receiving the selected item id or path" },
    { name: "trackParameter", description: "Parameter receiving the selected track path" },
    { name: "pointParameter", description: "Location parameter receiving the exact selected point" },
    { name: "channel", description: "Shared selection channel exposed to installed Places extensions (default: primary)" },
  ],
  labels: [
    { name: "visibility", description: "Visible track labels: all, none, start, mid, end, or a comma-separated combination" },
    { name: "start", description: "Start label template" },
    { name: "midpoint", description: "Midpoint label template" },
    { name: "end", description: "End label template" },
  ],
  queryParameters: QUERY_PARAMETER_NESTED_KEYS,
  directions: [
    { name: "name", description: "Optional overlay group name" },
    { name: "mode", description: "Travel mode: drive, walk, or bike" },
    { name: "provider", description: "Route service for this group; overrides routeProvider" },
    { name: "visible", description: "false skips this group (no route request). Takes {parameter.*} for a toggle" },
    { name: "cache", description: NESTED_CACHE_DESCRIPTION },
    { name: "traffic", description: "Account for traffic when the provider supports it" },
    { name: "optimize", description: "Reorder intermediate stops when supported" },
    { name: "style", description: "Route line styling: color, strokeWidth, strokeOpacity", apply: "style:\n  color: " },
    { name: "metricLabels", description: "Show total, per-leg, both, or no route metric labels" },
    { name: "labelTemplate", description: "Resolves {this.*} against the whole route, for its total distance and duration label" },
    { name: "legLabelTemplate", description: "Resolves {this.*} against one leg, replacing the total-route label per leg" },
    { name: "routes", description: "Structured route entries", apply: "routes:\n  - waypoints:\n      - \"[[Pizza By Alfredo]]\"\n      - \"[[Alfredos Pizza Cafe]]\"" },
  ],
  isochrones: [
    { name: "name", description: "Optional overlay group name" },
    { name: "mode", description: "Travel mode: drive, walk, or bike" },
    { name: "provider", description: "Route service for this group; overrides routeProvider" },
    { name: "visible", description: "false skips this group (no isochrone request). Takes {parameter.*} for a toggle" },
    { name: "cache", description: NESTED_CACHE_DESCRIPTION },
    { name: "traffic", description: "Account for traffic when the provider supports it" },
    { name: "ranges", description: "Time or distance contours with units (for example, 30 min or 5 mi)" },
    { name: "centers", description: "Isochrone center points as notes, coordinates, or Name: lat, lng", apply: "centers:\n  - " },
    { name: "polygons", description: "Render filled polygons when supported" },
    { name: "minZoom", description: "Minimum map zoom where this isochrone overlay is visible" },
    { name: "maxZoom", description: "Maximum map zoom where this isochrone overlay is visible" },
    { name: "style", description: "Contour styling: colors, fillOpacity, strokeWidth, strokeOpacity", apply: "style:\n  colors:\n    - " },
  ],
  overlays: unionNestedKeys(GEODATA_OVERLAY_NESTED_KEYS, IMAGE_OVERLAY_NESTED_KEYS, VECTOR_OVERLAY_NESTED_KEYS, [
    { name: "type", description: "Overlay kind override: geodata, image, or vector-tile. Inferred from the entry's fields when omitted" },
    { name: "visible", description: "Renders the entry when true (default); false skips it. Takes {parameter.*} placeholders for interactive layer controls" },
  ]),
};

const PLACES_LIST_ITEM_TEMPLATES: Record<string, ListItemTemplate[]> = {
  // Structural scaffolds only. Waypoint notes are filled from the real-file
  // completion offered on each list item, and no placeholder note names appear.
  routes: [
    { label: "waypoints", insert: "waypoints:\n    - \n    - ", description: "Route through an explicit list of waypoint notes or coordinates" },
    { label: "query", insert: "query: SELECT * FROM places WHERE path IN ({this.outgoingLinks}) ORDER BY title", description: "Route through places returned by VaultQuery" },
    { label: "waypoints from current note", insert: "waypoints:\n    - \"{this}\"\n    - ", description: "Route from this note to a destination" },
  ],
};

// Every key the highlighter accepts anywhere in a places block. The highlighter
// validates keys lexically (no YAML-path awareness), and nested sub-keys are
// accepted too; rootKeys (PLACES_ROOT_KEYS) narrows COMPLETION to the top level.
// Derived from PLACES_NESTED_KEYS: the union follows sub-key changes without a hand-kept list.
const PLACES_NESTED_KEY_NAMES = Object.values(PLACES_NESTED_KEYS).flatMap(defs => defs.map(def => def.name));
const PLACES_BLOCK_KEYS = Array.from(new Set([
  ...PLACES_ROOT_KEYS,
  ...PLACES_NESTED_KEY_NAMES,
  ...STRUCTURED_OVERLAY_KEYS,
  'waypoints',       // routes list-item sub-key (from PLACES_LIST_ITEM_TEMPLATES)
  'embeddedPlaces',  // written as block body, but accepted if typed as a key
]));

// Known values for places block and related help blocks (places-style, places-overlay, places-bases)
const PLACES_BLOCK_KNOWN_VALUES = {
  clusterGeoJsonOverlays: ['true', 'false'],
  showLabels: ['true', 'false'],
  details: ['popup', 'panel'],
  colorBy: ['none', 'elevation', 'grade', 'speed', 'pace'],
  outline: ['true', 'false'],
  defaultVisibility: ['hidden', 'visible'],
  shapeMatch: ['map_snap', 'edge_walk', 'walk_or_snap'],
  wayDetails: ['true', 'false'],
  tidy: ['true', 'false'],
  timestamps: ['true', 'false'],
  visibility: ['all', 'none', 'start', 'mid', 'end'],
  markerRenderer: ['native', 'html'],
  method: ['standard', 'basic', 'combined', 'igor', 'multidirectional'],
  poiDiscovery: ['true', 'false'],
  showHelpWithEmptyMap: ['true', 'false'],
  debug: ['true', 'false', 'settings', 'parameters'],
  legend: ['hidden', 'top', 'bottom'],
  mode: ['drive', 'walk', 'bike'],
  polygons: ['true', 'false'],
  traffic: ['true', 'false'],
  queryParametersPosition: ['below', 'above', 'floating'],
  queryParametersLayout: ['horizontal', 'vertical'],
  queryParametersCollapsed: ['true', 'false'],
  // Covers both query parameter types and overlay kind overrides.
  type: ['int', 'float', 'string', 'date', 'datetime', 'time', 'boolean', 'enum', 'list', 'location', 'geodata', 'image', 'vector-tile'],
  layerType: ['line', 'fill', 'circle', 'symbol'],
  control: ['slider', 'range', 'number', 'text', 'combobox', 'dropdown', 'segmented', 'toggle', 'date', 'datetime', 'time', 'multiselect', 'location', 'stops', 'custom'],
};

const PLACES_BLOCK_DEFINITION: CodeBlockDefinition = {
  type: "places",
  description: "Map with markers, paths, and overlays",
  parameters: [
      { name: "fromTemplate", description: "Apply a template note's settings as defaults. Accepts one name or a list; later templates override earlier ones, and keys in this block override all. A template is a places-template block in any note, named by link - [[Base Map]], [[Styles#Category]], or a bare name.", values: "[[Base Map]]" },
      ...COMMON_SIZE_PARAMS,
      ...COMMON_MAP_PARAMS,
      ...COMMON_QUERY_PARAMS,
      { name: "showLabels", description: "Show each marker name beside its icon", values: "**true**, false" },
      { name: "markerFilter", description: "Show only markers matching a condition (icon and label together). Same syntax as an iconStyles condition (no => part); the left side is a metadata field, the right side may be a {parameter.*} value. Example patterns: field == value (show that value), field != value (hide it), field >= value (threshold), field IN a, b (set membership; tag IN a, b for tags - pairs with a multiselect parameter).", values: "tag IN {parameter.show}" },
      { name: "iconRotation", description: "Rotate every marker icon, in degrees clockwise from true north. A plain number rotates them all equally; a per-place template rotates each by its own data, e.g. {this.wind_direction_10m}. Arrow glyphs usually point east, so add an offset in the template: {(this.wind_direction_10m + 270) % 360}.", values: "45, {this.wind_direction_10m}, {(this.bearing + 270) % 360}" },
      { name: "markerRenderer", description: "Marker renderer for MapLibre-based providers. Native is the default; opt into HTML markers only when a block needs arbitrary marker CSS.", values: "**native**, html" },
      { name: "track", description: "Track rendering, details, labels, and shared selection parameters.", values: "directionArrows: 1\n  details: panel\n  selection:\n    trackParameter: selected\n    pointParameter: selectedPoint" },
      { name: "selection", description: "General item and point selection shared by parameters and installed Places extensions.", values: "itemParameter: selectedItem\n  pointParameter: selectedPoint\n  channel: primary" },
      { name: "legend", description: "Show color legend for elevation/grade coloring", values: "**hidden**, top, bottom" },
      { name: "overlays", description: "Overlays as an expanded list; entry kind is inferred. Supports GeoJSON, GPX, CSV, and note paths, plus image and vector tile entries.", values: "- path: 02 - Overlays/scranton-neighborhoods.geojson\n  labelTemplate: \"{this.name}\"\n  minZoom: 10" },
      { name: "routeProvider", description: "Default route service for all directions/isochrones in this block. Falls back to the map provider's own service when omitted.", values: "any installed route provider" },
      { name: "directions", description: "Generated route overlays as a list of group mappings. Every route entry holds either a `waypoints` list or a `query`, not both.", values: "- mode: drive\n  routes:\n    - waypoints:\n        - \"[[Pizza By Alfredo]]\"\n        - \"[[Alfredos Pizza Cafe]]\"" },
      { name: "isochrones", description: "Generated reachable-area overlays as a list of mappings with unit-bearing ranges and text centers.", values: "- mode: walk\n  ranges:\n    - 15 min\n    - 5 mi\n  centers:\n    - \"[[Dunder Mifflin Scranton]]\"" },
      { name: "name", description: "Optional name for a directions or isochrone group.", values: "bike route" },
      { name: "provider", description: "Route service for one directions/isochrones group when nested under those settings. Overrides routeProvider.", values: "any installed route provider" },
      { name: "cache", description: `Set inside a directions/isochrones group. ${CACHE_PARAMETER_DESCRIPTION}`, values: CACHE_PARAMETER_VALUES },
      { name: "mode", description: "Travel mode for directions/isochrones when nested under those settings", values: "**drive**, walk, bike" },
      { name: "routes", description: "Structured route mappings nested under directions. Each entry holds either a `waypoints` list or a `query`, not both.", values: "- waypoints:\n    - \"[[Pizza By Alfredo]]\"\n    - \"[[Dunder Mifflin Scranton]]\"\n    - \"[[Alfredos Pizza Cafe]]\"" },
      { name: "optimize", description: "When true, reorder intermediate direction stops if the provider supports route optimization", values: "**false**, true" },
      { name: "metricLabels", description: "Directions metric labels to render: total route, each leg between stops, both, or none.", values: "**total**, legs, both, none" },
      { name: "color", description: "Directions route line color. Quote hexadecimal values so YAML does not treat them as comments.", values: "\"#2563eb\"" },
      { name: "routeLabelTemplate", description: "Template for generated directions labels. Uses route properties like {this.distance_text}, {this.duration_text}, {this.start_name}, and {this.end_name}.", values: "{this.distance_text} · {this.duration_text}" },
      { name: "legLabelTemplate", description: "Template for generated per-leg directions labels. Uses leg properties like {this.from_name}, {this.to_name}, {this.distance_text}, and {this.duration_text}.", values: "{this.from_name} → {this.to_name}: {this.distance_text} · {this.duration_text}" },
      { name: "waypointLabelTemplate", description: "Template for the marker label at each route waypoint (start / stop / end). Uses {this.name}, {this.role}, {this.role_label}, {this.index}, {this.icon}, {this.path}. Empty hides the labels. Also applies to GPX <wpt> markers.", values: "{this.role_label}: {this.name}" },
      { name: "ranges", description: "Positive isochrone contours with a time or distance unit. Time and distance values may be mixed.", values: "- 15 min\n- 30 min\n- 5 mi" },
      { name: "centers", description: "Isochrone center points as a list of note references, coordinates, or named coordinates.", values: "- \"[[Schrute Farms]]\"\n- \"Downtown Scranton: 41.408, -75.662\"" },
      { name: "polygons", description: "Render isochrones as polygons instead of lines when provider supports it", values: "**true**, false" },
      { name: "traffic", description: "Account for traffic on driving directions and isochrones. Honored by Mapbox and Geoapify; ignored by other providers and non-drive modes. Bypasses the overlay cache.", values: "**false**, true" },
      { name: "colors", description: "List of quoted colors for isochrone polygons. Colors repeat when there are more contours than colors.", values: "- \"#4f46e5\"\n- \"#0891b2\"\n- \"#16a34a\"" },
      { name: "fillOpacity", description: "Isochrone polygon fill opacity. Accepts decimals from 0 to 1 or percentages.", values: "0.14 or 14%" },
      { name: "strokeOpacity", description: "Directions route or isochrone contour line opacity. Accepts decimals from 0 to 1 or percentages.", values: "0.85 or 85%" },
      { name: "strokeWidth", description: "Directions route or isochrone contour line width in pixels.", values: "2" },
      { name: "maxZoom", description: "Maximum zoom where an isochrone overlay group is visible.", values: "8, 12, 16" },
      { name: "clusterThreshold", description: "Override marker clustering for this map. 0 disables clustering; positive numbers cluster when point count reaches that threshold.", values: "0, 100, 500" },
      { name: "clusterGeoJsonOverlays", description: "Include GeoJSON overlay point features in marker clustering for this map.", values: "**true**, false" },
      { name: "css", description: "Raw CSS injected with the map. Marker selectors need HTML markers (Leaflet or markerRenderer: html); popup/legend/container selectors are supported on every provider.", values: ".places-marker-icon { opacity: 0.7; }" },
      { name: "iconStyles", description: "Conditional icon styling rules. Native markers translate a supported property subset; the rest needs markerRenderer: html.", values: "condition => css-properties" },
      { name: "labelStyles", description: "Conditional label styling rules. Native labels translate a property subset; full CSS applies on Leaflet only.", values: "condition => css-properties" },
      { name: "labelTemplate", description: "Template for marker label text", values: "{this.filename}, {h.before(this.name, '(')}" },
      { name: "queryParameters", description: "UI-adjustable parameters. Each entry declares a name referenced as {parameter.name} in the query or any other block setting, with a type, optional control, and default. Changing a control re-renders the affected data.", values: "- name: days\n  type: int\n  control: slider\n  min: 0\n  max: 100\n  default: 7" },
      { name: "queryParametersPosition", description: "Where the query parameter controls render relative to the map.", values: "**below**, above, floating" },
      { name: "queryParametersLayout", description: "Whether the query parameter controls flow along a row or stack one per line.", values: "**horizontal**, vertical" },
      { name: "queryParametersCollapsed", description: "Initial state of the control strip's collapse toggle. A floating strip always has the toggle; declaring this adds it to an above or below strip too.", values: "true, **false**" },
      { name: "tools", description: "Extension-owned interactive MapLibre tools, keyed by registered tool id.", values: "playback:\n  track: \"[[Lake Scranton Weekend Run]]\"\n  duration: 60s" },
      { name: "control", description: "Input control for a query parameter, nested under queryParameters. Inferred from type when omitted.", values: "slider, range, number, text, combobox, dropdown, segmented, toggle, date, datetime, time, multiselect, location, stops" },
      { name: "label", description: "Display label for a query parameter control, nested under queryParameters. Defaults to the parameter name.", values: "Days ahead" },
      { name: "default", description: "Initial value for a query parameter, nested under queryParameters. On a list parameter, all selects every option, including optionsQuery results.", values: "7, all" },
      { name: "options", description: "Allowed values for an enum or list query parameter, nested under queryParameters. Also suggestions for a combobox.", values: "[any, 🍕, 🍝]" },
      { name: "optionsQuery", description: "VaultQuery SQL whose first column supplies the options at render time, in query order. Nested under queryParameters.", values: "SELECT DISTINCT icon FROM places ORDER BY icon" },
      { name: "step", description: "Slider or number step for a numeric query parameter, nested under queryParameters.", values: "1, 0.5" },
      { name: "width", description: "Control width for a query parameter, nested under queryParameters. Fixed lengths size the input; percentages size the parameter relative to the full control strip. Fixed lengths have no effect on toggle, segmented, or multiselect.", values: "240px, 18rem, 30ch, 50%" },
      { name: "range", description: "Shorthand for min and max on a numeric query parameter, nested under queryParameters.", values: "0, 100" },
      { name: "poiDiscovery", description: "Enable clicking map features to discover POIs", values: "**true**, false" },
      { name: "pitch", description: "Allow tilting the map into an oblique 3D view (drag with right mouse / two fingers).", values: "**false**, true" },
      { name: "terrain", description: "3D terrain, hillshade, and color relief, grouped. Sub-keys: provider (DEM source, enables 3D + relief), exaggeration, and the hillshade/colorRelief layers.", values: "provider: mapbox\n  exaggeration: 2\n  hillshade:\n    intensity: 0.8" },
      { name: "showHelpWithEmptyMap", description: "When this block has no places, show the empty map either way; set false to hide the help text below it. Overrides the global setting.", values: "**true**, false" },
      { name: "debug", description: "Diagnostics, combinable as a comma list. true shows map state/viewport/performance on the map; settings shows a table of how every setting resolved across defaults, global, provider, and block layers; parameters shows parameter values, {parameter.*} substitutions, and per-rule markerFilter results, and adds a fields-and-filters inspector to marker popups", values: "**false**, true, settings, parameters" }
  ]
};

export const MAIN_PLUGIN_DEFINITIONS: CodeBlockDefinition[] = [
  PLACES_BLOCK_DEFINITION,
  {
    type: "places-parameters",
    description: "Note-scoped parameter controls shared by every block in the note",
    parameters: [
      { name: "queryParameters", description: "Parameter definitions; every block in the note resolves them as {parameter.name}. Block-local declarations shadow them by name.", values: "- name: days\n  type: int\n  control: slider\n  min: 0\n  max: 100\n  default: 7" },
      { name: "queryParametersLayout", description: "Whether the controls flow along a row or stack one per line.", values: "**horizontal**, vertical" },
      { name: "queryParametersCollapsed", description: "Declaring this adds a collapse toggle to the strip, starting collapsed when true.", values: "true, false" },
    ],
  },
  {
    type: "places-chart",
    description: "Elevation and track analysis charts",
    parameters: [
      ...COMMON_SIZE_PARAMS,
      { name: "chartType", values: "**elevation**, elevation-grade, elevation-time, speed, speed-time, pace, pace-time, grade" },
      { name: "track1", description: "First track for comparison (or single track), as a track note or track file path", values: "[[Morning Run - Monday]]" },
      { name: "track2", description: "Second track for comparison, as a track note or track file path", values: "[[Morning Run - Tuesday]]" },
      { name: "position", description: "Coordinate to highlight on a single-track chart", values: "{parameter.selectedPoint}" },
      { name: "selection", description: "Typed selection channel shared with maps and other charts", values: "channel: primary" },
      { name: "title", description: "Heading above the chart. Omit for no title", values: "\"Elevation Profile\", \"My Hike\"" },
      { name: "fillArea", description: "Fill area under line", values: "**true**, false" },
      { name: "colorBy", description: "Color chart fill by data", values: "**none**, elevation, grade" },
      { name: "gradeWindow", description: "Span the rolling grade is measured over", values: "**100ft**, 50m, 0.1mi, 10min" },
      { name: "speedWindow", description: "Span speed and pace are averaged over", values: "**200m**, 500ft, 0.25mi, 30s, 5min" },
      { name: "legend", description: "Show color legend for grade/elevation coloring", values: "**hidden**, top, bottom" },
      { name: "showGrid", values: "**true**, false" },
      { name: "showPoints", values: "**false**, true" },
      { name: "smoothing", description: "Smooth the line", values: "**true**, false" },
      { name: "stats", description: "Statistics to display", values: "elevation, time, speed, pace, distance, points" },
      { name: "axisColor", values: "**#666**, #000, rgb()" },
      { name: "elevationColor", values: "**#2196F3**" },
      { name: "speedColor", values: "**#ff7f00**" },
      { name: "paceColor", values: "**#dc3545**" },
      { name: "gradeColor", values: "**#ff7f00**" },
      { name: "fontSize", values: "**12**, 10, 14, 16" },
      { name: "autorefresh", description: "Re-render when the vault index changes", values: "**(global setting)**, true, false" }
    ]
  },
  {
    type: "places-heatmap",
    description: "Frequency analysis and route heatmaps",
    parameters: [
      ...COMMON_SIZE_PARAMS,
      ...COMMON_MAP_PARAMS,
      ...COMMON_QUERY_PARAMS,
      { name: "strategy", description: "Analysis algorithm", values: "**track-corridor**, density-cloud, opacity-stacking" },
      { name: "gridSize", description: "Grid cell size (feet/meters)", values: "**100**, 50, 200, 500" },
      { name: "minFrequency", description: "Hide segments fewer tracks than this passed along", values: "**2**, 1, 3, 5" },
      { name: "maxSegments", description: "Cap on rendered segments. Lower it when a dense vault makes the map slow", values: "**100**, 50, 200, unlimited" },
      { name: "colorScheme", description: "Color palette: a preset name or a custom comma-separated list of hex colors interpolated low-to-high.", values: "**yellow-to-red**, blues, heat, traffic, or a custom gradient" },
      { name: "lineThickness", description: "Line thickness (pixels)", values: "**3**, 2, 5, 10" },
      { name: "lineStyle", description: "Line dash pattern", values: "**solid**, \"5,10\", \"10,5\"" },
      { name: "lineOpacity", description: "One opacity for every segment, overriding the frequency-driven range", values: "0.0 - 1.0" },
      { name: "minOpacity", description: "Minimum opacity (opacity-stacking)", values: "**0.01**, 0.05, 0.1" },
      { name: "maxOpacity", description: "Maximum opacity at max overlap", values: "**1.0**, 0.8, 0.5" },
      { name: "legendLocation", description: "Legend position", values: "**hidden**, top, bottom" },
      { name: "infoLocation", description: "Info text position", values: "**hidden**, top, bottom" },
      { name: "autorefresh", description: "Re-render when the vault index changes", values: "**(global setting)**, true, false" }
    ]
  },
  {
    type: "places-similar",
    description: "Find similar tracks",
    parameters: [
      { name: "minSimilarity", description: "Minimum Fréchet similarity (0-100 or 0-1)", values: "**70**, 50, 85, 90 (or 0.7)" },
      { name: "minOverlap", description: "Minimum overlap (0-100 or 0-1)", values: "50, 70, 85 (or 0.5, 0.7)" },
      { name: "tolerance", description: "Max deviation in degrees for Frechet matching (~111 km/degree)", values: "**0.01** (~1.1km), 0.1 (~11km), 0.5 (~55km)" },
      { name: "overlapTolerance", description: "Distance tolerance in meters for overlap calculation", values: "**50**, 25, 100" },
      { name: "maxResults", description: "Maximum tracks to show", values: "**unlimited**, 5, 10, 20" },
      { name: "radius", description: "Search radius (miles/km)", values: "**note's Distance**, 1.0, 2, 5, 10" },
      { name: "location", description: "Coordinates for point-based search", values: "**note's Location**, 41.408,-75.662" },
      { name: "showPersonalBest", description: "Mark the fastest run of each matched route", values: "**false**, true" },
      { name: "showSpeedTime", description: "Show speed/duration columns", values: "**false**, true" },
      { name: "autorefresh", description: "Re-render when the vault index changes", values: "**(global setting)**, true, false" }
    ]
  },
  {
    type: "places-compare",
    description: "Compare two tracks side-by-side",
    parameters: [
      { name: "track1", description: "First track to compare", values: "[[Lake Scranton Weekend Run]]" },
      { name: "track2", description: "Second track to compare", values: "[[Fun Run Training Route]]" },
      { name: "tolerance", description: "Overlap detection distance (m/ft)", values: "**50**, 20, 100" },
      { name: "height", values: "**300px**, 400px, 500px" },
      { name: "mapProvider", values: "any installed map provider" },
      { name: "showMiniMap", description: "Show track comparison map", values: "**true**, false" },
      { name: "showMetrics", description: "Show the distance, elevation, and overlap comparison tables", values: "**true**, false" },
      { name: "autorefresh", description: "Re-render when the vault index changes", values: "**(global setting)**, true, false" }
    ]
  },
  {
    type: "places-snap",
    description: "Snap a track to the closed road or trail.",
    parameters: [
      { name: "track", description: "Track note or file to snap. Defaults to the current note.", values: "[[Morning Run - Monday]]" },
      { name: "provider", description: "Snap service to use. Defaults to the first available provider with snap support.", values: "any installed snap provider" },
      { name: "mode", description: "Travel mode. Decides which ways are eligible: walk and bike include footpaths, tracks, and cycleways, drive is roads only", values: "**drive**, walk, bike" },
      { name: "radius", description: "Search radius around each point. A bare number uses the units setting; an explicit unit overrides it", values: "**300m**, 500m, 0.2mi" },
      { name: "costing", description: "Valhalla costing name, overriding the one mode resolves to. Reaches costings mode cannot express", values: "pedestrian, bicycle, auto, truck, bus, motor_scooter" },
      { name: "costingOptions", description: "Options for the effective costing, passed through verbatim. Valhalla-based providers only", values: "walkway_factor: 0.5" },
      { name: "timestamps", description: "Send each point's recorded time so elapsed time constrains the match. On by default when the track has times", values: "**true**, false" },
      { name: "tidy", description: "Collapse near-duplicate and stationary points before matching. Mapbox only", values: "true, **false**" },
      { name: "exclude", description: "Way classes to keep the match off. Mapbox only", values: "motorway, toll, ferry" },
      { name: "shapeMatch", description: "Valhalla matching strategy. edge_walk suits a trace that already follows the network", values: "**map_snap**, edge_walk, walk_or_snap" },
      { name: "traceOptions", description: "Valhalla trace options tuning the matcher itself, passed through verbatim. Valhalla measures these in metres regardless of the units setting", values: "search_radius: 35\n  gps_accuracy: 8" },
      { name: "wayDetails", description: "Report the named ways and surfaces the match ran along. Valhalla-based providers only", values: "true, **false**" },
      { name: "mapProvider", description: "Map used for the preview. Defaults to the global default provider.", values: "any installed map provider" },
      { name: "height", description: "Preview map height", values: "**400px**, 500px" },
    ],
  },
  {
    type: "places-elevation",
    description: "Replace or add elevation data for a track.",
    parameters: [
      { name: "track", description: "Track note or file to populate. Defaults to the current note.", values: "[[Morning Run - Monday]]" },
      { name: "provider", description: "Elevation service to use. Defaults to the first available provider with elevation support.", values: "any installed elevation provider" },
      { name: "height", description: "Preview chart height", values: "**320px**, 400px" },
      { name: "width", description: "Preview chart width", values: "**100%**, 800px" },
      { name: "title", description: "Heading above the chart. Omit for no title", values: "\"Elevation Replacement Preview\"" },
      { name: "showGrid", values: "**true**, false" },
      { name: "showPoints", values: "**false**, true" },
      { name: "smoothing", description: "Smooth chart lines", values: "**true**, false" },
      { name: "fillArea", description: "Shade the area under chart lines", values: "**false**, true" },
      { name: "autorefresh", description: "Re-render when the vault index changes", values: "**(global setting)**, true, false" }
    ],
  },
  {
    type: "places-image-align",
    description: "Interactive image overlay alignment tool",
    parameters: [
      { name: "mapProvider", values: "any installed map provider" },
      { name: "overlays", description: "Image with optional initial coordinates", values: "- path: 02 - Overlays/scranton-1889-usgs-topo.jpg\n  bounds: 41.25,-75.75,41.5,-75.5" },
      { name: "height", values: "**500px**, 400px, 600px" },
      { name: "style", values: "streets, satellite, terrain, outdoors" },
      { name: "opacity", values: "**1.0**, 0.5, 0.8" },
      { name: "initialZoom", description: "Initial map zoom level", values: "**auto**, 10, 14, 18" },
      { name: "initialCenter", description: "Initial map center (lat,lng)", values: "**auto**, 41.408, -75.662" }
    ]
  },
  // The help blocks render `places` examples and already share its keys, known
  // values and nested keys. Without a definition of their own, every key and
  // value inside them completed with a placeholder description.
  //
  // `places-template` holds a reusable block body in a note. It shares the same
  // keys because that is literally what it contains, and being a `places-*`
  // language is what gives it highlighting and completion; it has no processor,
  // and renders as plain code rather than a half-configured map.
  ...['places-style', 'places-overlay', 'places-bases', 'places-template'].map((type): CodeBlockDefinition => ({
    type,
    description: PLACES_BLOCK_DEFINITION.description,
    parameters: PLACES_BLOCK_DEFINITION.parameters,
  })),
];

// Data blocks resolve {parameter.*} too: queryParameters completes and
// highlights in them exactly as in places blocks, and BlockParameterSupport
// honors the same strip keys.
const DATA_BLOCK_PARAMETER_NESTED_KEYS = { queryParameters: PLACES_NESTED_KEYS.queryParameters };
const DATA_BLOCK_PARAMETER_STRIP_KEYS = ['queryParametersPosition', 'queryParametersLayout', 'queryParametersCollapsed'];
const DATA_BLOCK_PARAMETER_KNOWN_VALUES = {
  type: PLACES_BLOCK_KNOWN_VALUES.type,
  control: PLACES_BLOCK_KNOWN_VALUES.control,
  queryParametersPosition: PLACES_BLOCK_KNOWN_VALUES.queryParametersPosition,
  queryParametersLayout: PLACES_BLOCK_KNOWN_VALUES.queryParametersLayout,
  queryParametersCollapsed: PLACES_BLOCK_KNOWN_VALUES.queryParametersCollapsed,
};

export const MAIN_PLUGIN_HIGHLIGHT_CONFIGS: CodeBlockHighlightConfig[] = [
  {
    blockType: 'places-parameters',
    validKeys: ['queryParameters', 'queryParametersLayout', 'queryParametersCollapsed'],
    knownValues: {
      type: PLACES_BLOCK_KNOWN_VALUES.type,
      control: PLACES_BLOCK_KNOWN_VALUES.control,
      queryParametersLayout: PLACES_BLOCK_KNOWN_VALUES.queryParametersLayout,
      queryParametersCollapsed: PLACES_BLOCK_KNOWN_VALUES.queryParametersCollapsed,
    },
    nestedKeys: { queryParameters: PLACES_NESTED_KEYS.queryParameters },
  },
  {
    blockType: 'places',
    validKeys: PLACES_BLOCK_KEYS,
    rootKeys: PLACES_ROOT_KEYS,
    knownValues: PLACES_BLOCK_KNOWN_VALUES,
    nestedKeys: PLACES_NESTED_KEYS,
    listItemTemplates: PLACES_LIST_ITEM_TEMPLATES
  },
  {
    blockType: 'places-snap',
    validKeys: [...COMMON_KEYS, 'track', 'provider', 'mode', 'radius', 'costing', 'costingOptions', 'traceOptions', 'timestamps', 'tidy', 'exclude', 'shapeMatch', 'wayDetails', 'mapProvider', 'style', 'poiDiscovery', 'queryParameters', ...DATA_BLOCK_PARAMETER_STRIP_KEYS],
    knownValues: { ...DATA_BLOCK_PARAMETER_KNOWN_VALUES, mode: ['drive', 'walk', 'bike'], poiDiscovery: ['true', 'false'] },
    nestedKeys: DATA_BLOCK_PARAMETER_NESTED_KEYS,
  },
  {
    blockType: 'places-elevation',
    validKeys: [...COMMON_KEYS, 'track', 'provider', 'title', 'showGrid', 'showPoints', 'smoothing', 'fillArea', 'autorefresh', 'queryParameters', ...DATA_BLOCK_PARAMETER_STRIP_KEYS],
    knownValues: {
      ...DATA_BLOCK_PARAMETER_KNOWN_VALUES,
      autorefresh: ['true', 'false'],
      showGrid: ['true', 'false'],
      showPoints: ['true', 'false'],
      smoothing: ['true', 'false'],
      fillArea: ['true', 'false'],
    },
    nestedKeys: DATA_BLOCK_PARAMETER_NESTED_KEYS,
  },
  {
    blockType: 'places-chart',
    validKeys: [...COMMON_KEYS, 'chartType', 'track1', 'track2', 'position', 'selection', 'title', 'showGrid', 'showPoints', 'smoothing', 'fillArea', 'axisColor', 'elevationColor', 'speedColor', 'paceColor', 'gradeColor', 'fontSize', 'stats', 'colorBy', 'gradeWindow', 'gradeDistance', 'speedWindow', 'legend', 'autorefresh', 'debug', 'queryParameters', ...DATA_BLOCK_PARAMETER_STRIP_KEYS],
    rootKeys: [...COMMON_KEYS, 'chartType', 'track1', 'track2', 'position', 'selection', 'title', 'showGrid', 'showPoints', 'smoothing', 'fillArea', 'axisColor', 'elevationColor', 'speedColor', 'paceColor', 'gradeColor', 'fontSize', 'stats', 'colorBy', 'gradeWindow', 'gradeDistance', 'speedWindow', 'legend', 'autorefresh', 'debug', 'queryParameters', ...DATA_BLOCK_PARAMETER_STRIP_KEYS],
    nestedKeys: { ...DATA_BLOCK_PARAMETER_NESTED_KEYS, selection: PLACES_NESTED_KEYS.selection },
    knownValues: {
      ...DATA_BLOCK_PARAMETER_KNOWN_VALUES,
      autorefresh: ['true', 'false'],
      chartType: ['elevation', 'elevation-grade', 'elevation-time', 'speed', 'speed-time', 'pace', 'pace-time', 'grade'],
      showGrid: ['true', 'false'],
      showPoints: ['true', 'false'],
      smoothing: ['true', 'false'],
      fillArea: ['true', 'false'],
      colorBy: ['none', 'elevation', 'grade'],
      legend: ['hidden', 'top', 'bottom']
    }
  },
  {
    blockType: 'places-heatmap',
    validKeys: [...COMMON_KEYS, ...MAP_KEYS, ...QUERY_KEYS_HIGHLIGHT, 'strategy', 'gridSize', 'minFrequency', 'maxSegments', 'colorScheme', 'lineThickness', 'lineStyle', 'minOpacity', 'maxOpacity', 'lineOpacity', 'legendLocation', 'infoLocation', 'poiDiscovery', 'averageSegments', 'autorefresh', 'css', 'debug', 'queryParameters', ...DATA_BLOCK_PARAMETER_STRIP_KEYS],
    nestedKeys: DATA_BLOCK_PARAMETER_NESTED_KEYS,
    knownValues: {
      ...DATA_BLOCK_PARAMETER_KNOWN_VALUES,
      autorefresh: ['true', 'false'],
      strategy: ['density-cloud', 'track-corridor', 'opacity-stacking'],
      colorScheme: ['yellow-to-red', 'blues', 'heat', 'traffic'],
      legendLocation: ['hidden', 'top', 'bottom'],
      infoLocation: ['hidden', 'top', 'bottom'],
      poiDiscovery: ['true', 'false'],
      averageSegments: ['true', 'false'],
    }
  },
  {
    blockType: 'places-similar',
    validKeys: ['minSimilarity', 'minOverlap', 'tolerance', 'overlapTolerance', 'maxResults', 'radius', 'location', 'showPersonalBest', 'showSpeedTime', 'autorefresh', 'queryParameters', ...DATA_BLOCK_PARAMETER_STRIP_KEYS],
    nestedKeys: DATA_BLOCK_PARAMETER_NESTED_KEYS,
    knownValues: {
      ...DATA_BLOCK_PARAMETER_KNOWN_VALUES,
      autorefresh: ['true', 'false'],
      showPersonalBest: ['true', 'false'],
      showSpeedTime: ['true', 'false']
    }
  },
  {
    blockType: 'places-compare',
    validKeys: ['track1', 'track2', 'tolerance', 'height', 'width', 'mapProvider', 'showMiniMap', 'showMetrics', 'style', 'poiDiscovery', 'autorefresh', 'queryParameters', ...DATA_BLOCK_PARAMETER_STRIP_KEYS],
    nestedKeys: DATA_BLOCK_PARAMETER_NESTED_KEYS,
    knownValues: {
      ...DATA_BLOCK_PARAMETER_KNOWN_VALUES,
      autorefresh: ['true', 'false'],
      showMiniMap: ['true', 'false'],
      showMetrics: ['true', 'false'],
      poiDiscovery: ['true', 'false'],
    }
  },
  {
    blockType: 'places-reference',
    validKeys: []  // No parameters
  },
  {
    blockType: 'places-image-align',
    validKeys: ['mapProvider', 'overlays', 'path', 'bounds', 'corners', 'height', 'style', 'opacity', 'initialZoom', 'initialCenter'],
    rootKeys: ['mapProvider', 'overlays', 'height', 'style', 'opacity', 'initialZoom', 'initialCenter'],
    nestedKeys: { overlays: IMAGE_OVERLAY_NESTED_KEYS }
  },
  // Help-related block types - same keys as 'places', giving examples in help blocks proper highlighting
  { blockType: 'places-style', validKeys: PLACES_BLOCK_KEYS, rootKeys: PLACES_ROOT_KEYS, knownValues: PLACES_BLOCK_KNOWN_VALUES, nestedKeys: PLACES_NESTED_KEYS, listItemTemplates: PLACES_LIST_ITEM_TEMPLATES },
  { blockType: 'places-overlay', validKeys: PLACES_BLOCK_KEYS, rootKeys: PLACES_ROOT_KEYS, knownValues: PLACES_BLOCK_KNOWN_VALUES, nestedKeys: PLACES_NESTED_KEYS, listItemTemplates: PLACES_LIST_ITEM_TEMPLATES },
  { blockType: 'places-bases', validKeys: PLACES_BLOCK_KEYS, rootKeys: PLACES_ROOT_KEYS, knownValues: PLACES_BLOCK_KNOWN_VALUES, nestedKeys: PLACES_NESTED_KEYS, listItemTemplates: PLACES_LIST_ITEM_TEMPLATES },
  { blockType: 'places-template', validKeys: PLACES_BLOCK_KEYS, rootKeys: PLACES_ROOT_KEYS, knownValues: PLACES_BLOCK_KNOWN_VALUES, nestedKeys: PLACES_NESTED_KEYS, listItemTemplates: PLACES_LIST_ITEM_TEMPLATES }
];
