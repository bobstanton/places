import { TRACK_COLOR_BY_MODES, HEATMAP_COLOR_PRESETS, DEFAULT_DENSITY_COLOR_SCHEME } from "places-shared/track";
import { CACHE_PARAMETER_DESCRIPTION, CACHE_PARAMETER_VALUES, COMMON_SIZE_PARAMS, COMMON_SIZE_KEYS, QUERY_PARAMETER_NESTED_KEYS } from "places-shared/settings";

// Nested `cache:` under a directions/isochrones group - same grammar as every block-level `cache:`.
const NESTED_CACHE_DESCRIPTION = `Route overlay cache for this group. ${CACHE_PARAMETER_DESCRIPTION}`;

import { CodeBlockDefinition, CodeBlockHighlightConfig, ListItemTemplate } from "places-shared/obsidian/services";
import { ParameterDefinition, NestedKeyDefinition } from "places-shared/services";
import { isRecord, normalizePropertyName } from "places-shared/utils";

export interface ProvidedCodeBlockValue {
  value: string;
  description?: string;
}

export class CodeBlockRegistry {
  private static _instance: CodeBlockRegistry;
  private definitions: CodeBlockDefinition[] = [];
  private highlightConfigs: Map<string, CodeBlockHighlightConfig> = new Map();
  private knownValues: Map<string, Set<string>> = new Map();
  private providedValues: Map<string, Set<string>> = new Map();
  private providedValueDescriptions: Map<string, Map<string, string>> = new Map();
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
      const declaredChoices = Object.fromEntries((this.getDefinition(incoming.blockType)?.parameters ?? [])
        .flatMap(parameter => typeof parameter.values !== 'string' && 'choices' in parameter.values
          ? [[parameter.name, parameter.values.choices.map(value => value.toLowerCase())]] : []));
      const withChoices = { ...inheritedConfig, knownValues: { ...declaredChoices, ...inheritedConfig.knownValues } };
      const config = existing ? mergeHighlightConfig(existing, withChoices) : withChoices;

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

  setProvidedValues(key: string, values: Iterable<string | ProvidedCodeBlockValue>): void {
    const normalized = [...values].map(value => typeof value === 'string'
      ? { value: value.toLowerCase() }
      : { value: value.value.toLowerCase(), description: value.description });

    this.providedValues.set(key, new Set(normalized.map(value => value.value)));
    this.providedValueDescriptions.set(key, new Map(normalized.flatMap(value =>
      value.description ? [[value.value, value.description] as const] : [])));
  }

  getProvidedValueDescription(key: string, value: string): string | undefined {
    return this.providedValueDescriptions.get(key)?.get(value.toLowerCase());
  }

  getValueDetailForBlock(blockType: string, key: string, value: string): string | undefined {
    return this.highlightConfigs.get(blockType)?.valueDetails?.[key]?.[value];
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

  getIgnoredSettings(blockType: string, settings: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const config = this.highlightConfigs.get(blockType);

    if (!config) return {};
    const ignored: Record<string, unknown> = {};
    const walk = (value: unknown, keys: readonly string[], path: string, schemaPath: string): void => {
      if (Array.isArray(value)) {
        value.forEach((entry, index) => walk(entry, keys, `${path}[${index}]`, schemaPath));

        return;
      }

      if (!isRecord(value)) return;
      const known = new Map(keys.map(key => [normalizePropertyName(key), key]));

      for (const [key, entry] of Object.entries(value)) {
        const entryPath = path ? `${path}.${key}` : key;
        const canonical = known.get(normalizePropertyName(key));

        if (!canonical) {
          ignored[entryPath] = entry;
          continue;
        }

        const childPath = schemaPath ? `${schemaPath}.${canonical}` : canonical;
        const nested = config.nestedKeys?.[childPath] ?? config.nestedKeys?.[canonical];

        if (nested) walk(entry, nested.map(definition => definition.name), entryPath, childPath);
      }
    };

    walk(settings, config.rootKeys ?? config.validKeys, '', '');

    return ignored;
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
    this.providedValues.clear();
    this.providedValueDescriptions.clear();
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

  const valueDetails: Record<string, Record<string, string>> = { ...(existing.valueDetails ?? {}) };

  for (const [key, details] of Object.entries(incoming.valueDetails ?? {})) {
    valueDetails[key] = { ...(valueDetails[key] ?? {}), ...details };
  }

  return {
    ...existing,
    validKeys: [...new Set([...existing.validKeys, ...incoming.validKeys])],
    rootKeys: [...new Set([...(existing.rootKeys ?? existing.validKeys), ...(incoming.rootKeys ?? [])])],
    knownValues,
    valueDetails,
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
  { name: "style", values: "streets, satellite, terrain, outdoors (varies by provider)" },
  { name: "initialZoom", values: "auto, 10, 14, 18" },
  { name: "initialCenter", description: "Initial map center as lat,lng", values: "41.408, -75.662" },
  { name: "minZoom", values: "0, 3, 5" }
];

const COMMON_QUERY_PARAMS: ParameterDefinition[] = [
  { name: "dataview", values: { examples: ["FROM \"folder\" WHERE location"] } },
  { name: "query", values: "SELECT n.path FROM notes n..." },
  { name: "places", description: "A list of linked files and manual place properties", values: { examples: ["YAML list"] } }
];

export const MAP_KEYS = ['mapProvider', 'style', 'initialZoom', 'initialCenter', 'minZoom'];
export const QUERY_KEYS_HIGHLIGHT = ['query', 'dataview'];

const OVERLAY_KEYS = ['overlays'];
const STRUCTURED_OVERLAY_KEYS = ['path', 'bounds', 'corners', 'tiles', 'url', 'tileJson', 'preset', 'sourceLayer', 'sourceLayers', 'type', 'layerType', 'style', 'hoverStyle', 'popup', 'attribution', 'filter', 'textField', 'symbolPlacement', 'sprite', 'icon', 'visible'];

const PLACES_ROOT_KEYS = [
  ...COMMON_KEYS, ...MAP_KEYS, ...QUERY_KEYS_HIGHLIGHT,
  'places', 'radius', 'location',
  'showLabels', 'showCurrentDevicePosition', 'labelTemplate', 'iconRotation', 'iconImage', 'markerRenderer', 'legend',
  'popup',
  'markerMinZoom', 'markerMaxZoom', 'labelMinZoom', 'labelMaxZoom',
  'trackMinZoom', 'trackMaxZoom', 'overlayMinZoom', 'overlayMaxZoom',
  'clusterThreshold', 'clusterGeoJsonOverlays', 'clusterStyle', 'heatmapColorScheme', 'iconImageDetail',
  ...OVERLAY_KEYS,
  'css', 'iconStyles', 'iconImageStyles', 'labelStyles', 'markerFilter',
  'routeProvider', 'directions', 'isochrones',
  'routeLabelTemplate', 'metricLabels', 'legLabelTemplate',
  'waypointLabelTemplate',
  'queryParameters', 'queryParametersPosition', 'queryParametersLayout', 'queryParametersCollapsed', 'track', 'selection',
  'tools',
  'poiDiscovery', 'pitch', 'terrain', 'showHelpWithEmptyMap', 'debug',
  'fromTemplate', 'defaultTemplate',
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
  { name: "dashArray", description: "Comma-separated dash and gap lengths in multiples of line width, e.g. 2,5" },
  { name: "fillColor", description: "Polygon or circle fill color" },
  { name: "fillOpacity", description: "Polygon fill opacity, 0-1" },
  { name: "circleRadius", description: "Circle radius in pixels" },
  { name: "radius", description: "Circle radius in pixels (alias for circleRadius)" },
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
// style all complete (and never squiggle) from one shared set.
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
  { name: "preset", description: "A vector tileset an installed extension supplies, in place of tiles or url. sourceLayers picks among its layers; style, filter, popup, and zoom override its own" },
  { name: "tiles", description: "Vector tile URL template with {z}/{x}/{y}" },
  { name: "url", description: "TileJSON URL supplying the tile source" },
  { name: "tileJson", description: "true marks a tiles address as a TileJSON document when it does not end in .json; url entries are TileJSON already" },
  { name: "sourceLayer", description: "Source layer name inside the tiles" },
  { name: "sourceLayers", description: "Source layer names inside the tiles", apply: "sourceLayers:\n  - " },
  { name: "layerType", description: "Layer rendering type: line, fill, circle, or symbol (labels)" },
  { name: "style", description: "Normal feature style", apply: "style:\n  color: " },
  { name: "hoverStyle", description: "Style overrides for the feature under the pointer", apply: "hoverStyle:\n  color: " },
  { name: "popup", description: "Popup body sections for a clicked feature; without it, features do not answer clicks", apply: "popup:\n  content:\n    - renderer: knap\n      options:\n        templateFile: Places Templates/Popup.knap.md" },
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
  { name: "path", description: "Vault GeoJSON, GPX, FIT, CSV, or note path" },
  { name: "labelTemplate", description: "Label template resolved against overlay features" },
  { name: "waypointLabelTemplate", description: "GPX waypoint and route endpoint labels; defaults to the waypoint name, or empty to hide" },
  { name: "style", description: "Normal feature style", apply: "style:\n  color: " },
  { name: "hoverStyle", description: "Style overrides for the feature under the pointer", apply: "hoverStyle:\n  color: " },
  { name: "popup", description: "Popup body sections for this overlay", apply: "popup:\n  content:\n    - renderer: knap\n      options:\n        templateFile: Places Templates/Popup.knap.md" },
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
  popup: [
    { name: "content", description: "Ordered renderer and note sections", apply: "content:\n  - renderer: knap\n    options:\n      templateFile: Places Templates/Popup.knap.md" },
  ],
  content: [
    { name: "note", description: "Source note body" },
    { name: "renderer", description: "Knap or extension popup renderer" },
    { name: "options", apply: "options:\n  templateFile: Places Templates/Popup.knap.md" },
  ],
  'content.options': [
    { name: "templateFile", description: "Vault Knap template file for renderer: knap", apply: "templateFile: Places Templates/Popup.knap.md" },
  ],
  style: ALL_STYLE_NESTED_KEYS,
  hoverStyle: ALL_STYLE_NESTED_KEYS,
  'directions.style': OVERLAY_STYLE_NESTED_KEYS.filter(key => ['color', 'strokeWidth', 'strokeOpacity'].includes(key.name)),
  'isochrones.style': ALL_STYLE_NESTED_KEYS.filter(key => ['colors', 'fillOpacity', 'strokeWidth', 'strokeOpacity'].includes(key.name)),
  terrain: [
    { name: "provider", description: "DEM source enabling 3D terrain and relief; accepts an installed provider, aws, or a tile URL" },
    { name: "reliefProvider", description: "DEM source for hillshade and color relief on a flat map" },
    { name: "exaggeration", description: "Vertical scale as a constant or a zoom curve of @z stops; defaults to 1.4" },
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
    { name: "colors", description: "Elevation-to-color ramp: a preset name (hypsometric, viridis, spectral, grayscale) or a list of `<elevation in meters>: <color>` entries. Unset uses the default hypsometric tint.", apply: "colors: viridis" },
  ],
  track: [
    { name: "style", description: "Line width, solid/dashed, color, opacity; optional semicolon and outline style. Unspecified values inherit.", apply: 'style: "4 solid red"' },
    { name: "directionArrows", description: "Direction arrow scale on MapLibre tracks (0 disables, 1 = default)" },
    { name: "details", description: "Clicked-point details presentation: popup or panel" },
    { name: "colorBy", description: "Color track lines by a metric" },
    { name: "outline", description: "Show an outline around track lines" },
    { name: "defaultVisibility", description: "Initial track visibility: hidden or visible; unset shows a single unclustered track automatically" },
    { name: "gradeWindow", description: "Span the rolling map grade is measured over: a distance such as 100ft or 50m" },
    { name: "gradeDistance", description: "Grade averaging distance in feet; gradeWindow takes precedence" },
    { name: "speedWindow", description: "Span speed and pace are averaged over: a distance such as 200m or 0.25mi, or a time such as 30s" },
    { name: "selection", description: "Parameters written by track and point selection", apply: "selection:\n  trackParameter: selected\n  pointParameter: selectedPoint" },
    { name: "labels", description: "Track start, midpoint, and end labels", apply: "labels:\n  visibility: all" },
  ],
  selection: [
    { name: "itemParameter", description: "Parameter receiving the selected item id or path" },
    { name: "trackParameter", description: "Parameter receiving the selected track path" },
    { name: "pointParameter", description: "Location parameter receiving the exact selected point" },
    { name: "channel", description: "Shared selection channel exposed to installed Places extensions (default: primary)" },
    { name: "viewportParameter", description: "Base name for note-scoped parameters carrying this map's viewport: view publishes viewNorth, viewSouth, viewEast, viewWest and viewZoom for any block in the note to query" },
  ],
  'track.selection': [
    { name: 'trackParameter' },
    { name: 'pointParameter' },
  ],
  routes: [
    { name: 'waypoints', description: 'Ordered waypoint notes or coordinates' },
    { name: 'query', description: 'Query returning ordered waypoints' },
  ],
  labels: [
    { name: "visibility", description: "Visible track labels: all, none, start, midpoint, end, or a comma-separated combination" },
    { name: "start" },
    { name: "midpoint" },
    { name: "end" },
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
    { name: "routes", description: "Structured route entries", apply: "routes:\n  - waypoints:\n      - \"[[Poor Richards]]\"\n      - \"[[Alfredos Pizza Cafe]]\"" },
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
  places: [{ label: "location", insert: "location: 41.408, -75.662\n  name: ", description: "Add a manual place" }],
  routes: [
    { label: "waypoints", insert: "waypoints:\n    - \n    - ", description: "Route through an explicit list of waypoint notes or coordinates" },
    { label: "query", insert: "query: SELECT * FROM places WHERE path IN ({this.outgoingLinks}) ORDER BY title", description: "Route through places returned by VaultQuery" },
    { label: "waypoints from current note", insert: "waypoints:\n    - \"{this}\"\n    - ", description: "Route from this note to a destination" },
  ],
  content: [
    { label: "note", insert: "note", description: "Source note body" },
    { label: "renderer", insert: "renderer: ", description: "Knap or extension popup renderer" },
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
  'waypoints',        
]));

const PLACES_BLOCK_KNOWN_VALUES = {
  clusterGeoJsonOverlays: ['true', 'false'],
  clusterStyle: ['circles', 'heatmap'],
  heatmapColorScheme: Object.keys(HEATMAP_COLOR_PRESETS),
  iconImageDetail: ['standard', 'sharp', 'maximum'],
  defaultTemplate: ['false'],
  showLabels: ['true', 'false'],
  showCurrentDevicePosition: ['true', 'false'],
  details: ['popup', 'panel'],
  colorBy: [...TRACK_COLOR_BY_MODES],
  outline: ['true', 'false'],
  defaultVisibility: ['hidden', 'visible'],
  shapeMatch: ['map_snap', 'edge_walk', 'walk_or_snap'],
  wayDetails: ['true', 'false'],
  tidy: ['true', 'false'],
  timestamps: ['true', 'false'],
  visibility: ['all', 'none', 'start', 'midpoint', 'end', 'mid', 'middle'],
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
  showOnMap: ['true', 'false'],
  showValue: ['true', 'false'],
  type: ['int', 'float', 'string', 'date', 'datetime', 'time', 'boolean', 'enum', 'list', 'location', 'geodata', 'image', 'vector-tile'],
  layerType: ['line', 'fill', 'circle', 'symbol'],
  control: ['slider', 'range', 'number', 'text', 'combobox', 'dropdown', 'segmented', 'toggle', 'date', 'datetime', 'time', 'multiselect', 'location', 'stops', 'custom'],
  scale: ['linear', 'log'],
};

const PLACES_BLOCK_DEFINITION: CodeBlockDefinition = {
  type: "places",
  description: "Map with markers, paths, and overlays",
  parameters: [
      { name: "fromTemplate", description: "Inherit settings from one or more template notes.", values: "[[Base Map]]" },
      { name: "defaultTemplate", description: "Set false to skip the vault-wide Default template setting for this block. A block's own fromTemplate and keys still apply.", values: { choices: ["false"] } },
      ...COMMON_SIZE_PARAMS,
      ...COMMON_MAP_PARAMS,
      ...COMMON_QUERY_PARAMS,
      { name: "showLabels", description: "Show each marker name beside its icon", values: { choices: ["true", "false"], default: "true" } },
      { name: "showCurrentDevicePosition", description: "Available on mobile.", values: { choices: ["true", "false"], default: "false" } },
      { name: "popup", description: "Marker popup body sections", values: "content:\n  - renderer: knap\n    options:\n      templateFile: Places Templates/Popup.knap.md\n  - note" },
      ...['marker', 'label', 'track', 'overlay'].flatMap(target => [
        { name: `${target}MinZoom`, description: `Minimum zoom (0-24) for ${target} visibility. Also supported in note properties and query columns.`, values: { examples: ["0", "12", "24"] } },
        { name: `${target}MaxZoom`, description: `Maximum zoom (0-24) for ${target} visibility. Also supported in note properties and query columns.`, values: { examples: ["0", "12", "24"] } },
      ]),
      { name: "markerFilter", description: "Filter markers and labels by metadata conditions; a list keeps matches to any rule", values: "tag IN {parameter.show}" },
      { name: "iconRotation", description: "Degrees clockwise from north; accepts a number or a per-place template", values: "45, {this.wind_direction_10m}, {(this.bearing + 270) % 360}" },
      { name: "iconImageStyles", description: "Conditional picture-marker styles; accepts iconStyles rule syntax", values: "condition => css-properties" },
      { name: "iconImage", description: "Picture marker from a path, URL, or per-place template; missing images retain the glyph", values: { examples: ["{this.path}", "02 - Overlays/scranton-1889-usgs-topo.jpg"] } },
      { name: "markerRenderer", description: "MapLibre markers; native is the default, HTML supports arbitrary marker CSS", values: { choices: ["native", "html"], default: "native" } },
      { name: "track", description: "Track rendering, details, labels, and shared selection parameters.", values: "directionArrows: 1\n  details: panel\n  selection:\n    trackParameter: selected\n    pointParameter: selectedPoint" },
      { name: "selection", description: "Parameters for selected items, track points, and the map viewport", values: "itemParameter: selectedItem\n  pointParameter: selectedPoint\n  viewportParameter: view" },
      { name: "legend", description: "Show color legend for elevation/grade coloring", values: { choices: ["hidden", "top", "bottom"], default: "hidden" } },
      { name: "overlays", description: "Overlays as an expanded list; entry kind is inferred. Supports GeoJSON, GPX, FIT, CSV, and note paths, plus image and vector tile entries.", values: { examples: ["- path: 02 - Overlays/scranton-neighborhoods.geojson\n  labelTemplate: \"{this.name}\"\n  minZoom: 10"] } },
      { name: "routeProvider", description: "Default route service for all directions/isochrones in this block. Falls back to the map provider's own service when omitted.", values: "any installed route provider" },
      { name: "directions", description: "Route overlays; each route specifies waypoints or a query", values: "- mode: drive\n  routes:\n    - waypoints:\n        - \"[[Poor Richards]]\"\n        - \"[[Alfredos Pizza Cafe]]\"" },
      { name: "isochrones", description: "Reachable-area overlays with time or distance ranges", values: "- mode: walk\n  ranges:\n    - 15 min\n    - 5 mi\n  centers:\n    - \"[[Dunder Mifflin Scranton]]\"" },
      { name: "name", description: "Optional name for a directions or isochrone group.", values: { examples: ["bike route"] } },
      { name: "provider", description: "Route service for one directions/isochrones group when nested under those settings. Overrides routeProvider.", values: "any installed route provider" },
      { name: "cache", description: `Set inside a directions/isochrones group. ${CACHE_PARAMETER_DESCRIPTION}`, values: CACHE_PARAMETER_VALUES },
      { name: "mode", description: "Travel mode for directions/isochrones when nested under those settings", values: { choices: ["drive", "walk", "bike"], default: "drive" } },
      { name: "routes", description: "Structured route mappings nested under directions. Each entry holds either a `waypoints` list or a `query`, not both.", values: "- waypoints:\n    - \"[[Poor Richards]]\"\n    - \"[[Dunder Mifflin Scranton]]\"\n    - \"[[Alfredos Pizza Cafe]]\"" },
      { name: "optimize", description: "When true, reorder intermediate direction stops if the provider supports route optimization", values: { examples: ["false", "true"], default: "false" } },
      { name: "metricLabels", description: "Directions metric labels to render: total route, each leg between stops, both, or none.", values: "**total**, legs, both, none" },
      { name: "color", description: "Directions route line color", values: "\"#2563eb\"" },
      { name: "routeLabelTemplate", description: "Labels resolved against generated route properties", values: "{this.distance_text} · {this.duration_text}" },
      { name: "legLabelTemplate", description: "Labels resolved against properties of each route leg", values: "{this.from_name} → {this.to_name}: {this.distance_text} · {this.duration_text}" },
      { name: "waypointLabelTemplate", description: "Route waypoint and GPX waypoint labels; empty hides labels", values: "{this.role_label}: {this.name}" },
      { name: "ranges", description: "Positive isochrone contours with a time or distance unit. Time and distance values may be mixed.", values: "- 15 min\n- 30 min\n- 5 mi" },
      { name: "centers", description: "Isochrone center points as a list of note references, coordinates, or named coordinates.", values: "- \"[[Schrute Farms]]\"\n- \"Downtown Scranton: 41.408, -75.662\"" },
      { name: "polygons", description: "Render isochrones as polygons instead of lines when provider supports it", values: { choices: ["true", "false"], default: "true" } },
      { name: "traffic", description: "Account for traffic on driving directions and isochrones. Honored by Mapbox and Geoapify; ignored by other providers and non-drive modes. Bypasses the overlay cache.", values: { choices: ["false", "true"], default: "false" } },
      { name: "colors", description: "List of quoted colors for isochrone polygons. Colors repeat when there are more contours than colors.", values: "- \"#4f46e5\"\n- \"#0891b2\"\n- \"#16a34a\"" },
      { name: "fillOpacity", description: "Isochrone polygon fill opacity. Accepts decimals from 0 to 1 or percentages.", values: "0.14 or 14%" },
      { name: "strokeOpacity", description: "Directions route or isochrone contour line opacity. Accepts decimals from 0 to 1 or percentages.", values: "0.85 or 85%" },
      { name: "strokeWidth", description: "Directions route or isochrone contour line width in pixels.", values: "2" },
      { name: "maxZoom", description: "Maximum zoom where an isochrone overlay group is visible.", values: "8, 12, 16" },
      { name: "clusterThreshold", description: "Override marker clustering for this map. 0 disables clustering; positive numbers cluster when point count reaches that threshold.", values: "0, 100, 500" },
      { name: "clusterGeoJsonOverlays", description: "Include GeoJSON overlay point features in marker clustering for this map.", values: { choices: ["true", "false"], default: "true" } },
      { name: "clusterStyle", description: "Draw clusters as counted circles or as a density heatmap. Zoom drills into either.", values: { choices: ["circles", "heatmap"], default: "circles" } },
      { name: "heatmapColorScheme", description: "Gradient for clusterStyle: heatmap. Accepts preset names or comma-separated hex colors.", values: { choices: Object.keys(HEATMAP_COLOR_PRESETS), default: DEFAULT_DENSITY_COLOR_SCHEME } },
      { name: "iconImageDetail", description: "Image pixel ratio for picture markers", values: { choices: ["standard", "sharp", "maximum"], default: "standard" } },
      { name: "css", description: "Raw CSS injected with the map. Marker selectors need HTML markers (Leaflet or markerRenderer: html); popup/legend/container selectors are supported on every provider.", values: { examples: [".places-marker-icon { opacity: 0.7; }"] } },
      { name: "iconStyles", description: "Conditional icon styling rules. Native markers translate a supported property subset; the rest needs markerRenderer: html.", values: "condition => css-properties" },
      { name: "labelStyles", description: "Conditional label styling rules. Native labels translate a property subset; full CSS applies on Leaflet only.", values: "condition => css-properties" },
      { name: "labelTemplate", description: "Template for marker label text", values: "{this.filename}, {h.before(this.name, '(')}" },
      { name: "queryParameters", description: "Controls for {parameter.name} values; changes refresh affected data", values: "- name: days\n  type: int\n  control: slider\n  min: 0\n  max: 100\n  default: 7" },
      { name: "queryParametersPosition", description: "Where the query parameter controls render relative to the map.", values: { choices: ["below", "above", "floating"], default: "below" } },
      { name: "queryParametersLayout", description: "Whether the query parameter controls flow along a row or stack one per line.", values: { choices: ["horizontal", "vertical"], default: "horizontal" } },
      { name: "queryParametersCollapsed", description: "Initial state of the control strip's collapse toggle. A floating strip always has the toggle; declaring this adds it to an above or below strip too.", values: { choices: ["true", "false"], default: "false" } },
      { name: "tools", description: "Interactive map tools supplied by installed extensions", values: "playback:\n  track: \"[[Lake Scranton Weekend Run]]\"\n  duration: 60s" },
      { name: "control", description: "Input control for a query parameter, nested under queryParameters. Inferred from type when omitted.", values: { examples: ["slider", "range", "number", "text", "combobox", "dropdown", "segmented", "toggle", "date", "datetime", "time", "multiselect", "location", "stops"] } },
      { name: "label", description: "Display label for a query parameter control, nested under queryParameters. Defaults to the parameter name.", values: { examples: ["Days ahead"] } },
      { name: "default", description: "Initial value for a query parameter, nested under queryParameters. On a list parameter, all selects every option, including optionsQuery results.", values: { examples: ["7", "all"] } },
      { name: "options", description: "Allowed values for an enum or list query parameter, nested under queryParameters. Also suggestions for a combobox.", values: "[any, 🍕, 🍝]" },
      { name: "optionsQuery", description: "VaultQuery SQL whose first column supplies the options at render time, in query order. On a range control it supplies the limits instead: the column's smallest and largest number. Nested under queryParameters.", values: { examples: ["SELECT DISTINCT icon FROM places ORDER BY icon"] } },
      { name: "step", description: "Slider or number step for a numeric query parameter, nested under queryParameters.", values: { examples: ["1", "0.5"] } },
      { name: "scale", description: "Spacing of a range control's values along its slider, nested under queryParameters. log spaces them by ratio, giving values near min most of the slider.", values: { choices: ["linear", "log"], default: "linear" } },
      { name: "range", description: "Shorthand for min and max on a numeric query parameter, nested under queryParameters.", values: { examples: ["[0, 100]"] } },
      { name: "showOnMap", description: "Show a location parameter or every stops entry as a map marker.", values: { choices: ["false", "true"], default: "false" } },
      { name: "icon", description: "Marker icon for a parameter shown on the map. Declaring it enables showOnMap.", values: { examples: ["🎯"] } },
      { name: "icons", description: "Positional marker icons for a stops parameter. Declaring the list enables showOnMap.", values: { examples: ["[1️⃣, 2️⃣, 🏁]"] } },
      { name: "poiDiscovery", description: "Enable clicking map features to discover POIs", values: { choices: ["true", "false"], default: "true" } },
      { name: "pitch", description: "Allow tilting the map into an oblique 3D view (drag with right mouse / two fingers).", values: { examples: ["false", "true"], default: "false" } },
      { name: "terrain", description: "3D terrain, hillshade, and elevation tint", values: "provider: mapbox\n  exaggeration: 2\n  hillshade:\n    intensity: 0.8" },
      { name: "showHelpWithEmptyMap", description: "Show help below an empty map. Overrides the global setting", values: { choices: ["true", "false"], default: "true" } },
      { name: "debug", description: "Map diagnostics or settings and parameter tables; accepts a comma-separated list", values: { choices: ["false", "true", "settings", "parameters"], default: "false" } }
  ]
};

export const MAIN_PLUGIN_DEFINITIONS: CodeBlockDefinition[] = [
  PLACES_BLOCK_DEFINITION,
  {
    type: "places-parameters",
    description: "Note-scoped parameter controls shared by every block in the note",
    parameters: [
      { name: "queryParameters", description: "Parameter definitions; every block in the note resolves them as {parameter.name}. Block-local declarations shadow them by name.", values: "- name: days\n  type: int\n  control: slider\n  min: 0\n  max: 100\n  default: 7" },
      { name: "queryParametersLayout", description: "Whether the controls flow along a row or stack one per line.", values: { choices: ["horizontal", "vertical"], default: "horizontal" } },
      { name: "queryParametersCollapsed", description: "Declaring this adds a collapse toggle to the strip, starting collapsed when true.", values: { choices: ["true", "false"] } },
    ],
  },
  {
    type: "places-chart",
    description: "Elevation and track analysis charts",
    parameters: [
      ...COMMON_SIZE_PARAMS,
      { name: "chartType", values: { choices: ["elevation", "elevation-grade", "elevation-time", "speed", "speed-time", "pace", "pace-time", "grade"], default: "elevation" } },
      { name: "track1", description: "First track for comparison (or single track), as a track note or track file path", values: "[[Morning Run - Monday]]" },
      { name: "track2", description: "Second track for comparison, as a track note or track file path", values: "[[Morning Run - Tuesday]]" },
      { name: "position", description: "Coordinate to highlight on a single-track chart", values: { examples: ["{parameter.selectedPoint}"] } },
      { name: "selection", description: "Typed selection channel shared with maps and other charts", values: "channel: primary" },
      { name: "title", description: "Heading above the chart. Omit for no title", values: { examples: ["\"Elevation Profile\"", "\"My Hike\""] } },
      { name: "fillArea", values: { choices: ["true", "false"], default: "true" } },
      { name: "colorBy", description: "Color chart fill by data", values: { choices: ["none", "elevation", "grade"], default: "none" } },
      { name: "gradeWindow", description: "Span the rolling grade is measured over", values: "**100ft**, 50m, 0.1mi, 10min" },
      { name: "speedWindow", description: "Span speed and pace are averaged over", values: "**200m**, 500ft, 0.25mi, 30s, 5min" },
      { name: "legend", description: "Show color legend for grade/elevation coloring", values: { choices: ["hidden", "top", "bottom"], default: "hidden" } },
      { name: "showGrid", values: { choices: ["true", "false"], default: "true" } },
      { name: "showPoints", values: { choices: ["false", "true"], default: "false" } },
      { name: "smoothing", values: { choices: ["true", "false"], default: "true" } },
      { name: "stats", values: { examples: ["elevation", "time", "speed", "pace", "distance", "points"] } },
      { name: "axisColor", values: "**#666**, #000, rgb()" },
      { name: "elevationColor", values: "**#2196F3**" },
      { name: "speedColor", values: "**#ff7f00**" },
      { name: "paceColor", values: "**#dc3545**" },
      { name: "gradeColor", values: "**#ff7f00**" },
      { name: "fontSize", values: "**12**, 10, 14, 16" },
      { name: "autorefresh", description: "Re-render when the vault index changes", values: { choices: ["true", "false"], default: "(global setting)" } }
    ]
  },
  {
    type: "places-heatmap",
    description: "Frequency analysis and route heatmaps",
    parameters: [
      ...COMMON_SIZE_PARAMS,
      ...COMMON_MAP_PARAMS,
      ...COMMON_QUERY_PARAMS,
      { name: "strategy", values: { choices: ["track-corridor", "density-cloud", "opacity-stacking"], default: "track-corridor" } },
      { name: "gridSize", description: "Grid cell size (feet/meters)", values: "**100**, 50, 200, 500" },
      { name: "minFrequency", description: "Minimum number of tracks required to display a segment", values: "**2**, 1, 3, 5" },
      { name: "maxSegments", description: "Maximum number of rendered segments", values: "**100**, 50, 200" },
      { name: "colorScheme", description: `Defaults to ${DEFAULT_DENSITY_COLOR_SCHEME} for density-cloud and yellow-to-red for routes. Accepts preset names or comma-separated hex colors.`, values: `${Object.keys(HEATMAP_COLOR_PRESETS).join(', ')}, or a custom gradient`, multiValue: true },
      { name: "lineWidth", description: "Line width (pixels)", values: "**3**, 2, 5, 10" },
      { name: "lineStyle", description: "solid, dashed, or dash lengths in multiples of line width", values: "**solid**, dashed, \"2,5\", \"2 5\"" },
      { name: "lineOpacity", description: "One opacity for every segment, overriding the frequency-driven range", values: "0.0 - 1.0" },
      { name: "minOpacity", description: "Minimum opacity (opacity-stacking)", values: "**0.01**, 0.05, 0.1" },
      { name: "maxOpacity", description: "Maximum opacity at max overlap", values: "**1.0**, 0.8, 0.5" },
      { name: "legendLocation", values: { choices: ["hidden", "top", "bottom"], default: "hidden" } },
      { name: "infoLocation", values: { choices: ["hidden", "top", "bottom"], default: "hidden" } },
      { name: "autorefresh", description: "Re-render when the vault index changes", values: { choices: ["true", "false"], default: "(global setting)" } }
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
      { name: "maxResults", description: "Maximum tracks to show; omit for all matches", values: "5, 10, 20" },
      { name: "radius", description: "Search radius (miles/km)", values: "**note's Distance**, 1.0, 2, 5, 10" },
      { name: "location", description: "Coordinates for point-based search", values: "**note's Location**, 41.408,-75.662" },
      { name: "showPersonalBest", description: "Mark the fastest run of each matched route", values: { choices: ["false", "true"], default: "false" } },
      { name: "showSpeedTime", description: "Show speed/duration columns", values: { choices: ["false", "true"], default: "false" } },
      { name: "autorefresh", description: "Re-render when the vault index changes", values: { choices: ["true", "false"], default: "(global setting)" } }
    ]
  },
  {
    type: "places-compare",
    description: "Compare two tracks side-by-side",
    parameters: [
      { name: "track1", values: "[[Lake Scranton Weekend Run]]" },
      { name: "track2", values: "[[Fun Run Training Route]]" },
      { name: "tolerance", description: "Overlap detection distance (m/ft)", values: "**50**, 20, 100" },
      { name: "height", values: "**300px**, 400px, 500px" },
      { name: "mapProvider", values: "any installed map provider" },
      { name: "showMiniMap", values: { choices: ["true", "false"], default: "true" } },
      { name: "showMetrics", description: "Show the distance, elevation, and overlap comparison tables", values: { choices: ["true", "false"], default: "true" } },
      { name: "autorefresh", description: "Re-render when the vault index changes", values: { choices: ["true", "false"], default: "(global setting)" } }
    ]
  },
  {
    type: "places-snap",
    description: "Snap a track to the closed road or trail.",
    parameters: [
      { name: "track", description: "Track note or file to snap. Defaults to the current note.", values: "[[Morning Run - Monday]]" },
      { name: "provider", description: "Snap service to use. Defaults to the first available provider with snap support.", values: "any installed snap provider" },
      { name: "mode", description: "Travel mode. Decides which ways are eligible: walk and bike include footpaths, tracks, and cycleways, drive is roads only", values: { choices: ["drive", "walk", "bike"], default: "drive" } },
      { name: "radius", description: "Search radius around each point. A bare number uses the units setting; an explicit unit overrides it", values: { examples: ["300m", "500m", "0.2mi"], default: "300m" } },
      { name: "costing", description: "Valhalla costing name, overriding the one mode resolves to. Reaches costings mode cannot express", values: { examples: ["pedestrian", "bicycle", "auto", "truck", "bus", "motor_scooter"] } },
      { name: "costingOptions", description: "Options for the effective costing, passed through verbatim. Valhalla-based providers only", values: "walkway_factor: 0.5" },
      { name: "timestamps", description: "Send recorded point times to the matcher. Enabled when the track has timestamps", values: { examples: ["true", "false"], default: "true" } },
      { name: "tidy", description: "Collapse near-duplicate and stationary points before matching. Mapbox only", values: { examples: ["true", "false"], default: "false" } },
      { name: "exclude", description: "Way classes to keep the match off. Mapbox only", values: { examples: ["motorway", "toll", "ferry"] } },
      { name: "shapeMatch", description: "Valhalla matching strategy. edge_walk suits a trace that already follows the network", values: { examples: ["map_snap", "edge_walk", "walk_or_snap"], default: "map_snap" } },
      { name: "traceOptions", description: "Valhalla trace options tuning the matcher itself, passed through verbatim. Valhalla measures these in meters regardless of the units setting", values: "search_radius: 35\n  gps_accuracy: 8" },
      { name: "wayDetails", description: "Report the named ways and surfaces the match ran along. Valhalla-based providers only", values: { examples: ["true", "false"], default: "false" } },
      { name: "mapProvider", description: "Map used for the preview. Defaults to the global default provider.", values: "any installed map provider" },
      { name: "height", values: "**400px**, 500px" },
    ],
  },
  {
    type: "places-elevation",
    description: "Replace or add elevation data for a track.",
    parameters: [
      { name: "track", description: "Track note or file to populate. Defaults to the current note.", values: "[[Morning Run - Monday]]" },
      { name: "provider", description: "Elevation service to use. Defaults to the first available provider with elevation support.", values: "any installed elevation provider" },
      { name: "height", values: "**320px**, 400px" },
      { name: "width", values: "**100%**, 800px" },
      { name: "title", description: "Heading above the chart. Omit for no title", values: { examples: ["\"Elevation Replacement Preview\""] } },
      { name: "showGrid", values: { choices: ["true", "false"], default: "true" } },
      { name: "showPoints", values: { choices: ["false", "true"], default: "false" } },
      { name: "smoothing", values: { choices: ["true", "false"], default: "true" } },
      { name: "fillArea", description: "Shade the area under chart lines", values: { choices: ["false", "true"], default: "false" } },
      { name: "autorefresh", description: "Re-render when the vault index changes", values: { choices: ["true", "false"], default: "(global setting)" } }
    ],
  },
  {
    type: "places-image-align",
    description: "Interactive image overlay alignment tool",
    parameters: [
      { name: "mapProvider", values: "any installed map provider" },
      { name: "overlays", description: "One image to align, plus optional reference tracks or geodata beneath it, in any order", values: { examples: ["- path: 02 - Overlays/scranton-1889-usgs-topo.jpg\n  bounds: 41.25,-75.75,41.5,-75.5"] } },
      { name: "height", values: "**500px**, 400px, 600px" },
      { name: "width", values: "**100%**, 800px, 90vw" },
      { name: "style", values: "streets, satellite, terrain, outdoors" },
      { name: "initialZoom", values: "**auto**, 10, 14, 18" },
      { name: "initialCenter", description: "Initial map center (lat,lng)", values: "**auto**, 41.408, -75.662" }
    ]
  },
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
    knownValues: { ...DATA_BLOCK_PARAMETER_KNOWN_VALUES, poiDiscovery: ['true', 'false'] },
    nestedKeys: DATA_BLOCK_PARAMETER_NESTED_KEYS,
  },
  {
    blockType: 'places-elevation',
    validKeys: [...COMMON_KEYS, 'track', 'provider', 'title', 'showGrid', 'showPoints', 'smoothing', 'fillArea', 'autorefresh', 'queryParameters', ...DATA_BLOCK_PARAMETER_STRIP_KEYS],
    knownValues: DATA_BLOCK_PARAMETER_KNOWN_VALUES,
    nestedKeys: DATA_BLOCK_PARAMETER_NESTED_KEYS,
  },
  {
    blockType: 'places-chart',
    validKeys: [...COMMON_KEYS, 'chartType', 'track1', 'track2', 'position', 'selection', 'title', 'showGrid', 'showPoints', 'smoothing', 'fillArea', 'axisColor', 'elevationColor', 'speedColor', 'paceColor', 'gradeColor', 'fontSize', 'stats', 'colorBy', 'gradeWindow', 'gradeDistance', 'speedWindow', 'legend', 'autorefresh', 'queryParameters', ...DATA_BLOCK_PARAMETER_STRIP_KEYS],
    rootKeys: [...COMMON_KEYS, 'chartType', 'track1', 'track2', 'position', 'selection', 'title', 'showGrid', 'showPoints', 'smoothing', 'fillArea', 'axisColor', 'elevationColor', 'speedColor', 'paceColor', 'gradeColor', 'fontSize', 'stats', 'colorBy', 'gradeWindow', 'gradeDistance', 'speedWindow', 'legend', 'autorefresh', 'queryParameters', ...DATA_BLOCK_PARAMETER_STRIP_KEYS],
    nestedKeys: { ...DATA_BLOCK_PARAMETER_NESTED_KEYS, selection: PLACES_NESTED_KEYS.selection },
    knownValues: DATA_BLOCK_PARAMETER_KNOWN_VALUES
  },
  {
    blockType: 'places-heatmap',
    validKeys: [...COMMON_KEYS, ...MAP_KEYS, ...QUERY_KEYS_HIGHLIGHT, 'strategy', 'gridSize', 'minFrequency', 'maxSegments', 'colorScheme', 'lineWidth', 'lineStyle', 'minOpacity', 'maxOpacity', 'lineOpacity', 'legendLocation', 'infoLocation', 'poiDiscovery', 'autorefresh', 'queryParameters', ...DATA_BLOCK_PARAMETER_STRIP_KEYS],
    nestedKeys: DATA_BLOCK_PARAMETER_NESTED_KEYS,
    knownValues: {
      ...DATA_BLOCK_PARAMETER_KNOWN_VALUES,
      colorScheme: Object.keys(HEATMAP_COLOR_PRESETS),
      poiDiscovery: ['true', 'false'],
    }
  },
  {
    blockType: 'places-similar',
    validKeys: ['minSimilarity', 'minOverlap', 'tolerance', 'overlapTolerance', 'maxResults', 'radius', 'location', 'showPersonalBest', 'showSpeedTime', 'autorefresh', 'queryParameters', ...DATA_BLOCK_PARAMETER_STRIP_KEYS],
    nestedKeys: DATA_BLOCK_PARAMETER_NESTED_KEYS,
    knownValues: DATA_BLOCK_PARAMETER_KNOWN_VALUES
  },
  {
    blockType: 'places-compare',
    validKeys: ['track1', 'track2', 'tolerance', 'height', 'width', 'mapProvider', 'showMiniMap', 'showMetrics', 'style', 'poiDiscovery', 'autorefresh', 'queryParameters', ...DATA_BLOCK_PARAMETER_STRIP_KEYS],
    nestedKeys: DATA_BLOCK_PARAMETER_NESTED_KEYS,
    knownValues: {
      ...DATA_BLOCK_PARAMETER_KNOWN_VALUES,
      poiDiscovery: ['true', 'false'],
    }
  },
  {
    blockType: 'places-reference',
    validKeys: []   
  },
  {
    blockType: 'places-image-align',
    validKeys: ['mapProvider', 'overlays', 'path', 'type', 'bounds', 'corners', 'height', 'width', 'style', 'opacity', 'initialZoom', 'initialCenter', 'alignment', 'fit', 'points', 'pixel', 'latlng', 'enabled', 'imageSize',
      ...GEODATA_OVERLAY_NESTED_KEYS.map(key => key.name), ...OVERLAY_STYLE_NESTED_KEYS.map(key => key.name),
      ...PLACES_NESTED_KEYS.popup.map(key => key.name), ...PLACES_NESTED_KEYS.content.map(key => key.name)],
    rootKeys: ['mapProvider', 'overlays', 'height', 'width', 'style', 'initialZoom', 'initialCenter'],
    knownValues: { type: ['image', 'geodata'], fit: ['similarity', 'affine'], enabled: ['true', 'false'] },
    valueDetails: { fit: {
      similarity: 'Preserve proportions: move, rotate, and uniformly scale using at least two point pairs',
      affine: 'Allow stretching and skew using at least three non-collinear point pairs',
    } },
    nestedKeys: {
      overlays: unionNestedKeys([
        { name: "path", description: "Image to align, or reference GPX, FIT, CSV, GeoJSON, or recorded-track note" },
        { name: "type", description: "Optional kind override: image or geodata; normally inferred from the path" },
        { name: "bounds", description: "Axis-aligned georeference: swLat,swLng,neLat,neLng" },
        { name: "corners", description: "Four-corner georeference, clockwise from NW: nwLat,nwLng,neLat,neLng,seLat,seLng,swLat,swLng" },
        { name: "opacity", description: "Image overlay opacity, 0-1 (default: 1)" },
        { name: "alignment", description: "Point pairs for fitting this image" },
      ], GEODATA_OVERLAY_NESTED_KEYS),
      'overlays.alignment': [
        { name: 'fit', description: 'similarity preserves proportions; affine also permits stretching/skew' },
        { name: 'points', description: 'Matched original-image pixels and map locations' },
        { name: 'imageSize', description: 'Image dimensions [width, height]', apply: 'imageSize: [1000, 1000]' },
      ],
      'overlays.alignment.points': [
        { name: 'pixel', description: 'Image [x, y] measured from the top-left', apply: 'pixel: [0, 0]' },
        { name: 'latlng', description: 'Map location [latitude, longitude]', apply: 'latlng: [0, 0]' },
        { name: 'enabled', description: 'Include this pair when fitting (default: true)' },
      ],
      'overlays.style': OVERLAY_STYLE_NESTED_KEYS,
      'overlays.hoverStyle': OVERLAY_STYLE_NESTED_KEYS,
      popup: PLACES_NESTED_KEYS.popup,
      content: PLACES_NESTED_KEYS.content,
      'content.options': PLACES_NESTED_KEYS['content.options'],
    },
    listItemTemplates: {
      'overlays.alignment.points': [{ label: 'Point pair', insert: 'pixel: [0, 0]\n  latlng: [0, 0]', description: 'Match image pixels to latitude and longitude' }],
    },
  },
  { blockType: 'places-style', validKeys: PLACES_BLOCK_KEYS, rootKeys: PLACES_ROOT_KEYS, knownValues: PLACES_BLOCK_KNOWN_VALUES, nestedKeys: PLACES_NESTED_KEYS, listItemTemplates: PLACES_LIST_ITEM_TEMPLATES },
  { blockType: 'places-overlay', validKeys: PLACES_BLOCK_KEYS, rootKeys: PLACES_ROOT_KEYS, knownValues: PLACES_BLOCK_KNOWN_VALUES, nestedKeys: PLACES_NESTED_KEYS, listItemTemplates: PLACES_LIST_ITEM_TEMPLATES },
  { blockType: 'places-bases', validKeys: PLACES_BLOCK_KEYS, rootKeys: PLACES_ROOT_KEYS, knownValues: PLACES_BLOCK_KNOWN_VALUES, nestedKeys: PLACES_NESTED_KEYS, listItemTemplates: PLACES_LIST_ITEM_TEMPLATES },
  { blockType: 'places-template', validKeys: PLACES_BLOCK_KEYS, rootKeys: PLACES_ROOT_KEYS, knownValues: PLACES_BLOCK_KNOWN_VALUES, nestedKeys: PLACES_NESTED_KEYS, listItemTemplates: PLACES_LIST_ITEM_TEMPLATES }
];
