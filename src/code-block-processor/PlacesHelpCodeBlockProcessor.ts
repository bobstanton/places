import { App, Component, loadPrism, setIcon } from "obsidian";
import { IMapBlockProcessor } from "places-shared/services";
import { type PlaceProviderExport, CodeBlockDefinition } from "places-shared/obsidian/services";
import { ServiceRegistry } from "../services/ServiceRegistry";
import { renderError } from "places-shared/utils";
import { CodeBlockRegistry } from "../services/CodeBlockRegistry";
import type { PopupRenderer } from "places-shared/map";
import type { VectorTileOverlayPreset } from "places-shared/overlay";
import type { RenderContext } from "../generated-help/index.generated";
import * as mainHelp from "../generated-help/main-help.generated";
import * as chartHelp from "../generated-help/chart-help.generated";
import * as heatmapHelp from "../generated-help/heatmap-help.generated";
import * as styleHelp from "../generated-help/style-help.generated";
import * as overlayHelp from "../generated-help/overlay-help.generated";
import * as similarHelp from "../generated-help/similar-help.generated";
import * as compareHelp from "../generated-help/compare-help.generated";
import * as snapHelp from "../generated-help/snap-help.generated";
import * as elevationHelp from "../generated-help/elevation-help.generated";
import * as imageAlignHelp from "../generated-help/image-align-help.generated";
import * as basesHelp from "../generated-help/bases-help.generated";
import * as terrainHelp from "../generated-help/terrain-help.generated";
import * as directionsHelp from "../generated-help/directions-help.generated";
import * as isochronesHelp from "../generated-help/isochrones-help.generated";
import * as queryParametersHelp from "../generated-help/queryparameters-help.generated";
import * as queryHelp from "../generated-help/query-help.generated";
import * as addPlacesMethods from "../generated-help/snippets/add-places-methods.generated";

interface HelpModule {
  render: (container: HTMLElement, ctx: RenderContext) => void;
}

export class PlacesHelpCodeBlockProcessor {
  private readonly helpModules: Map<string, HelpModule> = new Map<string, HelpModule>([
    ['places-help', mainHelp],
    ['places-query-help', queryHelp],
    ['places-queryparameters-help', queryParametersHelp],
    ['places-overlay-help', overlayHelp],
    ['places-style-help', styleHelp],
    ['places-terrain-help', terrainHelp],
    ['places-directions-help', directionsHelp],
    ['places-isochrones-help', isochronesHelp],
    ['places-chart-help', chartHelp],
    ['places-heatmap-help', heatmapHelp],
    ['places-similar-help', similarHelp],
    ['places-compare-help', compareHelp],
    ['places-snap-help', snapHelp],
    ['places-elevation-help', elevationHelp],
    ['places-image-align-help', imageAlignHelp],
    ['places-bases-help', basesHelp],
  ]);

  private readonly helpDescriptions: Map<string, string> = new Map<string, string>([
    ['places-query-help', 'VaultQuery views and column rules'],
    ['places-queryparameters-help', 'Interactive controls that adjust a block\'s query'],
    ['places-overlay-help', 'Geodata, image, and vector overlays, tracks, POI discovery'],
    ['places-style-help', 'Marker, label, and track styling, conditional rules, CSS'],
    ['places-terrain-help', '3D terrain, hillshade, and color relief'],
    ['places-directions-help', 'Routed paths between notes, coordinates, or query results'],
    ['places-isochrones-help', 'Reachable-area overlays around centers'],
    ['places-chart-help', 'Elevation, speed, and pace charts'],
    ['places-heatmap-help', 'Frequency heatmaps and route analysis'],
    ['places-similar-help', 'Finding similar tracks'],
    ['places-compare-help', 'Track comparison and matching'],
    ['places-snap-help', 'Snapping GPS tracks to roads'],
    ['places-elevation-help', 'Filling and replacing track elevation data'],
    ['places-image-align-help', 'Aligning image overlays interactively'],
    ['places-bases-help', 'Places maps in Bases views'],
  ]);

  constructor(private app: App, private component: Component, private mapBlockProcessors: ServiceRegistry<IMapBlockProcessor>, private getProviders: () => readonly PlaceProviderExport[], private getExtensionHelpBlockTypes: () => readonly string[] = () => [], private getCommands: () => ReadonlyArray<{ name: string; description: string }> = () => [], private getPopupRenderers: () => readonly PopupRenderer[] = () => [], private getOverlayPresets: () => readonly VectorTileOverlayPreset[] = () => []) {}

  private createRenderContext(): RenderContext {
    return {
      app: this.app,
      component: this.component,
      renderDynamic: (parent: HTMLElement, key: string) => {
        this.renderDynamicContent(parent, key);
      },
      setIcon: (element: HTMLElement, iconId: string) => {
        setIcon(element, iconId);
      },
    };
  }

  private renderDynamicContent(container: HTMLElement, key: string): void {
    if (key === 'mapProviders') {
      this.showMapProviderSection(container);
    } else if (key === 'commands') {
      this.renderCommandList(container);
    } else if (key === 'codeBlocks') {
      this.renderCodeBlockList(container);
    } else if (key === 'providerCapabilities') {
      this.renderProviderCapabilities(container);
    } else if (key === 'routeProviders') {
      this.renderInstalledServiceList(container, 'route', (provider) => provider.routeOverlay !== undefined,
        (provider) => provider.routeOverlay?.getCapabilities?.()?.supportsIsochrones === false ? `${provider.name} (directions only)` : provider.name);
    } else if (key === 'snapProviders') {
      this.renderInstalledServiceList(container, 'snap', (provider) => provider.snap !== undefined, (provider) => provider.name);
    } else if (key === 'elevationProviders') {
      this.renderInstalledServiceList(container, 'elevation', (provider) => provider.elevation !== undefined, (provider) => provider.name);
    } else if (key === 'terrainProviders') {
      this.renderTerrainProviders(container);
    } else if (key === 'mapProviderNames') {
      this.renderInlineNames(container, this.mapBlockProcessors.getNames(), 'no map providers installed');
    } else if (key === 'routeProviderNames') {
      const routeNames = this.getProviders()
        .filter((provider) => provider.routeOverlay !== undefined)
        .map((provider) => provider.routeOverlay?.getCapabilities?.()?.supportsIsochrones === false ? `${provider.name} (directions only)` : provider.name);

      this.renderInlineNames(container, routeNames.sort((a, b) => a.localeCompare(b)), 'no route providers installed');
    } else if (key === 'terrainProviderNames') {
      const terrainNames = this.getProviders().filter((provider) => provider.terrain !== undefined).map((provider) => provider.name);

      this.renderInlineNames(container, [...terrainNames, 'aws'].sort((a, b) => a.localeCompare(b)), 'aws');
    } else if (key === 'trackMatchProviderNames') {
      const trackMatchNames = this.getProviders().filter((provider) => provider.trackMatch !== undefined).map((provider) => provider.name);

      this.renderInlineNames(container, trackMatchNames.sort((a, b) => a.localeCompare(b)), 'no track-match providers installed');
    } else if (key === 'imageAlignmentProviderNames') {
      const alignmentNames = this.getProviders().filter((provider) => provider.imageAlignment !== undefined).map((provider) => provider.name);

      this.renderInlineNames(container, alignmentNames.sort((a, b) => a.localeCompare(b)), 'no alignment-capable providers installed');
    } else if (key === 'popupRenderers') {
      this.renderPopupRenderers(container);
    } else if (key === 'overlayPresets') {
      this.renderOverlayPresets(container);
    } else {
      container.createSpan({ text: `{{${key}}}` });
    }
  }

  private renderProviderCapabilities(container: HTMLElement): void {
    const providers = [...this.getProviders()].sort((a, b) => a.name.localeCompare(b.name));
    const section = container.createDiv({ cls: "places-help-section" });

    if (providers.length === 0) {
      const para = section.createEl("p");

      para.appendText("No provider plugins are active yet. Install a Places provider plugin and configure its API key if required. ");
      para.createEl("a", { text: "Browse Places plugins", href: "https://obsidian.md/plugins?search=places" });

      return;
    }

    const scroll = section.createDiv({ cls: "places-help-table-scroll" });
    const table = scroll.createEl("table", { cls: "places-help-table" });
    const head = table.createEl("thead").createEl("tr");

    for (const label of ["Provider", "Maps", "Geocoding", "Elevation", "Directions", "Isochrones", "Snap", "Track matching"]) {
      head.createEl("th", { text: label });
    }

    const body = table.createEl("tbody");

    for (const provider of providers) {
      const row = body.createEl("tr");

      row.createEl("td", { text: provider.name });
      const capabilities = [
        provider.map !== undefined,
        provider.geocoding !== undefined,
        provider.elevation !== undefined,
        provider.routeOverlay !== undefined,
        provider.routeOverlay !== undefined && provider.routeOverlay.getCapabilities?.()?.supportsIsochrones !== false,
        provider.snap !== undefined,
        provider.trackMatch !== undefined,
      ];

      for (const supported of capabilities) {
        row.createEl("td", { text: supported ? "✓" : "" });
      }
    }
  }

  private renderInlineNames(container: HTMLElement, names: readonly string[], emptyText: string): void {
    container.createSpan({ text: names.length > 0 ? names.join(', ') : emptyText });
  }

  private renderPopupRenderers(container: HTMLElement): void {
    const renderers = [...this.getPopupRenderers()].sort((left, right) => left.id.localeCompare(right.id));

    if (renderers.length === 0) {
      container.createEl('p', { text: 'No popup renderers are installed.' });

      return;
    }

    const list = container.createEl('ul');

    for (const renderer of renderers) {
      const item = list.createEl('li');

      item.createEl('code', { text: renderer.id });
      if (renderer.description) item.appendText(`: ${renderer.description}`);
    }
  }

  private renderOverlayPresets(container: HTMLElement): void {
    const presets = [...this.getOverlayPresets()].sort((left, right) => left.id.localeCompare(right.id));

    if (presets.length === 0) {
      container.createEl('p', { text: 'No installed extension supplies an overlay preset.' });

      return;
    }

    const list = container.createEl('ul');

    for (const preset of presets) {
      const item = list.createEl('li');

      item.createEl('code', { text: preset.id });
      item.appendText(`: ${preset.description}. Layers: ${preset.layers.map(layer => layer.sourceLayer).join(', ')}.`);
    }
  }

  private renderTerrainProviders(container: HTMLElement): void {
    const installed = this.getProviders().filter((provider) => provider.terrain !== undefined).map((provider) => provider.name);
    const names = [...installed, 'aws'].sort((a, b) => a.localeCompare(b));

    container.createEl("p", { text: `Available terrain (DEM) providers: ${names.join(", ")}. A tile URL is also accepted.` });
  }

  private renderInstalledServiceList(container: HTMLElement, kind: string, supports: (provider: PlaceProviderExport) => boolean, label: (provider: PlaceProviderExport) => string): void {
    const names = this.getProviders().filter(supports).map(label).sort((a, b) => a.localeCompare(b));

    container.createEl("p", {
      text: names.length > 0
        ? `Currently installed ${kind} providers: ${names.join(", ")}.`
        : `No ${kind} providers are installed yet - enable a provider plugin with ${kind} support and configure its API key.`
    });
  }

  getHelpTypes(): string[] {
    return Array.from(this.helpModules.keys());
  }

  processHelpCodeBlock(helpType: string, el: HTMLElement): Promise<void> | void {
    const helpModule = this.helpModules.get(helpType);

    if (!helpModule) {
      renderError(el, { icon: "❓", title: "Unknown Help Topic", message: `No help found for: ${helpType}` });

      return;
    }

    const helpContainer = el.createDiv({ cls: "places-help-container" });

    // places-* fences are tokenized at build time; yaml/js/css display fences
    // fall back to Obsidian's Prism at render time. Before loadPrism resolves,
    // the Prism global may exist half-initialized. Rendering proceeds
    // unhighlighted if Prism cannot load.
    return loadPrism().catch(() => undefined).then(() => {
      helpModule.render(helpContainer, this.createRenderContext());
    });
  }

  // Registered palette commands - the main plugin's and every extension's - with their help lines.
  private renderCommandList(container: HTMLElement): void {
    const list = container.createEl("ul");

    for (const command of this.getCommands()) {
      const item = list.createEl("li");

      item.appendText(command.description ? `${command.name}: ${command.description}` : command.name);
    }
  }

  // Help pages a fence language reaches, main-plugin and extension alike.
  private availableHelpTypes(): Set<string> {
    const types = new Set([...this.helpModules.keys()].filter((type) => type !== 'places-help'));

    for (const type of this.getExtensionHelpBlockTypes()) types.add(type);

    return types;
  }

  private renderCodeBlockList(container: HTMLElement): void {
    const definitions: CodeBlockDefinition[] = CodeBlockRegistry.instance.getAllDefinitions();

    if (definitions.length === 0) {
      return;
    }

    const helpTypes = this.availableHelpTypes();
    const blockTypes = new Set(definitions.map((def) => def.type));
    // Pages documenting a setting or topic of the `places` block rather than a
    // block of their own; rendered as sub-rows under `places`.
    const topicHelpTypes = [...helpTypes].filter((type) => !blockTypes.has(type.slice(0, -'-help'.length)));

    const table = container.createEl("table", { cls: "places-help-table" });
    const thead = table.createEl("thead");
    const headerRow = thead.createEl("tr");

    headerRow.createEl("th", { text: "Code block" });
    headerRow.createEl("th", { text: "Description" });
    headerRow.createEl("th", { text: "Help page" });

    // `places-parameters` shares the queryParameters page, which documents the
    // same parameter grammar for the block and the setting.
    const helpPageAliases: Record<string, string> = { 'places-parameters': 'places-queryparameters-help' };

    const tbody = table.createEl("tbody");

    for (const def of definitions) {
      const row = tbody.createEl("tr");

      row.createEl("td").createEl("code", { text: def.type });
      row.createEl("td", { text: def.description });
      const helpCell = row.createEl("td");
      const helpPage = helpPageAliases[def.type] ?? `${def.type}-help`;

      if (helpTypes.has(helpPage)) {
        helpCell.createEl("code", { text: helpPage });
      }

      if (def.type !== 'places') continue;

      for (const type of topicHelpTypes) {
        const topicRow = tbody.createEl("tr", { cls: "places-help-topic-row" });

        topicRow.createEl("td");
        const description = this.helpDescriptions.get(type) ?? "";

        topicRow.createEl("td", { text: description });
        topicRow.createEl("td").createEl("code", { text: type });
      }
    }

    const note = container.createEl("p", { cls: "places-help-note" });

    note.appendText("For full parameter details, use: ");
    note.createEl("code", { text: "```places-reference```" });
  }

  showMapProviderSection(helpContainer: HTMLElement): void {
    const providersSection = helpContainer.createDiv({ cls: "places-help-section" });

    const installedProviders = this.mapBlockProcessors.getNames();

    if (installedProviders.length > 0) {
      providersSection.createEl("h3", { text: "Available map providers" });
      const providerList = providersSection.createEl("ul");

      installedProviders.forEach(provider => {
        providerList.createEl("li", { text: provider });
      });
    } else {
      const heading = providersSection.createEl("h3");

      heading.appendText("No map providers installed. ");
      heading.createEl("a", {
        text: "Browse Places plugins",
        href: "https://obsidian.md/plugins?search=places"
      });
    }
  }

  renderPlaceMethods(container: HTMLElement): void {
    addPlacesMethods.render(container, this.createRenderContext());
  }
}
