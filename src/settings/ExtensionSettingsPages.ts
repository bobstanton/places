import type { SettingDefinitionItem, SettingDefinitionPage, SettingGroupItem } from 'obsidian';
import type { ExtensionSettingsGroup } from "places-shared/obsidian/services";

export const EXTENSION_KEY_PREFIX = 'extension:';

export interface ExtensionSettingsPageEntry {
  category: 'provider' | 'feature';
  page: SettingDefinitionPage;
}

export function parseExtensionKey(key: string): { plugin: string; localKey: string } {
  const rest = key.slice(EXTENSION_KEY_PREFIX.length);
  const separator = rest.indexOf(':');

  return { plugin: rest.slice(0, separator), localKey: rest.slice(separator + 1) };
}

export function namespaceExtensionItem(plugin: string, item: SettingDefinitionItem): SettingDefinitionItem {
  if ('control' in item && item.control) {
    return { ...item, control: { ...item.control, key: `${EXTENSION_KEY_PREFIX}${plugin}:${item.control.key}` } };
  }

  if ('type' in item && (item.type === 'group' || item.type === 'list')) {
    return { ...item, items: item.items?.map(child => namespaceExtensionItem(plugin, child) as SettingGroupItem) };
  }

  if ('type' in item && item.type === 'page' && item.items) {
    return { ...item, items: item.items.map(child => namespaceExtensionItem(plugin, child)) };
  }

  return item;
}

export function buildExtensionSettingsPages(groups: Readonly<Record<string, ExtensionSettingsGroup>>): ExtensionSettingsPageEntry[] {
  return Object.entries(groups)
    .sort(([, a], [, b]) => a.heading.localeCompare(b.heading))
    .map(([plugin, group]) => ({
      category: group.category ?? 'provider',
      page: {
        type: 'page',
        name: group.heading,
        desc: group.desc,
        displayValue: group.displayValue,
        status: group.status,
        items: (group.pageItems ?? group.items).map(item => namespaceExtensionItem(plugin, item)),
      },
    }));
}
