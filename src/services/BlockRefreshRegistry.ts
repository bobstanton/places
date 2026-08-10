import { parseBooleanOptional } from 'places-shared/settings';
import { MapRefreshService, type RefreshableBlockEntry, type RefreshAllBlocksOptions, type RefreshableBlockRegistration } from './MapRefreshService';

// Data-driven code blocks (heatmap, chart, similar, compare) re-render when the vault index changes.
export type RefreshEntry = RefreshableBlockEntry;
export type RefreshAllOptions = RefreshAllBlocksOptions;

// The per-block `autorefresh:` option wins; otherwise data-driven blocks auto-refresh when the vault index changes.
export function resolveAutoRefreshSetting(blockValue: unknown): boolean {
  const parsedOverride = parseBooleanOptional(blockValue);
  if (parsedOverride !== undefined) {
    return parsedOverride;
  }
  return true;
}

export class BlockRefreshRegistry {
  static register(container: HTMLElement, entry: RefreshEntry): RefreshableBlockRegistration {
    return MapRefreshService.getInstance().registerBlock(container, entry);
  }

  static unregister(container: HTMLElement, registration?: RefreshableBlockRegistration): void {
    MapRefreshService.getInstance().unregisterBlock(container, registration);
  }

  static async refreshAll(options: RefreshAllOptions = {}): Promise<void> {
    await MapRefreshService.getInstance().refreshAllBlocks(options);
  }

  static async refreshForElement(element: HTMLElement): Promise<boolean> {
    return MapRefreshService.getInstance().refreshBlockForElement(element);
  }
}
