import { parseBoolean } from "places-shared/settings";

export function shouldShowEmptyMapHelp(
  blockSetting: unknown,
  globalSetting: boolean,
  trackBuilderEnabled: boolean
): boolean {
  if (trackBuilderEnabled) {
    return false;
  }

  return parseBoolean(blockSetting, globalSetting);
}
