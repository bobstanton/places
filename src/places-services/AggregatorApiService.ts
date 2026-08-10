import { logger } from "places-shared/utils";
import { Place } from "places-shared/place";
import { Coordinate, PlacesBoundingBox } from "places-shared/geo";
import { IPlacesService, parseNearQuery } from "places-shared/services";
import { ServiceRegistry } from "../services/ServiceRegistry";
import type { PartialPlacesResultsCallback } from "places-shared/services";
import { distance } from "fastest-levenshtein";
import { Notice } from "obsidian";

export type PartialResultsCallback = PartialPlacesResultsCallback;

export class AggregatorApiService implements IPlacesService {
  constructor(private servicesRegistry: ServiceRegistry<IPlacesService>) {}

  private get services(): IPlacesService[] {
    return this.servicesRegistry.getAll();
  }

  async lookupPlace(query: string, onPartialResults?: PartialResultsCallback): Promise<Array<Place>> {
    const services = this.services;
    if (services.length === 0) {
      new Notice("No Places services are enabled.");
      return [];
    }
    if (query.length < 3) {
      return [];
    }

    const accumulated = new Map<string, Place>();
    const scoreCache = new WeakMap<Place, number>();

    const promises = services.map(async service => {
      const outcome = await this.tryCallService(service, query);
      const results = outcome.results;
      for (const result of results) {
        const key = this.getDeduplicationKey(result);
        if (!accumulated.has(key)) accumulated.set(key, result);
      }

      if (onPartialResults && results.length > 0) {
        const sorted = this.sortResults([...accumulated.values()], query, scoreCache, true);
        onPartialResults(sorted);
      }

      return outcome;
    });

    const outcomes = await Promise.all(promises);
    if (outcomes.every(outcome => outcome.error !== undefined)) {
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

    const queryWords = queryNorm.split(/[^\p{L}\p{N}]+/u).filter(word => word.length >= 2);
    const nameWordSet = new Set(nameNorm.split(/[^\p{L}\p{N}]+/u));
    const matchedCount = queryWords.filter(word => nameWordSet.has(word)).length;
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
    const seen = new Set<string>();
    const deduplicated: Place[] = [];

    for (const place of results) {
      const key = this.getDeduplicationKey(place);
      if (!seen.has(key)) {
        seen.add(key);
        deduplicated.push(place);
      }
    }

    return deduplicated;
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

    scored.sort((a, b) => b.score - a.score);

    return scored.map(s => s.place);
  }

  private calculateAndCacheScore(place: Place, queryNorm: string, cache?: WeakMap<Place, number>): number {
    const score = this.calculateRelevanceScore(place, queryNorm);
    cache?.set(place, score);
    return score;
  }

  private async tryCallService(service: IPlacesService, query: string): Promise<{ results: Place[]; error?: unknown }> {
    try {
      return { results: await service.lookupPlace(query) };
    } catch (error) {
      logger.warn('Geocoding provider failed during aggregation', error);
      return { results: [], error };
    }
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

  // onPartialResults fires as each service returns results.
  async lookupPlaceInBounds(query: string, bounds: PlacesBoundingBox, onPartialResults?: PartialResultsCallback): Promise<Place[]> {
    const services = this.services;
    if (services.length === 0) {
      new Notice("No Places services are enabled.");
      return [];
    }
    if (query.length < 3) {
      return [];
    }

    const accumulated = new Map<string, Place>();
    const scoreCache = new WeakMap<Place, number>();

    const promises = services.map(async service => {
      const results = await this.tryCallServiceInBounds(service, query, bounds);
      const boundedResults = this.filterResultsToBounds(results, bounds);
      for (const result of boundedResults) {
        const key = this.getDeduplicationKey(result);
        if (!accumulated.has(key)) accumulated.set(key, result);
      }

      if (onPartialResults && boundedResults.length > 0) {
        const sorted = this.sortResults([...accumulated.values()], query, scoreCache, true);
        onPartialResults(sorted);
      }

      return results;
    });

    await Promise.all(promises);
    return this.sortResults([...accumulated.values()], query, scoreCache, true);
  }

  private async tryCallServiceInBounds(service: IPlacesService, query: string, bounds: PlacesBoundingBox): Promise<Place[]> {
    if (!service.lookupPlaceInBounds) {
      return [];
    }

    try {
      const results = await service.lookupPlaceInBounds(query, bounds);
      return results;
    } catch (e) {
      logger.error(`${service.constructor.name} error:`, e);
      return [];
    }
  }
}
