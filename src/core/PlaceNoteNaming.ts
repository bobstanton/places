import { placeNoteName } from "./map/PlaceNoteContent";
import { type GeocodedPlaceNoteRequest, type LocationPlaceNoteRequest, type PoiPlaceNoteRequest } from "places-shared/map";
import { Utilities } from 'places-shared/utils';
import { TemplateService } from './TemplateService';

export function formatPlaceNoteName(name: string, values: Record<string, unknown>, format?: string, originalValues = new Map<string, string>()): string {
  const fallback = Utilities.sanitizeFilename(name) || 'New Place';

  if (!format) return fallback;
  const fields = Object.fromEntries(TemplateService.extractPlaceholders(format).map(key => [key, undefined]));
  const rendered = TemplateService.replaceDollar(format, { ...fields, placeLabel: name, ...values }, originalValues);

  return Utilities.sanitizeFilename(rendered) || fallback;
}

export function formatPlaceNoteRequestName(request: PoiPlaceNoteRequest | LocationPlaceNoteRequest | GeocodedPlaceNoteRequest, format?: string): string {
  const coordinate = request.kind === 'location' ? request.coordinate : { latitude: request.lat, longitude: request.lng };
  const name = placeNoteName(request);

  return formatPlaceNoteName(name, { ...request, ...coordinate, name }, format);
}
