import { logger } from "places-shared/utils";
import { Place } from "places-shared/place";
import { Coordinate, PlacesBoundingBox } from "places-shared/geo";
import { IPlacesService, parseNearQuery } from "places-shared/services";
import type { PartialPlacesResultsCallback } from "places-shared/services";
import { distance } from "fastest-levenshtein";
import { Notice } from "obsidian";

export type PartialResultsCallback = PartialPlacesResultsCallback;

const ADDRESS_WORD_FORMS: ReadonlyMap<string, readonly string[]> = new Map(Object.entries({
  ave: 'avenue', av: 'avenue', st: 'street', rd: 'road', blvd: 'boulevard', dr: 'drive', ln: 'lane', ct: 'court', pl: 'place',
  hwy: 'highway', pkwy: 'parkway', ter: 'terrace', cir: 'circle', sq: 'square', trl: 'trail', mt: 'mount', ft: 'fort',
  n: 'north', s: 'south', e: 'east', w: 'west', ne: 'northeast', nw: 'northwest', se: 'southeast', sw: 'southwest',
  us: 'united states', usa: 'united states',
  al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california', co: 'colorado', de: 'delaware', fl: 'florida',
  ga: 'georgia', hi: 'hawaii', id: 'idaho', il: 'illinois', in: 'indiana', ia: 'iowa', ks: 'kansas', ky: 'kentucky', la: 'louisiana',
  me: 'maine', md: 'maryland', ma: 'massachusetts', mi: 'michigan', mn: 'minnesota', ms: 'mississippi', mo: 'missouri',
  nv: 'nevada', nh: 'new hampshire', nj: 'new jersey', nm: 'new mexico', ny: 'new york', nc: 'north carolina', nd: 'north dakota',
  oh: 'ohio', ok: 'oklahoma', or: 'oregon', pa: 'pennsylvania', ri: 'rhode island', sc: 'south carolina', sd: 'south dakota',
  tn: 'tennessee', tx: 'texas', ut: 'utah', vt: 'vermont', va: 'virginia', wa: 'washington', wv: 'west virginia', wi: 'wisconsin',
  wy: 'wyoming', dc: 'district of columbia',
}).map(([short, long]) => [short, long.split(' ')]));

export interface PlacesServiceLookup {
  getAll(): IPlacesService[];
}

export class AggregatorApiService implements IPlacesService {
  constructor(private servicesRegistry: PlacesServiceLookup) {}

  private get services(): IPlacesService[] {
    return this.servicesRegistry.getAll();
  }

  async lookupPlace(query: string, onPartialResults?: PartialResultsCallback): Promise<Array<Place>> {
    return this.search(query, onPartialResults);
  }

  private async search(query: string, onPartialResults?: PartialResultsCallback, bounds?: PlacesBoundingBox): Promise<Place[]> {
    const services = this.services;

    if (services.length === 0) {
      new Notice("No Places services are enabled.");

      return [];
    }

    if (query.length < 3) return [];

    const lookups = services.flatMap(service => {
      if (!bounds) return [() => service.lookupPlace(query)];
      const boundedLookup = service.lookupPlaceInBounds?.bind(service);

      return boundedLookup ? [() => boundedLookup(query, bounds)] : [];
    });

    if (lookups.length === 0) {
      new Notice("No enabled place provider supports bounded search.");

      return [];
    }

    const accumulated = new Map<string, Place>();
    const scoreCache = new WeakMap<Place, number>();
    const outcomes = await Promise.all(lookups.map(async lookup => {
      let results: Place[];

      try {
        results = await lookup();
      } catch (error) {
        logger.warn('Geocoding provider failed during aggregation', error);

        return false;
      }

      if (bounds) results = this.filterResultsToBounds(results, bounds);
      this.accumulateResults(accumulated, results);

      if (results.length > 0) {
        onPartialResults?.(this.sortResults([...accumulated.values()], query, scoreCache, true));
      }

      return true;
    }));

    if (outcomes.every(succeeded => !succeeded)) {
      new Notice("Every enabled place provider failed. Check the developer console for details.");
    }

    return this.sortResults([...accumulated.values()], query, scoreCache, true);
  }

  private normalizeText(text: string): string {
    return text
      .toLowerCase()
      .replace(/[\u0027\u2018\u2019\u0060]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .trim();
  }

  private normalizeForFuzzy(text: string): string {
    return text
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, '');
  }

  private searchWords(text: string): string[] {
    return text
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean)
      .flatMap(word => ADDRESS_WORD_FORMS.get(word) ?? [word]);
  }

  private calculateRelevanceScore(place: Place, queryNorm: string): number {
    const nameNorm = this.normalizeText(place.name);
    const addressNorm = this.normalizeText(place.address || "");

    if (nameNorm === queryNorm) return 1000;

    const nameFuzzy = this.normalizeForFuzzy(place.name);
    const queryFuzzy = this.normalizeForFuzzy(queryNorm);

    if (!queryFuzzy) return 0;

    if (nameFuzzy === queryFuzzy) return 950;

    const namePrefixScore = nameNorm.startsWith(queryNorm)
      ? 800 + (queryNorm.length / nameNorm.length) * 100
      : nameFuzzy.startsWith(queryFuzzy)
        ? 750 + (queryFuzzy.length / nameFuzzy.length) * 50
        : 0;

    const queryWords = this.searchWords(queryNorm).filter(word => word.length >= 2 || /\p{N}/u.test(word));
    const placeWordSet = new Set(this.searchWords([place.name, place.address, place.city, place.state, place.postalCode, place.country].join(' ')));
    const matchedCount = queryWords.filter(word => placeWordSet.has(word)).length;
    const tokenScore = queryWords.length >= 2 && matchedCount >= 2
      ? 700 + (matchedCount / queryWords.length) * 150
      : 0;
    const containsScore = nameNorm.includes(queryNorm)
      ? 500
      : nameFuzzy.includes(queryFuzzy)
        ? 450
        : addressNorm.includes(queryNorm) ? 400 : 0;
    const addressPrefixScore = addressNorm.startsWith(queryNorm)
      ? 550 + (queryNorm.length / addressNorm.length) * 100
      : 0;
    const maxLength = Math.max(nameFuzzy.length, queryFuzzy.length, 1);
    const editScore = 300 * (1 - distance(nameFuzzy, queryFuzzy) / maxLength);

    return Math.max(0, namePrefixScore, tokenScore, containsScore, addressPrefixScore, editScore);
  }

  private getDeduplicationKey(place: Place): string {
    const nameNorm = this.normalizeText(place.name);

    // Pending coordinates are placeholders (Mapbox suggest): keying them on
    // 0,0 would collapse every same-name result. Until they resolve, the
    // address is what tells two branches of a chain apart.
    if (place.coordinatesPending) {
      return `${nameNorm}|${this.normalizeText(place.address)}`;
    }

    const latRounded = place.latitude ? Math.round(place.latitude * 10000) / 10000 : 0;
    const lonRounded = place.longitude ? Math.round(place.longitude * 10000) / 10000 : 0;

    return `${nameNorm}|${latRounded}|${lonRounded}`;
  }

  private deduplicateResults(results: Place[]): Place[] {
    const deduplicated = new Map<string, Place>();

    this.accumulateResults(deduplicated, results);

    return [...deduplicated.values()];
  }

  private accumulateResults(accumulated: Map<string, Place>, results: Place[]): void {
    for (const result of results) {
      const key = this.getDeduplicationKey(result);
      const existing = accumulated.get(key);

      if (!existing || this.compareCompleteness(result, existing) < 0) {
        accumulated.set(key, result);
      }
    }
  }

  private filterResultsToBounds(results: Place[], bounds: PlacesBoundingBox): Place[] {
    return results.filter(place => {
      if (!Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)) {
        return true;
      }

      // Placeholder coordinates awaiting resolvePlace (Mapbox suggest) cannot
      // be bounds-checked; the result stays and resolves on selection.
      if (place.coordinatesPending) {
        return true;
      }

      return bounds.contains(place.latitude, place.longitude);
    });
  }

  private sortResults(allResults: Place[], query: string, scoreCache?: WeakMap<Place, number>, alreadyUnique = false): Place[] {
    const uniqueResults = alreadyUnique ? allResults : this.deduplicateResults(allResults);

    const parsedQuery = parseNearQuery(query);
    const searchTerm = parsedQuery ? parsedQuery.poi : query;
    const queryNorm = this.normalizeText(searchTerm);

    const scored = uniqueResults.map(place => ({
      place,
      score: scoreCache?.get(place) ?? this.calculateAndCacheScore(place, queryNorm, scoreCache)
    }));

    scored.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;

      return this.compareCompleteness(a.place, b.place);
    });

    return scored.map(s => s.place);
  }

  public rankResults(results: Place[], query: string): Place[] {
    return this.sortResults(results, query);
  }

  private calculateAndCacheScore(place: Place, queryNorm: string, cache?: WeakMap<Place, number>): number {
    const score = this.calculateRelevanceScore(place, queryNorm);

    cache?.set(place, score);

    return score;
  }

  async lookupPlaceByCoordinates(coordinate: Coordinate): Promise<Array<Place>> {
    const services = this.services;

    if (services.length === 0) {
      new Notice("No Places services are enabled.");

      return [];
    }

    const outcomes = await Promise.all(services.map(service => this.tryCallServiceByCoordinates(service, coordinate)));

    if (outcomes.every(outcome => outcome.error !== undefined)) {
      new Notice("Every enabled reverse-geocoding provider failed. Check the developer console for details.");
    }

    const allResults = outcomes.flatMap(outcome => outcome.results);

    return allResults.sort((a, b) => {
      const aAddressScore = this.getAddressCompleteness(a);
      const bAddressScore = this.getAddressCompleteness(b);

      if (aAddressScore !== bAddressScore) {
        return bAddressScore - aAddressScore;
      }

      return a.name.localeCompare(b.name);
    });
  }

  private async tryCallServiceByCoordinates(service: IPlacesService, coordinate: Coordinate): Promise<{ results: Place[]; error?: unknown }> {
    try {
      return { results: await service.lookupPlaceByCoordinates(coordinate) };
    } catch (error) {
      logger.warn('Reverse geocoding provider failed during aggregation', error);

      return { results: [], error };
    }
  }

  private compareCompleteness(a: Place, b: Place): number {
    const completenessDifference = this.getCompleteness(b) - this.getCompleteness(a);

    if (completenessDifference !== 0) return completenessDifference;

    const websiteDifference = Number(Boolean(b.website?.trim())) - Number(Boolean(a.website?.trim()));

    if (websiteDifference !== 0) return websiteDifference;

    const tagDifference = this.getUniqueTagCount(b) - this.getUniqueTagCount(a);

    if (tagDifference !== 0) return tagDifference;

    return a.name.localeCompare(b.name)
      || a.address.localeCompare(b.address)
      || a.source.localeCompare(b.source);
  }

  private getCompleteness(place: Place): number {
    const textFields = [
      place.name,
      place.address,
      place.city,
      place.state,
      place.postalCode,
      place.country,
      place.website,
    ];
    const textFieldCount = textFields.filter(value => Boolean(value?.trim())).length;
    const hasLocation = place.coordinatesPending
      || (Number.isFinite(place.latitude) && Number.isFinite(place.longitude));

    return textFieldCount + Number(hasLocation) + Number(this.getUniqueTagCount(place) > 0);
  }

  private getUniqueTagCount(place: Place): number {
    return new Set((place.tags ?? []).map(tag => tag.trim().toLowerCase()).filter(Boolean)).size;
  }

  private getAddressCompleteness(place: Place): number {
    let score = 0;

    if (place.name) score += 1;
    if (place.address) score += 1;
    if (place.city) score += 1;
    if (place.state) score += 1;
    if (place.country) score += 1;
    if (place.website) score += 1;
    if (place.latitude) score += 1;
    if (place.longitude) score += 1;

    return score;
  }

  public hasAvailableServices(): boolean {
    return this.services.length > 0;
  }

  async lookupPlaceInBounds(query: string, bounds: PlacesBoundingBox, onPartialResults?: PartialResultsCallback): Promise<Place[]> {
    return this.search(query, onPartialResults, bounds);
  }
}
