import { App, Notice, TFile, normalizePath } from "obsidian";
import { Place } from "places-shared/place";
import { matchMarkerIconRule } from "places-shared/map";
import { IPlacesPluginSettings } from "places-shared/settings";
import { formatDisplayCoordinate } from "places-shared/utils";
import { formatPlaceNoteName } from "../services/PlaceNoteNaming";
import { preparePlaceTags } from "../core/map/PlaceTagFilter";
import { normalizeFrontmatterTags } from "places-shared/map";
import { TemplateService } from "../services/TemplateService";

export class PlaceNoteController {
  constructor(private readonly app: App, private readonly getSettings: () => IPlacesPluginSettings) {}

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
    const name = formatPlaceNoteName(file.basename, place, format, originalValues);

    if (file.basename === name) return;
    const folder = file.parent?.path;
    const path = normalizePath(folder ? `${folder}/${name}.md` : `${name}.md`);

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
    const existingTags = normalizeFrontmatterTags(frontmatter.tags);
    const existingNames = new Set(existingTags.map((tag) => tag.toLowerCase()));
    const additions = tags.filter((tag) => !existingNames.has(tag.toLowerCase()));
    const mergedTags = [...existingTags, ...additions];

    if (additions.length > 0) values.tags = mergedTags;

    const explicitIcon = typeof frontmatter.icon === "string" ? frontmatter.icon.trim() : "";

    if (explicitIcon === "") {
      const icon = matchMarkerIconRule(mergedTags, file.basename, file.path);

      if (icon) values.icon = icon;
    }

    return values;
  }
}
