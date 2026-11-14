import { App, getFrontMatterInfo, parseYaml } from 'obsidian';
import { readKnapTemplateFile } from "places-shared/obsidian/services";
import { renderKnapTemplate } from "places-shared/services";
import type { GeocodedPlaceNoteRequest, LocationPlaceNoteRequest, PoiPlaceNoteRequest } from "places-shared/map";

export async function renderPlaceNoteTemplate(
  app: App,
  reference: string,
  request: PoiPlaceNoteRequest | LocationPlaceNoteRequest | GeocodedPlaceNoteRequest,
  note: { name: string; path: string },
  properties: Record<string, unknown>,
): Promise<{ body: string; properties: Record<string, unknown> }> {
  const template = await readKnapTemplateFile(app, reference, request.sourcePath);
  const coordinate = request.kind === 'location' ? request.coordinate : { latitude: request.lat, longitude: request.lng };
  const rendered = await renderKnapTemplate(template, {
    ...request,
    ...coordinate,
    name: request.kind === 'location' ? note.name : request.name,
    title: note.name,
    path: note.path,
    date: new Date().toISOString(),
    tags: properties.tags ?? [],
    place: { ...request, ...coordinate },
    properties,
  });
  const info = getFrontMatterInfo(rendered);

  if (!info.exists) {
    if (/^\uFEFF?---\r?\n/.test(rendered)) throw new Error('Place template frontmatter is missing its closing --- delimiter.');

    return { body: rendered, properties: {} };
  }

  const parsed: unknown = parseYaml(info.frontmatter);

  if (parsed != null && (typeof parsed !== 'object' || Array.isArray(parsed))) {
    throw new Error('Place template frontmatter must be a YAML mapping.');
  }

  return { body: rendered.slice(info.contentStart), properties: (parsed ?? {}) as Record<string, unknown> };
}
