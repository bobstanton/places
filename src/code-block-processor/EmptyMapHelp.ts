import { parseBoolean } from "places-shared/settings";

const EMPTY_MAP_HELP_CLASS = 'places-empty-map-help';

const LEGACY_HELP_SELECTOR = '.places-no-places-error, .places-method, .places-help-reference';

export function shouldShowEmptyMapHelp(blockSetting: unknown, globalSetting: boolean, trackBuilderEnabled: boolean): boolean {
  if (trackBuilderEnabled) {
    return false;
  }

  return parseBoolean(blockSetting, globalSetting);
}

export function renderEmptyMapHelp(container: HTMLElement, render: (host: HTMLElement) => void): void {
  clearEmptyMapHelp(container);
  render(container.createDiv({ cls: EMPTY_MAP_HELP_CLASS }));
}

export function clearEmptyMapHelp(container: HTMLElement): void {
  for (const element of container.querySelectorAll(`.${EMPTY_MAP_HELP_CLASS}, ${LEGACY_HELP_SELECTOR}`)) {
    element.remove();
  }

  for (const paragraph of container.querySelectorAll('p')) {
    if (paragraph.textContent === 'To display Places on the map, use any of these methods:') {
      paragraph.remove();
    }
  }
}
