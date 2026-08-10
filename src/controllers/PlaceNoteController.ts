import { App, Notice, TFile, normalizePath } from "obsidian";
import { Place } from "places-shared/place";
import { resolveDefaultMarkerIcon } from "places-shared/map";
import { IPlacesPluginSettings } from "places-shared/settings";
import { Utilities, formatDisplayCoordinate } from "places-shared/utils";
import { preparePlaceTags } from "../services/PlaceTagFilter";
import { TemplateService } from "../services/TemplateService";

// Updates a place note that already exists, from a re-resolved provider result.
//
// The update-path counterpart to `PlaceNoteCreationService` (behavior contract
// #6), which owns creation. Both write the same vocabulary of fields and both
// resolve icons through the configured marker icon rules, but an update differs
// where the note already has content: incoming tags merge with the note's own
// rather than replacing them, and an icon is written only when the note has
// none. Do not "unify" those two rules away.
export class PlaceNoteController {
  constructor(
    private readonly app: App,
    private readonly getSettings: () => IPlacesPluginSettings,
  ) {}

  async sync(file: TFile, place: Place): Promise<void> {
    await this.rename(file, place);
    await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
      Object.assign(frontmatter, this.buildFrontmatter(file, place, frontmatter));
    });
  }

  private async rename(file: TFile, place: Place): Promise<void> {
    const format = this.getSettings().noteNameFormat;
    if (!format) return;
    const originalValues = TemplateService.extractValues(format, file.basename);
    if (originalValues.size === 0) originalValues.set("placeLabel", file.basename);
    const name = Utilities.sanitizeFilename(TemplateService.replaceDollar(format, place, originalValues));
    if (file.basename === name) return;
    const path = normalizePath(`${file.parent?.path}/${name}.md`);
    if (this.app.vault.getFileByPath(path)) {
      new Notice(`File already exists: ${name}.md`);
      return;
    }
    await this.app.fileManager.renameFile(file, path);
  }

  private buildFrontmatter(file: TFile, place: Place, frontmatter: Record<string, unknown>): Record<string, unknown> {
    const values: Record<string, unknown> = { Location: formatDisplayCoordinate(place) };
    if (place.address?.trim()) values.Address = place.address;
    if (place.website?.trim()) values.Website = place.website;
    const tags = preparePlaceTags(place.tags, this.getSettings().newPlaceTagFilterPatterns);
    const existing: unknown = frontmatter.tags;
    const existingTags = Array.isArray(existing)
      ? existing.filter((tag): tag is string => typeof tag === "string")
      : typeof existing === "string" ? [existing] : [];
    const existingNames = new Set(existingTags.map((tag) => tag.toLowerCase()));
    const additions = tags.filter((tag) => !existingNames.has(tag.toLowerCase()));
    const mergedTags = [...existingTags, ...additions];
    if (additions.length > 0) values.tags = mergedTags;

    const explicitIcon = typeof frontmatter.icon === "string" ? frontmatter.icon.trim() : "";
    if (explicitIcon === "") {
      values.icon = resolveDefaultMarkerIcon(mergedTags, file.basename);
    }
    return values;
  }
}
