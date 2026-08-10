import type { ErrorWithHelpOptions } from "places-shared/utils";

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
