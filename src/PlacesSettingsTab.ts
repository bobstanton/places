import { getErrorMessage, scalarToString } from "places-shared/utils";
import { DEFAULT_SPEED_WINDOW, parseMetricWindow } from "places-shared/settings";
import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type { SettingDefinitionItem, SettingGroupItem } from "obsidian";
import { TileCache } from "places-shared/map";
import { parseTagFilterPatterns } from "./services/PlaceTagFilter";
import { DEFAULT_SETTINGS, DateParser } from "places-shared/settings";
import { type PlaceProviderExport, type ExtensionSettingsGroup } from "places-shared/services";
import { IPlacesUsageStats } from "./places-services/PlacesUsageStats";
import { PlacesStatsCalculator } from "./places-services/PlacesStatsCalculator";
import PlacesPlugin from "./main";

// Control keys of the form `tileCacheProvider:<name>` toggle one provider's tile-cache opt-out.
const TILE_PROVIDER_KEY_PREFIX = "tileCacheProvider:";

// Control keys of the form `extension:<plugin>:<key>` route to that extension's settings object.
const EXTENSION_KEY_PREFIX = "extension:";

function parseExtensionKey(key: string): { plugin: string; localKey: string } {
  const rest = key.slice(EXTENSION_KEY_PREFIX.length);
  const separator = rest.indexOf(":");
  return { plugin: rest.slice(0, separator), localKey: rest.slice(separator + 1) };
}

// Rewrites extension-local control keys to `extension:<plugin>:<key>` for the host tab to route reads and writes.
function namespaceExtensionItem(plugin: string, item: SettingDefinitionItem): SettingDefinitionItem {
  if ("control" in item && item.control) {
    return { ...item, control: { ...item.control, key: `${EXTENSION_KEY_PREFIX}${plugin}:${item.control.key}` } };
  }
  if ("type" in item && (item.type === "group" || item.type === "list")) {
    return { ...item, items: item.items?.map(child => namespaceExtensionItem(plugin, child) as SettingGroupItem) };
  }
  if ("type" in item && item.type === "page" && item.items) {
    return { ...item, items: item.items.map(child => namespaceExtensionItem(plugin, child)) };
  }
  return item;
}

const SPEED_WINDOW_PLACEHOLDER = "200m";
const GRADE_WINDOW_PLACEHOLDER = "100ft";

// Line-oriented textarea values stored as string arrays.
const LINE_LIST_KEYS = new Set(["poiFilterPatterns", "newPlaceTagFilterPatterns", "markerIconRules"]);

// The main settings tab, built on the declarative settings API (Obsidian
// 1.13+): every plain control is a definition: reading, persisting, and
// the global settings search all come from the framework. Imperative
// `render` rows remain only where the UI is custom (extension tabs, the
// cached-tiles panel, API usage statistics).
export class PlacesSettingsTab extends PluginSettingTab {
  constructor(app: App, private plugin: PlacesPlugin, private extensionSettingsGroups: Record<string, ExtensionSettingsGroup>) {
    super(app, plugin);
  }

  getControlValue(key: string): unknown {
    if (key.startsWith(EXTENSION_KEY_PREFIX)) {
      const { plugin, localKey } = parseExtensionKey(key);
      const group = this.extensionSettingsGroups[plugin];
      if (group?.getValue) return group.getValue(localKey);
      return PlacesPlugin.settings.extensionSettings[plugin]?.[localKey];
    }
    if (key.startsWith(TILE_PROVIDER_KEY_PREFIX)) {
      return PlacesPlugin.settings.tileCacheEnabledProviders[key.slice(TILE_PROVIDER_KEY_PREFIX.length)] !== false;
    }
    const settings = PlacesPlugin.settings as unknown as Record<string, unknown>;
    if (LINE_LIST_KEYS.has(key)) {
      return (settings[key] as string[]).join("\n");
    }
    if (key === "overlayCompressionLevel") {
      return String(settings[key]);
    }
    return settings[key];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    if (key.startsWith(EXTENSION_KEY_PREFIX)) {
      const { plugin, localKey } = parseExtensionKey(key);
      const group = this.extensionSettingsGroups[plugin];
      if (group?.setValue) {
        await group.setValue(localKey, value);
      } else {
        (PlacesPlugin.settings.extensionSettings[plugin] ??= {})[localKey] = scalarToString(value);
      }
      await PlacesPlugin.saveSettings();
      if (group?.updateOn?.includes(localKey)) this.update();
      return;
    }
    if (key.startsWith(TILE_PROVIDER_KEY_PREFIX)) {
      PlacesPlugin.settings.tileCacheEnabledProviders[key.slice(TILE_PROVIDER_KEY_PREFIX.length)] = value as boolean;
      PlacesPlugin.configureTileCache();
      await PlacesPlugin.saveSettings();
      return;
    }

    const settings = PlacesPlugin.settings as unknown as Record<string, unknown>;
    switch (key) {
      case "poiFilterPatterns":
      case "markerIconRules":
        settings[key] = String(value).split("\n").map(line => line.trimEnd()).filter(line => line.trim().length > 0);
        break;
      case "newPlaceTagFilterPatterns":
        settings[key] = parseTagFilterPatterns(String(value));
        break;
      case "speedWindow":
        settings[key] = String(value).trim() || SPEED_WINDOW_PLACEHOLDER;
        break;
      case "gradeWindow":
        settings[key] = String(value).trim() || GRADE_WINDOW_PLACEHOLDER;
        break;
      case "clusterThresholdDesktop":
      case "clusterThresholdMobile":
        settings[key] = Math.max(0, Math.trunc(Number(value) || 0));
        break;
      case "tileCacheDurationHoursDesktop":
      case "tileCacheDurationHoursMobile":
        settings[key] = Math.min(999, Math.max(0, Math.trunc(Number(value) || 0)));
        break;
      case "tileCacheMaxSizeMBDesktop":
        settings[key] = Math.max(1, Math.trunc(Number(value)) || DEFAULT_SETTINGS.tileCacheMaxSizeMBDesktop);
        break;
      case "tileCacheMaxSizeMBMobile":
        settings[key] = Math.max(1, Math.trunc(Number(value)) || DEFAULT_SETTINGS.tileCacheMaxSizeMBMobile);
        break;
      case "overlayCompressionLevel":
        settings[key] = Number(value);
        break;
      default:
        settings[key] = value;
    }

    await PlacesPlugin.saveSettings();

    if (key === "speedWindow" || key === "gradeWindow") {
      PlacesPlugin.applyMetricWindowSettings();
    }
    if (key.startsWith("tileCache")) {
      PlacesPlugin.configureTileCache();
      // Cache-size rows show only while their duration is non-zero.
      this.update();
    }
  }

  public getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      { type: "group", heading: "Note naming", items: this.noteNamingItems() },
      { type: "group", heading: "Map defaults", items: this.mapDefaultItems() },
      { type: "group", heading: "Marker clustering", items: this.clusteringItems() },
      { type: "group", heading: "File import", items: this.fileImportItems() },
      ...this.extensionItems(),
      { type: "group", heading: "Tile cache", items: this.tileCacheItems() },
      { type: "group", heading: "Debug", items: this.debugItems() },
      {
        type: "group",
        heading: "API usage statistics",
        items: [{
          name: "API usage statistics",
          searchable: false,
          render: (setting: Setting) => {
            setting.settingEl.empty();
            this.renderUsageStatistics(setting.settingEl);
          },
        }],
      },
    ];
  }

  private noteNamingItems(): SettingGroupItem[] {
    return [{
      name: "Place note name format",
      desc: "Format when updating a note with Place data (e.g., from search). Placeholders: ${name} ${city} ${state}",
      control: { type: "text", key: "noteNameFormat", placeholder: "${name} (${city})" },
    }];
  }

  private mapDefaultItems(): SettingGroupItem[] {
    const installedProviders = PlacesPlugin.getAllMapProviders().sort((a, b) => a.localeCompare(b));
    const providerOptions: Record<string, string> = { "": "First available" };
    for (const provider of installedProviders) {
      providerOptions[provider] = provider.charAt(0).toUpperCase() + provider.slice(1);
    }

    const metricWindowValidator = (placeholder: string) => (value: string): string | void => {
      const effective = value.trim() || placeholder;
      try {
        parseMetricWindow(effective, DEFAULT_SPEED_WINDOW);
      } catch (error) {
        return getErrorMessage(error);
      }
    };

    return [
      {
        name: "Default map provider",
        desc: "The map provider to use when mapProvider is not specified in a code block. Only shows installed providers.",
        control: { type: "dropdown", key: "defaultMapProvider", options: providerOptions, defaultValue: "" },
      },
      {
        name: "Unit system",
        desc: "Choose between imperial (miles, mph, feet) and metric (kilometers, kph, meters) units for distance, speed, and elevation measurements",
        control: {
          type: "dropdown",
          key: "units",
          options: { imperial: "Imperial (miles, mph, feet)", metric: "Metric (kilometers, kph, meters)" },
        },
      },
      {
        name: "Speed window",
        desc: "Span speed and pace are averaged over. A distance (200m, 500ft, 0.25mi) keeps the same spatial context at every speed; a time (30s, 5min) reads better across stops, where a distance window spans the whole pause. Override per block with speedWindow:.",
        control: { type: "text", key: "speedWindow", placeholder: SPEED_WINDOW_PLACEHOLDER, validate: metricWindowValidator(SPEED_WINDOW_PLACEHOLDER) },
      },
      {
        name: "Grade window",
        desc: "Span the rolling grade is measured over, used for grade colouring and grade charts. A distance (100ft, 50m) or a time (10min). Track colouring on a map is distance-only. Override per block with gradeWindow:.",
        control: { type: "text", key: "gradeWindow", placeholder: GRADE_WINDOW_PLACEHOLDER, validate: metricWindowValidator(GRADE_WINDOW_PLACEHOLDER) },
      },
      {
        name: "Default label template",
        desc: "Template for map marker labels. Use {this.name}, {this.filename}, or helpers like {h.before(this.name, '(')} to remove city name. Leave empty to use the default name. Can be overridden per code block with labelTemplate. See ```places-help``` for all placeholders.",
        control: { type: "text", key: "defaultLabelTemplate", placeholder: "{h.before(this.name, '(')}" },
      },
      {
        name: "Default route label template",
        desc: "Template for generated directions labels. Use {this.distance_text}, {this.duration_text}, {this.distance_meters}, or {this.duration_seconds}. Can be overridden per code block with routeLabelTemplate or inside directions with labelTemplate.",
        control: { type: "text", key: "defaultRouteLabelTemplate", placeholder: "{this.distance_text} · {this.duration_text}" },
      },
      {
        name: "Waypoint label template",
        desc: "Template for waypoint marker labels: directions route endpoints (start / stop / end) and GPX <wpt> markers. Use {this.name}, {this.role_label}, {this.index}, {this.icon}, or {this.path}. Leave empty for the defaults (Start:/Stop N:/End: for directions, the name for GPX waypoints). Override per code block or per overlay with waypointLabelTemplate.",
        control: { type: "text", key: "waypointLabelTemplate", placeholder: "{this.role_label}: {this.name}" },
      },
      {
        name: "Path start label",
        desc: "Default start label for GPX/path overlays. Resolved against the track note's frontmatter, like VaultQuery templates: {this.Distance}, {this['Elevation Gain']}, {this.title}, {h.wikilink(this.path)}. Override per block with track.labels.start, or per note with the matching frontmatter property.",
        control: { type: "text", key: "pathStartLabelTemplate", placeholder: "(none)" },
      },
      {
        name: "Path midpoint label",
        desc: "Default midpoint label for GPX/path overlays; resolves like the start label. Use {h.round(this.Distance)} to round a number to 2 decimals. Leave empty to use the built-in default. Override per block with track.labels.midpoint.",
        control: { type: "text", key: "pathMidpointLabelTemplate", placeholder: "{this.Distance} · {this['Elevation Gain']}" },
      },
      {
        name: "Path end label",
        desc: "Default end label for GPX/path overlays; resolves like the start label. Override per block with track.labels.end.",
        control: { type: "text", key: "pathEndLabelTemplate", placeholder: "(none)" },
      },
      {
        name: "Default icon styles",
        desc: "Conditional icon style rules to apply to all Places maps before per-map iconStyles. Leave empty for no global icon styles.",
        control: { type: "textarea", key: "defaultIconStyles", placeholder: "!isLinked => opacity: 0.1", rows: 6 },
      },
      {
        name: "Default label styles",
        desc: "Conditional label style rules to apply to all Places maps before per-map labelStyles. Use this for MapLibre/WebGL marker labels that raw CSS cannot target. Leave empty for no global label styles.",
        control: { type: "textarea", key: "defaultLabelStyles", placeholder: "!isLinked => opacity: 0.1", rows: 6 },
      },
      {
        name: "Show help with empty map",
        desc: "When a code block has no Places to display, an empty map is always shown. Enable this to also render instructions for adding places below it. A code block can override this with showHelpWithEmptyMap: false.",
        control: { type: "toggle", key: "showHelpWithEmptyMap" },
      },
      {
        name: "POI discovery",
        desc: "Enable clicking on base map features (trails, parks, restaurants) to discover and create notes for points of interest. Only works with vector tile providers. Can be overridden per code block.",
        control: { type: "toggle", key: "poiDiscovery" },
      },
      {
        name: "POI filter patterns",
        desc: "Regex patterns to hide unwanted POIs from maps and search results. One pattern per line. Matches against class, subclass, name, and tags. Examples: place_of_worship, church|chapel, fast_food",
        control: {
          type: "textarea",
          key: "poiFilterPatterns",
          placeholder: "place_of_worship\nchurch|chapel\nfast_food",
          rows: 4,
          validate: (value: string): string | void => {
            const invalid = value.split("\n").map(line => line.trim()).filter(Boolean).filter(line => {
              try { new RegExp(line); return false; } catch { return true; }
            });
            if (invalid.length > 0) return `Invalid regex: ${invalid.join(", ")}`;
          },
        },
      },
      {
        name: "New place tag filters",
        desc: "Tags to exclude when adding or updating a place from search. One tag per line. Matches exact tag names after normalizing periods, underscores, and spaces to dashes.",
        control: { type: "textarea", key: "newPlaceTagFilterPatterns", placeholder: DEFAULT_SETTINGS.newPlaceTagFilterPatterns.join("\n"), rows: 6 },
      },
      {
        name: "Default marker icon rules",
        desc: "Pick the default `icon` written into a note's frontmatter when a place is added or refreshed with the \"Search for place by name\" command (or saved from a map search) and it has no explicit `icon`. These rules never change how existing markers render - a place with no `icon` shows the default 📍. One rule per line, evaluated top-to-bottom - the first match wins. Each line is `tag:<regex> => 🍕` or `name:<regex> => 🎿` (a bare `<regex>` matches tags). The regex is case-insensitive; an empty emoji forces the default 📍. Defaults to the built-in tag emojis, which can be reordered, edited, or removed.",
        control: { type: "textarea", key: "markerIconRules", placeholder: "name:ski|snowboard => 🎿\ntag:^pizza$ => 🍕\nbrewery => 🍻", rows: 8 },
      },
    ];
  }

  private clusteringItems(): SettingGroupItem[] {
    return [
      {
        name: "Desktop clustering threshold",
        desc: "Group nearby markers into clusters when marker count exceeds this value. Set to 0 to disable.",
        control: { type: "number", key: "clusterThresholdDesktop", placeholder: "0", min: 0 },
      },
      {
        name: "Mobile clustering threshold",
        desc: "Group nearby markers into clusters when marker count exceeds this value on mobile devices. Lower values recommended for better performance. Set to 0 to disable.",
        control: { type: "number", key: "clusterThresholdMobile", placeholder: "200", min: 0 },
      },
    ];
  }

  private fileImportItems(): SettingGroupItem[] {
    const compressionOptions: Record<string, string> = {};
    for (let level = 1; level <= 19; level++) {
      compressionOptions[String(level)] = String(level);
    }
    return [
      {
        name: "GPX import mode",
        desc: "How to handle GPX files dropped into notes",
        control: {
          type: "dropdown",
          key: "gpxImportMode",
          options: { disabled: "Do nothing", "single-note": "All tracks in one note", "one-per-track": "Each track as a separate note" },
        },
      },
      {
        name: "GPX note name format",
        desc: "Format for new notes created from GPX files. Placeholders: {yyyymmdd} {TrackName} {filename}",
        control: { type: "text", key: "gpxNoteNameFormat", placeholder: "{yyyymmdd} - {TrackName}" },
      },
      {
        name: "GeoJSON import mode",
        desc: "How to handle GeoJSON files dropped into notes",
        control: {
          type: "dropdown",
          key: "geoJsonImportMode",
          options: { disabled: "Do nothing", "single-note": "All features in one note", "one-per-feature": "Each feature as a separate note" },
        },
      },
      {
        name: "CSV import mode",
        desc: "How to handle CSV files dropped into notes",
        control: {
          type: "dropdown",
          key: "csvImportMode",
          options: { disabled: "Do nothing", "single-note": "Import as a single note" },
        },
      },
      {
        name: "Drop on existing note",
        desc: "When a track file is dropped on an existing note, update that note's track data instead of creating a new note",
        control: {
          type: "dropdown",
          key: "importDropOnNote",
          options: { "create-new": "Create new note", update: "Update existing note" },
        },
      },
      {
        name: "Precompute overlay cache",
        desc: "Store a precomputed GeoJSON cache for GPX/CSV imports. Improves map rendering speed but increases file size. GeoJSON imports are never cached (source is already the render format).",
        control: { type: "toggle", key: "precomputeOverlayCache" },
      },
      {
        name: "Overlay compression level",
        desc: "Zstandard level applied when writing Overlay Source and Overlay Cache values. Higher levels store smaller values and take longer during import. Decoding speed does not depend on the level.",
        control: { type: "dropdown", key: "overlayCompressionLevel", options: compressionOptions },
      },
    ];
  }

  // One declarative group per extension, with the extension-local control keys
  // namespaced, routing reads and writes to that extension's settings object.
  private extensionItems(): SettingDefinitionItem[] {
    return Object.entries(this.extensionSettingsGroups).map(([plugin, group]) => ({
      type: "group",
      heading: group.heading,
      items: group.items.map(item => namespaceExtensionItem(plugin, item) as SettingGroupItem),
    }));
  }

  private tileCacheItems(): SettingGroupItem[] {
    const items: SettingGroupItem[] = [
      {
        name: "Desktop cache duration",
        desc: "Hours to keep supported map tiles on desktop. Use 0 to disable caching.",
        control: { type: "number", key: "tileCacheDurationHoursDesktop", placeholder: "0", min: 0, max: 999 },
      },
      {
        name: "Desktop cache size",
        desc: "Approximate rolling desktop cache size in mb. Oldest tiles are removed after new tiles push the cache over this limit.",
        visible: () => PlacesPlugin.settings.tileCacheDurationHoursDesktop > 0,
        control: { type: "number", key: "tileCacheMaxSizeMBDesktop", placeholder: "250", min: 1 },
      },
      {
        name: "Mobile cache duration",
        desc: "Hours to keep supported map tiles on mobile. Use 0 to disable caching.",
        control: { type: "number", key: "tileCacheDurationHoursMobile", placeholder: "0", min: 0, max: 999 },
      },
      {
        name: "Mobile cache size",
        desc: "Approximate rolling mobile cache size in mb. Oldest tiles are removed after new tiles push the cache over this limit.",
        visible: () => PlacesPlugin.settings.tileCacheDurationHoursMobile > 0,
        control: { type: "number", key: "tileCacheMaxSizeMBMobile", placeholder: "250", min: 1 },
      },
    ];

    items.push(...this.tileCacheProviderItems());

    items.push({
      name: "Cached tiles",
      aliases: ["Clear cache"],
      render: (setting: Setting) => this.renderCachedTiles(setting),
    });

    return items;
  }

  private tileCacheProviderItems(): SettingGroupItem[] {
    const providers = this.plugin.getRegisteredProviders()
      .filter(provider => provider.map)
      .sort((a, b) => a.name.localeCompare(b.name));

    if (providers.length === 0) {
      return [{
        name: "Provider caching",
        desc: "No map providers are currently available.",
      }];
    }

    const items: SettingGroupItem[] = [{
      name: "Provider caching",
      desc: "Choose which supported map providers can use the Places tile cache. Providers not listed as supported load tiles through their own SDK or request path.",
    }];

    for (const provider of providers) {
      items.push(this.tileCacheProviderItem(provider));
    }
    return items;
  }

  private tileCacheProviderItem(provider: PlaceProviderExport): SettingGroupItem {
    const providerName = provider.name.toLowerCase();
    const supportsTileCache = provider.features?.tileCache === true;
    const unsupportedReason = provider.features?.tileCacheUnsupportedReason?.trim();

    return {
      name: provider.name,
      desc: supportsTileCache
        ? "Use the Places tile cache for this provider."
        : (unsupportedReason ? `Tile caching is not supported. ${unsupportedReason}` : "Tile caching is not supported."),
      control: {
        type: "toggle",
        key: `${TILE_PROVIDER_KEY_PREFIX}${providerName}`,
        // Pin the toggle off for an unsupported provider; getControlValue
        // is never consulted for it because defaultValue only applies when
        // the resolver yields undefined; the pin comes from disabled + the stored
        // map never containing an unsupported provider.
        disabled: !supportsTileCache,
        ...(supportsTileCache ? {} : { defaultValue: false }),
      },
    };
  }

  private renderCachedTiles(setting: Setting): void {
    setting.setName("Cached tiles").setDesc("Loading cache statistics...");
    setting.addButton((button) => {
      button.setButtonText("Clear cache");
      button.buttonEl.addClass("mod-warning");
      button.onClick(async () => {
        await TileCache.clear();
        setting.setDesc("0 Entries, 0 mb");
        button.setButtonText("Cache cleared!");
        new Notice("Places tile cache cleared");
        window.setTimeout(() => {
          button.setButtonText("Clear cache");
        }, 2000);
      });
    });
    void TileCache.getStats().then((cacheStats) => {
      setting.setDesc(`${cacheStats.count} entries, ${Math.round(cacheStats.sizeBytes / 1024 / 1024 * 10) / 10} mb`);
    });
  }

  private debugItems(): SettingGroupItem[] {
    return [{
      name: "Console log level",
      desc: "Controls which Places logs are written to the developer console. The copied debug log always includes all captured entries.",
      control: {
        type: "dropdown",
        key: "consoleLogLevel",
        options: {
          none: "None",
          error: "Errors",
          warn: "Warnings and errors",
          info: "Info, warnings, and errors",
          debug: "Debug and above",
        },
      },
    }];
  }

  private renderUsageStatistics(containerEl: HTMLElement): void {
    const statsEl = containerEl.createDiv({ cls: "places-settings-stats" });

    const stats = this.getAggregatedStatsFromSettings();

    if (stats.totalCalls === 0) {
      statsEl.createEl("p", {
        text: "No API calls have been made yet.",
        cls: "places-centered places-empty"
      });
      return;
    }

    const chartContainer = statsEl.createDiv({ cls: "places-chart-container" });

    this.addUsageChart(chartContainer, stats);

    const statsGrid = statsEl.createDiv({ cls: "places-stats-grid" });

    const successRate = Math.round(((stats.successfulCalls || 0) / (stats.totalCalls || 1)) * 100);

    this.addStatCard(statsGrid, "Total Calls", (stats.totalCalls || 0).toString());
    this.addStatCard(statsGrid, "Success Rate", `${successRate}%`);
    this.addStatCard(statsGrid, "Avg Response Time", `${Math.round(stats.averageTime || 0)}ms`);
    this.addStatCard(statsGrid, "Today", (stats.dailyCalls || 0).toString());
    this.addStatCard(statsGrid, "This Month", (stats.monthlyCalls || 0).toString());

    if (stats.lastCall) {
      this.addStatCard(statsGrid, "Last Call", new Date(stats.lastCall).toLocaleDateString());
    }

  }

  private addUsageChart(container: HTMLElement, _stats: IPlacesUsageStats): void {
    const serviceData = this.getServiceHistoryData();

    if (serviceData.dates.length === 0) {
      container.createEl("p", {
        text: "No historical usage data available yet.",
        cls: "places-centered places-empty"
      });
      return;
    }

    const servicesWithData = serviceData.services.filter(service => service.values.some(v => v > 0));

    this.addServiceTable(container, servicesWithData, serviceData.dates);
  }

  private addServiceTable(container: HTMLElement, services: Array<{name: string, values: number[]}>, _dates: string[]): void {
    const tableContainer = container.createDiv({ cls: "places-service-table-container" });

    const table = tableContainer.createEl("table", { cls: "places-service-table" });

    const thead = table.createEl("thead");
    const headerRow = thead.createEl("tr");
    headerRow.createEl("th", { text: "Provider" });
    headerRow.createEl("th", { text: "Service" });
    headerRow.createEl("th", { text: "Total calls" });
    headerRow.createEl("th", { text: "Avg response time" });
    headerRow.createEl("th", { text: "Today" });
    headerRow.createEl("th", { text: "This week" });
    headerRow.createEl("th", { text: "This month" });
    headerRow.createEl("th", { text: "% of total" });

    const tbody = table.createEl("tbody");

    const totalCalls = services.reduce((sum, service) =>
      sum + service.values.reduce((a, b) => a + b, 0), 0
    );

    const parsedServices: Array<{fullName: string, provider: string, serviceName: string, values: number[]}> = [];

    for (const service of services) {
      const colonIndex = service.name.indexOf(':');
      let provider: string;
      let serviceName: string;

      if (colonIndex > 0) {
        provider = service.name.substring(0, colonIndex);
        serviceName = service.name.substring(colonIndex + 1);
      } else {
        // No colon separator - use full name as provider
        provider = service.name;
        serviceName = '';
      }

      parsedServices.push({
        fullName: service.name,
        provider: provider.charAt(0).toUpperCase() + provider.slice(1),
        serviceName: serviceName.charAt(0).toUpperCase() + serviceName.slice(1),
        values: service.values
      });
    }

    parsedServices.sort((a, b) => {
      const totalA = a.values.reduce((sum, v) => sum + v, 0);
      const totalB = b.values.reduce((sum, v) => sum + v, 0);
      return totalB - totalA;
    });

    for (const service of parsedServices) {
      const serviceTotalCalls = service.values.reduce((sum, v) => sum + v, 0);
      const percentage = totalCalls > 0 ? Math.round((serviceTotalCalls / totalCalls) * 100) : 0;

      const serviceStats = this.getServiceSpecificStats(service.fullName);

      const row = tbody.createEl("tr");
      row.createEl("td", { text: service.provider });
      row.createEl("td", { text: service.serviceName });
      row.createEl("td", { text: serviceTotalCalls.toString() });
      row.createEl("td", { text: `${Math.round(serviceStats.avgResponseTime || 0)}ms` });
      row.createEl("td", { text: serviceStats.todayCalls.toString() });
      row.createEl("td", { text: serviceStats.thisWeekCalls.toString() });
      row.createEl("td", { text: serviceStats.thisMonthCalls.toString() });

      const percentCell = row.createEl("td");
      const percentBar = percentCell.createDiv({ cls: "percent-bar-container" });
      const bar = percentBar.createDiv({ cls: "percent-bar" });
      bar.setAttribute('data-percentage', `${percentage}`);
      percentBar.createSpan({ text: `${percentage}%`, cls: "percent-text" });
    }
  }

  private getServiceSpecificStats(serviceName: string): {
    avgResponseTime: number;
    todayCalls: number;
    thisWeekCalls: number;
    thisMonthCalls: number;
  } {
    const apiStats = PlacesPlugin.settings.apiStats as Record<string, IPlacesUsageStats>;
    const serviceStats = apiStats[serviceName] || {};

    const stats = PlacesStatsCalculator.calculateSingleServiceStats(serviceStats);

    let thisWeekCalls = 0;
    if (serviceStats.dailyHistory) {
      const now = new Date();
      const dayOfWeek = now.getDay(); // 0 = Sunday, 1 = Monday, etc.
      const weekStart = new Date(now);
      weekStart.setDate(now.getDate() - dayOfWeek);
      const weekStartStr = DateParser.formatDateISO(weekStart);
      const today = DateParser.formatDateISO(new Date());

      for (const [date, dayStats] of Object.entries(serviceStats.dailyHistory)) {
        if (date >= weekStartStr && date <= today) {
          thisWeekCalls += (dayStats).totalCalls || 0;
        }
      }
    }

    return {
      avgResponseTime: stats.averageTime || 0,
      todayCalls: stats.dailyCalls || 0,
      thisWeekCalls,
      thisMonthCalls: stats.monthlyCalls || 0
    };
  }

  private getAggregatedStatsFromSettings(): IPlacesUsageStats {
    const apiStats = PlacesPlugin.settings.apiStats as Record<string, IPlacesUsageStats>;
    const aggregateStats = PlacesStatsCalculator.calculateAggregateStats(apiStats);

    return {
      totalCalls: aggregateStats.totalCalls,
      successfulCalls: aggregateStats.successfulCalls,
      failedCalls: aggregateStats.failedCalls,
      totalTime: aggregateStats.totalTime,
      averageTime: aggregateStats.averageTime,
      dailyCalls: aggregateStats.dailyCalls,
      monthlyCalls: aggregateStats.monthlyCalls,
      firstCall: aggregateStats.earliestFirstCall,
      lastCall: aggregateStats.latestLastCall
    };
  }

  private getServiceHistoryData(): {dates: string[], services: Array<{name: string, values: number[]}>} {
    const dateRange = this.getLast14Days();
    const apiStats = PlacesPlugin.settings.apiStats as Record<string, IPlacesUsageStats>;

    const services = Object.keys(apiStats).map(serviceName => ({
      name: serviceName,
      values: PlacesStatsCalculator.getDailyCallDataForDates(apiStats[serviceName], dateRange)
    }));

    return {
      dates: dateRange,
      services: services
    };
  }

  private getLast14Days(): string[] {
    const dates = [];
    const today = new Date();

    for (let i = 13; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(today.getDate() - i);
      dates.push(DateParser.formatDateISO(date));
    }

    return dates;
  }


  private addStatCard(container: HTMLElement, label: string, value: string): void {
    const card = container.createDiv({ cls: "places-stat-card" });

    card.createDiv({
      text: value,
      cls: "places-stat-value"
    });

    card.createDiv({
      text: label,
      cls: "places-stat-label"
    });
  }
}
