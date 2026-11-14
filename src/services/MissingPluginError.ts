import { renderMapSurfaceError, type ErrorWithHelpOptions } from "places-shared/utils";
import PlacesPlugin from "../main";

// Describes a query plugin that is not installed; callers render it through whichever error surface they own (refreshable, plain, inline).
export function missingQueryPluginError(plugin: 'dataview' | 'vaultquery'): ErrorWithHelpOptions {
  return plugin === 'dataview'
    ? {
      icon: "🔌",
      title: "Dataview Plugin Required",
      message: "This block uses a Dataview query, but the Dataview plugin could not be found. Install and enable the Dataview plugin from Community Plugins.",
      className: "dataview-error",
    }
    : {
      icon: "🔌",
      title: "VaultQuery Plugin Required",
      message: "This block uses a VaultQuery SQL query, but the VaultQuery plugin could not be found. Install and enable the VaultQuery plugin from Community Plugins.",
      className: "vaultquery-error",
    };
}

// Describes a missing map provider; callers that can enumerate installed providers list them below the error.
export function missingMapProviderError(providerName: string): ErrorWithHelpOptions {
  return {
    icon: "🗺️",
    title: "Map Provider Not Found",
    message: `The requested map provider "${providerName}" could not be found.`,
    className: "provider-error",
  };
}

export function renderMissingMapProvider(mapContainer: HTMLElement, providerName: string): void {
  renderMapSurfaceError(mapContainer, missingMapProviderError(providerName));

  const providers = PlacesPlugin.getAllMapProviders();
  const section = mapContainer.createDiv({ cls: "places-help-section" });

  if (providers.length > 0) {
    section.createEl("h3", { text: "Available map providers" });
    const list = section.createEl("ul");

    for (const provider of providers) list.createEl("li", { text: provider });
    section.createEl("p", { text: "Update the map provider setting to use an available provider." });
  } else {
    const heading = section.createEl("h3");

    heading.appendText("No map providers installed. ");
    heading.createEl("a", { text: "Browse plugins", href: "https://obsidian.md/plugins?search=places" });
  }

  const help = mapContainer.createDiv({ cls: "places-help-reference" }).createEl("p");

  help.appendText("For complete documentation, use: ");
  help.createEl("code", { text: "```places-help```" });
}
