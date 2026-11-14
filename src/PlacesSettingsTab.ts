import { getErrorMessage, scalarToString } from "places-shared/utils";
import { DEFAULT_SPEED_WINDOW, parseMetricWindow } from "places-shared/settings";
import { App, Notice, PluginSettingTab, Setting, TextAreaComponent } from "obsidian";
import type { SettingDefinitionItem, SettingDefinitionPage, SettingGroupItem } from "obsidian";
import { TileCache } from "places-shared/obsidian/map";
import { clearStoredPictures, getStoredPictureStats, defaultMarkerIconRules, defaultWaypointIconMappings } from "places-shared/map";
import { openLocalFile } from "places-shared/obsidian/utils";
import { parseTagFilterPatterns } from "./core/map/PlaceTagFilter";
import { DEFAULT_SETTINGS, DEFAULT_TILE_CACHE_DURATION_HOURS } from "places-shared/settings";
import { API_USAGE_SERVICES } from "places-shared/services";
import { type PlaceProviderExport, type ExtensionSettingsGroup } from "places-shared/obsidian/services";
import { PlacesStatsCalculator, type OriginSummary, type ServiceSummary } from "./places-services/PlacesStatsCalculator";
import PlacesPlugin from "./main";
import { EXTENSION_KEY_PREFIX, buildExtensionSettingsPages, parseExtensionKey } from "./settings/ExtensionSettingsPages";
import { TemplateReferenceSuggest } from "./settings/TemplateReferenceSuggest";

// Control keys of the form `tileCacheProvider:<name>` toggle one provider's tile-cache opt-out.
const TILE_PROVIDER_KEY_PREFIX = "tileCacheProvider:";

const SPEED_WINDOW_PLACEHOLDER = "200m";
const GRADE_WINDOW_PLACEHOLDER = "100ft";

const LINE_LIST_KEYS = new Set(["poiFilterPatterns", "newPlaceTagFilterPatterns", "markerIconRules", "waypointIconMappings"]);

const ORIGIN_ROW_LIMIT = 50;

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
      const providerName = key.slice(TILE_PROVIDER_KEY_PREFIX.length);
      const provider = this.plugin.getRegisteredProviders()
        .find(candidate => candidate.name.toLowerCase() === providerName);

      if (provider?.features?.tileCache !== true) return false;

      return PlacesPlugin.settings.tileCacheEnabledProviders[providerName] !== false;
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
      if (group?.reloadOn?.includes(localKey)) this.plugin.scheduleExtensionReload(plugin);
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
      case "waypointIconMappings":
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
      case "overlayCacheMaxSizeMBDesktop":
      case "overlayCacheMaxSizeMBMobile":
        settings[key] = Math.max(1, Math.trunc(Number(value)) || DEFAULT_SETTINGS[key]);
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

    if (key === "units") {
      this.plugin.scheduleAllExtensionReloads();
    }

    if (key.startsWith("overlayCache")) {
      PlacesPlugin.configureOverlayDecodeCache();
    }

    if (key.startsWith("tileCache")) {
      PlacesPlugin.configureTileCache();
      this.update();
    }
  }

  public getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      this.placesAndNotesPage(),
      this.mapsAndMarkersPage(),
      this.tracksAndImportsPage(),
      this.extensionsPage(),
      this.cacheAndStoragePage(),
      this.diagnosticsPage(),
    ];
  }

  private placesAndNotesPage(): SettingDefinitionPage {
    return {
      type: "page",
      name: "Places and notes",
      desc: "Configure notes created or updated by Places.",
      items: this.groupWhenUseful("Note creation", this.placeNoteItems()),
    };
  }

  private mapsAndMarkersPage(): SettingDefinitionPage {
    return {
      type: "page",
      name: "Maps and markers",
      desc: "Set map, marker, label, and discovery defaults.",
      displayValue: () => {
        const provider = PlacesPlugin.settings.defaultMapProvider;

        return provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : "First available";
      },
      items: [
        ...this.groupWhenUseful("Map defaults", this.mapDefaultItems()),
        ...this.groupWhenUseful("Labels", this.labelItems()),
        ...this.groupWhenUseful("Styles", this.styleItems()),
        ...this.groupWhenUseful("POI discovery", this.poiDiscoveryItems()),
        ...this.groupWhenUseful("Marker clustering", this.clusteringItems()),
      ],
    };
  }

  private tracksAndImportsPage(): SettingDefinitionPage {
    return {
      type: "page",
      name: "Tracks and imports",
      desc: "Configure measurements and imported track or overlay files.",
      displayValue: () => PlacesPlugin.settings.units === "metric" ? "Metric" : "Imperial",
      items: [
        ...this.groupWhenUseful("Measurements", this.measurementItems()),
        ...this.groupWhenUseful("Import behavior", this.fileImportItems()),
        ...this.groupWhenUseful("Track notes", this.trackNoteItems()),
        ...this.groupWhenUseful("Overlay storage", this.overlayStorageItems()),
      ],
    };
  }

  private extensionsPage(): SettingDefinitionPage {
    const extensionCount = Object.keys(this.extensionSettingsGroups).length;
    const pages = this.extensionItems();
    const providerPages = pages.filter(({ category }) => category === "provider").map(({ page }) => page);
    const featurePages = pages.filter(({ category }) => category === "feature").map(({ page }) => page);
    const items: SettingDefinitionItem[] = [];

    items.push(...this.groupWhenUseful("Providers", providerPages));
    items.push(...this.groupWhenUseful("Feature extensions", featurePages));
    if (items.length === 0) items.push({ name: "", desc: "No configurable Places extensions are installed." });

    return {
      type: "page",
      name: "Extensions",
      desc: "Configure installed Places providers and feature extensions.",
      displayValue: extensionCount === 1 ? "1 configurable extension" : `${extensionCount} configurable extensions`,
      items,
    };
  }

  private cacheAndStoragePage(): SettingDefinitionPage {
    return {
      type: "page",
      name: "Cache and storage",
      desc: "Manage map tile caching on desktop and mobile.",
      displayValue: () => this.tileCacheSummary(),
      items: [
        ...this.groupWhenUseful("Desktop tile cache", this.desktopTileCacheItems()),
        ...this.groupWhenUseful("Mobile tile cache", this.mobileTileCacheItems()),
        ...this.groupWhenUseful("Provider caching", this.tileCacheProviderItems()),
        this.cachedTilesItem(),
        this.markerThumbnailsItem(),
      ],
    };
  }

  private diagnosticsPage(): SettingDefinitionPage {
    const logLabels: Record<string, string> = {
      none: "Logging off",
      error: "Errors",
      warn: "Warnings and errors",
      info: "Info and above",
      debug: "Debug and above",
    };

    return {
      type: "page",
      name: "Diagnostics",
      desc: "Control logging and review provider API usage.",
      displayValue: () => logLabels[PlacesPlugin.settings.consoleLogLevel] ?? "Logging configured",
      items: [
        ...this.groupWhenUseful("Logging", this.debugItems()),
        this.apiUsagePage(),
      ],
    };
  }

  private groupWhenUseful(heading: string, items: SettingGroupItem[]): SettingDefinitionItem[] {
    if (items.length <= 1) return items;

    return [{ type: "group", heading, cls: "places-settings-group", items }];
  }

  private placeNoteItems(): SettingGroupItem[] {
    return [
      {
        name: "Place note name format",
        desc: "Name format for notes created or updated from a place. Supports ${name}, ${city}, and ${state}.",
        control: { type: "text", key: "noteNameFormat", placeholder: "${name} (${city})" },
      },
      {
        name: "New place content template",
        desc: "Vault file containing a Knap template for new places from search or the map menu. Adds content and properties; generated place properties take precedence. Leave empty for none.",
        control: { type: "text", key: "newPlaceTemplate", placeholder: "Templates/New place.knap.md" },
      },
      {
        name: "New place tag filters",
        desc: "Tags excluded when a place is added or updated. Enter one tag per line.",
        render: setting => this.renderTextAreaSetting(setting, "newPlaceTagFilterPatterns", DEFAULT_SETTINGS.newPlaceTagFilterPatterns.join("\n"), 6),
      },
      {
        name: "Default marker icon rules",
        desc: "Icon rules for new, imported, or refreshed notes. Use tag:, name:, or path:; first match wins.",
        render: (setting: Setting) => this.renderMarkerIconRules(setting),
      },
    ];
  }

  private renderMarkerIconRules(setting: Setting): void {
    let rulesText: TextAreaComponent | undefined;

    setting.setClass("places-setting-textarea");
    setting.nameEl.addClass("places-setting-name-reset");

    setting.addExtraButton((button) => {
      button.setIcon("rotate-ccw").setTooltip("Restore the default rules");
      button.extraSettingsEl.addClass("places-settings-reset");
      setting.nameEl.appendChild(button.extraSettingsEl);
      button.onClick(async () => {
        const defaults = defaultMarkerIconRules().join("\n");

        await this.setControlValue("markerIconRules", defaults);
        rulesText?.setValue(defaults);
        new Notice("Marker icon rules restored to defaults");
      });
    });
    setting.addTextArea((text) => {
      rulesText = text;
      text.inputEl.rows = 8;
      text.setPlaceholder("name:ski|snowboard => 🎿\npath:(^|/)Biking Trails(/|$) => 🚲\ntag:^pizza$ => 🍕");
      text.setValue(PlacesPlugin.settings.markerIconRules.join("\n"));
      text.onChange((value) => void this.setControlValue("markerIconRules", value));
    });
  }

  private mapDefaultItems(): SettingGroupItem[] {
    const installedProviders = PlacesPlugin.getAllMapProviders().sort((a, b) => a.localeCompare(b));
    const providerOptions: Record<string, string> = { "": "First available" };

    for (const provider of installedProviders) {
      providerOptions[provider] = provider.charAt(0).toUpperCase() + provider.slice(1);
    }

    return [
      {
        name: "Default map provider",
        desc: "Provider used when a places block does not specify mapProvider.",
        control: { type: "dropdown", key: "defaultMapProvider", options: providerOptions, defaultValue: "" },
      },
      {
        name: "Default template",
        desc: "Template inherited by every places block. Type # after the note name to choose a heading. Leave empty for none.",
        render: (setting: Setting) => this.renderDefaultTemplate(setting),
      },
      {
        name: "Show help with empty map",
        desc: "Show place-creation help below maps with no results.",
        control: { type: "toggle", key: "showHelpWithEmptyMap" },
      },
      {
        name: "Show current device position",
        desc: "",
        control: { type: "toggle", key: "showCurrentDevicePosition" },
      },
    ];
  }

  private renderDefaultTemplate(setting: Setting): () => void {
    let suggest: TemplateReferenceSuggest | undefined;

    setting.addText(text => {
      const save = (value: string): void => { void this.setControlValue("defaultTemplate", value); };

      text.setPlaceholder("[[Shared/Templates#Base Map]]")
        .setValue(PlacesPlugin.settings.defaultTemplate)
        .onChange(save);
      suggest = new TemplateReferenceSuggest(this.app, text.inputEl);
      suggest.onSelect(value => {
        text.setValue(value);
        text.inputEl.setSelectionRange(value.length - 2, value.length - 2);
        save(value);
        suggest?.close();
      });
    });

    return () => suggest?.close();
  }

  private measurementItems(): SettingGroupItem[] {
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
        name: "Unit system",
        control: {
          type: "dropdown",
          key: "units",
          options: { imperial: "Imperial (miles, mph, feet)", metric: "Metric (kilometers, kph, meters)" },
        },
      },
      {
        name: "Speed window",
        desc: "Distance or time span used to average speed and pace.",
        control: { type: "text", key: "speedWindow", placeholder: SPEED_WINDOW_PLACEHOLDER, validate: metricWindowValidator(SPEED_WINDOW_PLACEHOLDER) },
      },
      {
        name: "Grade window",
        desc: "Rolling-grade window. Map blocks require a distance; charts also accept time.",
        control: { type: "text", key: "gradeWindow", placeholder: GRADE_WINDOW_PLACEHOLDER, validate: metricWindowValidator(GRADE_WINDOW_PLACEHOLDER) },
      },
    ];
  }

  private labelItems(): SettingGroupItem[] {
    return [
      {
        name: "Default label template",
        desc: "Template for marker labels. Leave empty to use the place name.",
        control: { type: "text", key: "defaultLabelTemplate", placeholder: "{h.before(this.name, '(')}" },
      },
      {
        name: "Default route label template",
        desc: "Template for generated directions labels.",
        control: { type: "text", key: "defaultRouteLabelTemplate", placeholder: "{this.distance_text} · {this.duration_text}" },
      },
      {
        name: "Waypoint label template",
        desc: "Template for route and GPX waypoint labels.",
        control: { type: "text", key: "waypointLabelTemplate", placeholder: "{this.role_label}: {this.name}" },
      },
      {
        name: "Track start label",
        desc: "Default start label for track overlays.",
        control: { type: "text", key: "pathStartLabelTemplate", placeholder: "(none)" },
      },
      {
        name: "Track midpoint label",
        desc: "Default midpoint label for track overlays.",
        control: { type: "text", key: "pathMidpointLabelTemplate", placeholder: "{this.Distance} · {this['Elevation Gain']}" },
      },
      {
        name: "Track end label",
        desc: "Default end label for track overlays.",
        control: { type: "text", key: "pathEndLabelTemplate", placeholder: "(none)" },
      },
    ];
  }

  private styleItems(): SettingGroupItem[] {
    return [
      {
        name: "Default icon styles",
        desc: "Conditional icon style rules applied before per-map iconStyles.",
        render: setting => this.renderTextAreaSetting(setting, "defaultIconStyles", "!isLinked => opacity: 0.1", 6),
      },
      {
        name: "Default label styles",
        desc: "Conditional label style rules applied before per-map labelStyles.",
        render: setting => this.renderTextAreaSetting(setting, "defaultLabelStyles", "!isLinked => opacity: 0.1", 6),
      },
      {
        name: "Waypoint icons",
        desc: "Case-insensitive exact GPX/FIT name, symbol, or type mappings. Use value => emoji; name:, sym:, and type: scope a mapping.",
        render: (setting: Setting) => this.renderWaypointIconMappings(setting),
      },
    ];
  }

  private renderWaypointIconMappings(setting: Setting): void {
    let mappingsText: TextAreaComponent | undefined;

    setting.setClass("places-setting-textarea");
    setting.nameEl.addClass("places-setting-name-reset");

    setting.addExtraButton(button => {
      button.setIcon("rotate-ccw").setTooltip("Restore the default mappings");
      button.extraSettingsEl.addClass("places-settings-reset");
      setting.nameEl.appendChild(button.extraSettingsEl);
      button.onClick(async () => {
        const defaults = defaultWaypointIconMappings().join("\n");

        await this.setControlValue("waypointIconMappings", defaults);
        mappingsText?.setValue(defaults);
        new Notice("Waypoint icons restored to defaults");
      });
    });
    setting.addTextArea(text => {
      mappingsText = text;
      text.inputEl.rows = 8;
      text.setPlaceholder("Parking => 🅿️\nrestroom => 🚻\nname:trailhead => 🥾\ntype:endpoint => 🏁");
      text.setValue(PlacesPlugin.settings.waypointIconMappings.join("\n"));
      text.onChange(value => void this.setControlValue("waypointIconMappings", value));
    });
  }

  private poiDiscoveryItems(): SettingGroupItem[] {
    return [
      {
        name: "POI discovery",
        desc: "Allow clicks on vector map features to discover points of interest.",
        control: { type: "toggle", key: "poiDiscovery" },
      },
      {
        name: "POI filter patterns",
        desc: "Regular expressions that hide matching POIs. Enter one pattern per line.",
        render: setting => this.renderTextAreaSetting(setting, "poiFilterPatterns", "place_of_worship\nchurch|chapel\nfast_food", 4, value => {
          const invalid = value.split("\n").map(line => line.trim()).filter(Boolean).filter(line => {
            try {
              new RegExp(line);

              return false;
            } catch {
              return true;
            }
          });

          if (invalid.length > 0) return `Invalid regex: ${invalid.join(", ")}`;
        }),
      },
    ];
  }

  private renderTextAreaSetting(setting: Setting, key: string, placeholder: string, rows: number, validate?: (value: string) => string | void): void {
    setting.setClass("places-setting-textarea");
    const validation = validate ? setting.controlEl.createDiv({ cls: "places-settings-validation places-settings-validation-error" }) : undefined;

    setting.addTextArea(text => {
      const check = (value: string): boolean => {
        const error = validate?.(value) ?? "";

        text.inputEl.setCustomValidity(error);
        text.inputEl.setAttribute("aria-invalid", String(Boolean(error)));
        validation?.setText(error);

        return !error;
      };
      const value = scalarToString(this.getControlValue(key));

      text.inputEl.rows = rows;
      text.setPlaceholder(placeholder).setValue(value);
      check(value);
      text.onChange(next => {
        if (check(next)) void this.setControlValue(key, next);
      });
    });
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
      {
        name: "Cluster overlay points",
        desc: "Include GeoJSON overlay points when clustering markers.",
        control: { type: "toggle", key: "clusterGeoJsonOverlays" },
      },
      {
        name: "Cluster appearance",
        desc: "",
        control: {
          type: "dropdown",
          key: "clusterStyle",
          options: { circles: "Counted circles", heatmap: "Density heatmap" },
        },
      },
    ];
  }

  private fileImportItems(): SettingGroupItem[] {
    return [
      {
        name: "GPX import mode",
        desc: "How Places handles GPX files dropped into notes.",
        control: {
          type: "dropdown",
          key: "gpxImportMode",
          options: { disabled: "Do nothing", "single-note": "All tracks in one note", "one-per-track": "Each track as a separate note" },
        },
      },
      {
        name: "FIT import mode",
        desc: "How Places handles Garmin FIT files dropped into notes.",
        control: {
          type: "dropdown",
          key: "fitImportMode",
          options: { disabled: "Do nothing", "single-note": "Import as a single note" },
        },
      },
      {
        name: "GeoJSON import mode",
        desc: "How Places handles GeoJSON files dropped into notes.",
        control: {
          type: "dropdown",
          key: "geoJsonImportMode",
          options: { disabled: "Do nothing", "single-note": "All features in one note", "one-per-feature": "Each feature as a separate note" },
        },
      },
      {
        name: "CSV import mode",
        desc: "How Places handles CSV files dropped into notes.",
        control: {
          type: "dropdown",
          key: "csvImportMode",
          options: { disabled: "Do nothing", "single-note": "Import as a single note" },
        },
      },
      {
        name: "Drop on existing note",
        desc: "Whether a dropped track updates the target note or creates a note.",
        control: {
          type: "dropdown",
          key: "importDropOnNote",
          options: { "create-new": "Create new note", update: "Update existing note" },
        },
      },
    ];
  }

  private trackNoteItems(): SettingGroupItem[] {
    return [{
      name: "Track note name format",
      desc: "Name format for notes created from GPX, FIT, or recorded tracks.",
      control: { type: "text", key: "gpxNoteNameFormat", placeholder: "{yyyymmdd} - {TrackName}" },
    }];
  }

  private overlayStorageItems(): SettingGroupItem[] {
    const compressionOptions: Record<string, string> = {};

    for (let level = 1; level <= 19; level++) compressionOptions[String(level)] = String(level);

    return [
      {
        name: "Precompute overlay cache",
        desc: "Store render-ready GeoJSON with imported GPX, FIT, and CSV data.",
        control: { type: "toggle", key: "precomputeOverlayCache" },
      },
      {
        name: "Overlay compression level",
        desc: "Zstandard level used when writing overlay data. Higher levels take longer and use less space.",
        control: { type: "dropdown", key: "overlayCompressionLevel", options: compressionOptions },
      },
    ];
  }

  private extensionItems(): Array<{ category: "provider" | "feature"; page: SettingDefinitionPage }> {
    return buildExtensionSettingsPages(this.extensionSettingsGroups);
  }

  private desktopTileCacheItems(): SettingGroupItem[] {
    return [
      {
        name: "Cache duration",
        desc: `In hours, 0 to disable.`,
        control: { type: "number", key: "tileCacheDurationHoursDesktop", placeholder: String(DEFAULT_TILE_CACHE_DURATION_HOURS), min: 0, max: 999 },
      },
      {
        name: "Cache size",
        desc: "Approximate rolling cache size in MB.",
        visible: () => PlacesPlugin.settings.tileCacheDurationHoursDesktop > 0,
        control: { type: "number", key: "tileCacheMaxSizeMBDesktop", placeholder: "250", min: 1 },
      },
      {
        name: "Decoded track cache",
        desc: "Memory in MB for decoded track geometry. A map whose tracks exceed it decodes some of them again on every render.",
        control: { type: "number", key: "overlayCacheMaxSizeMBDesktop", placeholder: "192", min: 1 },
      },
    ];
  }

  private mobileTileCacheItems(): SettingGroupItem[] {
    return [
      {
        name: "Cache duration",
        desc: `In hours, 0 to disable.`,
        control: { type: "number", key: "tileCacheDurationHoursMobile", placeholder: String(DEFAULT_TILE_CACHE_DURATION_HOURS), min: 0, max: 999 },
      },
      {
        name: "Cache size",
        desc: "Approximate rolling cache size in MB.",
        visible: () => PlacesPlugin.settings.tileCacheDurationHoursMobile > 0,
        control: { type: "number", key: "tileCacheMaxSizeMBMobile", placeholder: "250", min: 1 },
      },
      {
        name: "Decoded track cache",
        desc: "Memory in MB for decoded track geometry on mobile.",
        control: { type: "number", key: "overlayCacheMaxSizeMBMobile", placeholder: "64", min: 1 },
      },
    ];
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

    return providers.map(provider => this.tileCacheProviderItem(provider));
  }

  private cachedTilesItem(): SettingGroupItem {
    return {
      name: "Cached tiles",
      aliases: ["Clear cache"],
      render: (setting: Setting) => this.renderCachedTiles(setting),
    };
  }

  private markerThumbnailsItem(): SettingGroupItem {
    return {
      name: "Marker thumbnails",
      aliases: ["Clear thumbnails", "Picture cache"],
      render: (setting: Setting) => this.renderMarkerThumbnails(setting),
    };
  }

  private renderMarkerThumbnails(setting: Setting): void {
    const updateStats = async (): Promise<void> => {
      const stats = await getStoredPictureStats();

      setting.setDesc(`${stats.count.toLocaleString()} thumbnails, ${(stats.sizeBytes / 1024 / 1024).toFixed(1)} MB. Clear after replacing an image file in place.`);
    };

    setting.setName("Marker thumbnail cache").setDesc("Loading thumbnail statistics...");
    void updateStats();
    setting.addButton((button) => {
      button.setButtonText("Clear thumbnails");
      button.buttonEl.addClass("mod-warning");
      button.onClick(async () => {
        const cleared = await clearStoredPictures();

        await updateStats();
        button.setButtonText("Thumbnails cleared!");
        new Notice(`Cleared ${cleared.toLocaleString()} marker thumbnails`);
        window.setTimeout(() => {
          button.setButtonText("Clear thumbnails");
        }, 2000);
      });
    });
  }

  private tileCacheSummary(): string {
    const desktop = PlacesPlugin.settings.tileCacheDurationHoursDesktop > 0;
    const mobile = PlacesPlugin.settings.tileCacheDurationHoursMobile > 0;

    if (desktop && mobile) return "Desktop and mobile";
    if (desktop) return "Desktop";
    if (mobile) return "Mobile";

    return "Off";
  }

  private tileCacheProviderItem(provider: PlaceProviderExport): SettingGroupItem {
    const providerName = provider.name.toLowerCase();
    const supportsTileCache = provider.features?.tileCache === true;

    return {
      name: provider.name,
      desc: supportsTileCache ? undefined : "Tile caching is not supported.",
      control: {
        type: "toggle",
        key: `${TILE_PROVIDER_KEY_PREFIX}${providerName}`,
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
        setting.setDesc("0 entries, 0 MB");
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
    return [
      {
        name: "Console log level",
        desc: "Lowest severity written to the developer console.",
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
      },
    ];
  }

  private apiUsagePage(): SettingDefinitionPage {
    return {
      type: "page",
      name: "API usage",
      desc: "Requests made to provider APIs.",
      displayValue: () => {
        const total = PlacesStatsCalculator.aggregate(this.serviceSummaries()).lifetime.totalCalls;

        return total === 1 ? "1 call" : `${total} calls`;
      },
      items: [
        {
          name: "API usage",
          searchable: false,
          render: (setting: Setting) => {
            setting.settingEl.empty();
            setting.settingEl.addClass("places-settings-stats-item");
            this.renderUsageStatistics(setting.settingEl);
          },
        },
      ],
    };
  }

  private serviceSummaries(): ServiceSummary[] {
    return PlacesStatsCalculator.summarizeServices(PlacesPlugin.settings.apiStats);
  }

  private renderUsageStatistics(containerEl: HTMLElement): void {
    containerEl.empty();
    const statsEl = containerEl.createDiv({ cls: "places-settings-stats" });
    const summaries = this.serviceSummaries();

    if (summaries.length === 0) {
      statsEl.createEl("p", {
        text: "No API calls have been made yet.",
        cls: "places-centered places-empty"
      });
    } else {
      this.addServiceTable(statsEl, summaries, summary => {
        containerEl.empty();
        new Setting(containerEl)
          .setName(`${this.titleCase(summary.provider)} - ${this.serviceTitle(summary)}`)
          .setHeading()
          .addButton(button => button.setButtonText("Back to API usage").onClick(() => this.renderUsageStatistics(containerEl)));
        this.renderServiceDetail(containerEl, summary);
      });
      this.addSummaryCards(statsEl, summaries);
    }

    new Setting(statsEl).setName("Reset API stats")
      .setDesc("Clear usage totals, daily history, and recorded note and block activity.")
      .addButton(button => button.setButtonText("Reset stats").setDestructive().onClick(async () => {
        button.setDisabled(true);

        try {
          await this.plugin.resetApiStats();
          this.renderUsageStatistics(containerEl);
          new Notice("API usage statistics reset");
        } catch (error) {
          new Notice(`Could not reset API stats: ${getErrorMessage(error)}`);
        } finally {
          button.setDisabled(false);
        }
      }));
  }

  private addSummaryCards(container: HTMLElement, summaries: ServiceSummary[]): void {
    const stats = PlacesStatsCalculator.aggregate(summaries);
    const statsGrid = container.createDiv({ cls: "places-stats-grid" });

    const successRate = stats.lifetime.totalCalls > 0
      ? Math.round((stats.lifetime.successfulCalls / stats.lifetime.totalCalls) * 100)
      : 0;

    this.addStatCard(statsGrid, "Total calls", stats.lifetime.totalCalls.toString());
    this.addStatCard(statsGrid, "Success rate", `${successRate}%`);
    this.addStatCard(statsGrid, "Avg response time", `${Math.round(stats.lifetime.averageTime)}ms`);
    this.addStatCard(statsGrid, "Cache hits", stats.lifetime.cacheHits.toString());
    this.addStatCard(statsGrid, "Today", stats.todayCalls.toString());
    this.addStatCard(statsGrid, "This month", stats.monthCalls.toString());

    if (stats.lastCall) {
      this.addStatCard(statsGrid, "Last call", new Date(stats.lastCall).toLocaleDateString());
    }
  }

  private addServiceTable(container: HTMLElement, summaries: ServiceSummary[], onSelect: (summary: ServiceSummary) => void): void {
    const tableContainer = container.createDiv({ cls: "places-service-table-container" });
    const table = tableContainer.createEl("table", { cls: "places-service-table places-api-usage-table" });

    const headerRow = table.createEl("thead").createEl("tr");

    for (const heading of ["Provider", "Service", "Calls", "Cache hits", "Failed", "Avg. time", "Today", "This week", "This month", "% of total"]) {
      headerRow.createEl("th", { text: heading });
    }

    const tbody = table.createEl("tbody");
    const totalCalls = summaries.reduce((sum, summary) => sum + summary.lifetime.totalCalls, 0);

    for (const summary of summaries) {
      const percentage = totalCalls > 0 ? Math.round((summary.lifetime.totalCalls / totalCalls) * 100) : 0;

      const row = tbody.createEl("tr", { cls: "places-service-row" });

      row.addEventListener("click", event => {
        event.preventDefault();
        onSelect(summary);
      });
      row.createEl("td").createEl("a", {
        text: this.titleCase(summary.provider), cls: "places-service-link", href: "#",
        attr: { "aria-label": `View ${this.titleCase(summary.provider)} - ${this.serviceTitle(summary)} usage` },
      });
      row.createEl("td", { text: this.serviceTitle(summary) });
      row.createEl("td", { text: summary.lifetime.totalCalls.toLocaleString() });
      row.createEl("td", { text: summary.lifetime.cacheHits.toLocaleString() });
      row.createEl("td", { text: summary.lifetime.failedCalls.toLocaleString() });
      row.createEl("td", { text: `${Math.round(summary.lifetime.averageTime)}ms` });
      row.createEl("td", { text: summary.todayCalls.toLocaleString() });
      row.createEl("td", { text: summary.weekCalls.toLocaleString() });
      row.createEl("td", { text: summary.monthCalls.toLocaleString() });
      row.createEl("td", { text: `${percentage}%` });
    }
  }

  private renderServiceDetail(container: HTMLElement, summary: ServiceSummary): void {
    const key = `${summary.provider}:${summary.service}`;

    if (summary.provider === "nominatim" && summary.service === "tilequery") {
      container.createEl("p", { text: "This is a historical Places statistics label, not a Nominatim API. Current Nominatim lookups are recorded under Geocoding." });
    }

    this.addDailyHistory(container, summary);
    this.addOriginTable(container, "Notes", "Note", PlacesStatsCalculator.summarizeOrigins(PlacesPlugin.settings.apiOrigins, 'notes', key), true);
    this.addOriginTable(container, "Blocks", "Block", PlacesStatsCalculator.summarizeOrigins(PlacesPlugin.settings.apiOrigins, 'blocks', key), false);

    if (summary.service === API_USAGE_SERVICES.tiles) {
      container.createEl("p", {
        text: "Tiles, styles, sprites and terrain are shared by every map using this provider, so they are counted per provider rather than per note.",
        cls: "places-setting-description",
      });
    }
  }

  private addDailyHistory(container: HTMLElement, summary: ServiceSummary): void {
    const days = PlacesStatsCalculator.summarizeDays(PlacesPlugin.settings.apiStats, `${summary.provider}:${summary.service}`);

    new Setting(container).setName("Recent days").setHeading();

    if (days.length === 0) {
      container.createEl("p", { text: "No data recorded", cls: "places-centered places-empty" });

      return;
    }

    const table = container.createDiv({ cls: "places-service-table-container" }).createEl("table", { cls: "places-service-table" });
    const headerRow = table.createEl("thead").createEl("tr");

    for (const heading of ["Day", "Calls", "Cache hits", "Failed", "Avg response time"]) {
      headerRow.createEl("th", { text: heading });
    }

    const tbody = table.createEl("tbody");

    for (const day of days) {
      const row = tbody.createEl("tr");

      row.createEl("td", { text: day.date });
      row.createEl("td", { text: day.totalCalls.toString() });
      row.createEl("td", { text: day.cacheHits.toString() });
      row.createEl("td", { text: day.failedCalls.toString() });
      row.createEl("td", { text: `${Math.round(day.averageTime)}ms` });
    }
  }

  private addOriginTable(container: HTMLElement, heading: string, columnName: string, origins: OriginSummary[], asLinks: boolean): void {
    if (origins.length === 0) return;
    new Setting(container).setName(heading).setHeading();

    const table = container.createDiv({ cls: "places-service-table-container" }).createEl("table", { cls: "places-service-table" });
    const headerRow = table.createEl("thead").createEl("tr");

    for (const columnHeading of [columnName, "Calls", "Cache hits", "Failed", "Last call"]) {
      headerRow.createEl("th", { text: columnHeading });
    }

    const tbody = table.createEl("tbody");

    for (const origin of origins.slice(0, ORIGIN_ROW_LIMIT)) {
      const row = tbody.createEl("tr");
      const cell = row.createEl("td");

      if (asLinks) {
        const link = cell.createEl("a", { text: origin.key, href: "#", cls: "places-origin-link" });

        link.addEventListener("click", event => {
          event.preventDefault();
          openLocalFile(this.app, origin.key);
        });
      } else {
        cell.setText(origin.key);
      }

      row.createEl("td", { text: origin.calls.toString() });
      row.createEl("td", { text: origin.cacheHits.toString() });
      row.createEl("td", { text: origin.failedCalls.toString() });
      row.createEl("td", { text: origin.lastCall > 0 ? new Date(origin.lastCall).toLocaleDateString() : "" });
    }
  }

  private serviceTitle(summary: ServiceSummary): string {
    return this.titleCase(summary.service.replace(/([a-z])([A-Z])/gu, '$1 $2').toLowerCase())
      + (summary.service === "tilequery" ? " (historical)" : "");
  }

  private titleCase(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
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
