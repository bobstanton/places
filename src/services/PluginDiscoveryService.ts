import { App } from "obsidian";
import { IPlacePluginExtension } from "places-shared/services";

export interface DiscoveredPlugin {
  pluginId: string;
  // Plugin id without the "places-" prefix ("places-mapbox" -> "mapbox").
  name: string;
  extension: IPlacePluginExtension;
  apiVersion: number | undefined;
}

// Isolates Places' use of Obsidian's private loaded-plugin registry.
export class PluginDiscoveryService {
  constructor(private app: App) {}

  discoverPlugins(): DiscoveredPlugin[] {
    const plugins = (this.app as unknown as { plugins: { plugins: Record<string, unknown> } }).plugins.plugins;

    const placesPluginIds = Object.keys(plugins).filter(pluginId => {
      if (!pluginId.startsWith('places-') || pluginId === 'places-shared') return false;
      const candidate = plugins[pluginId] as Partial<IPlacePluginExtension>;
      return typeof candidate.getPlaceExports === 'function';
    });

    return placesPluginIds.map(pluginId => ({
      pluginId,
      name: pluginId.slice('places-'.length),
      extension: plugins[pluginId] as IPlacePluginExtension,
      apiVersion: (plugins[pluginId] as IPlacePluginExtension).placesExtensionApiVersion,
    }));
  }
}
