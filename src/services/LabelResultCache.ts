import type { MapPlace } from "places-shared/overlay";
import type * as GeoJSON from 'geojson';
import { DEFAULT_PATH_MIDPOINT_LABEL_TEMPLATE } from "places-shared/settings";
import { stableSignature, stableSignatureCached } from "places-shared/utils";

const propertyAccess = String.raw`this(?:\.[\w$]+|\[(?:'[^'\\]*'|"[^"\\]*")\])+`;
const stringLiteral = String.raw`(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")`;
const stringArgument = `(?:${propertyAccess}|${stringLiteral})`;
const labelSubstitution = new RegExp(
  `\\{(?:${propertyAccess}|h\\.(?:before|after|beforeLast|afterLast)\\(\\s*${stringArgument}\\s*,\\s*${stringArgument}\\s*\\))\\}`, 'g',
);

export function labelInputSignature(place: MapPlace, templates: readonly string[]): string | undefined {
  if (templates.some(template => template !== DEFAULT_PATH_MIDPOINT_LABEL_TEMPLATE
    && template.replace(labelSubstitution, '').includes('{'))) return undefined;

  return stableSignature({
    templates, name: place.name, originalName: place.originalName ?? place.name,
    path: place.filePath, icon: place.icon, latitude: place.latitude, longitude: place.longitude, tags: place.tags,
    row: place.queryRow ? stableSignatureCached(place.queryRow) : '',
    metadata: place.metadata ? stableSignatureCached(place.metadata) : '',
  });
}

export class LabelResultCache<T> {
  private entries = new Map<string, { value: T; weight: number }>();
  private weight = 0;
  private hits = 0;
  private misses = 0;
  private bypasses = 0;

  constructor(private readonly limit = 4000, private readonly budget?: { maxWeight: number; weightOf: (value: T) => number }) {}

  get(key: string | undefined): T | undefined {
    if (key === undefined) {
      this.bypasses++;

      return undefined;
    }

    const entry = this.entries.get(key);

    if (entry !== undefined) {
      this.hits++;
      this.entries.delete(key);
      this.entries.set(key, entry);
    } else this.misses++;

    return entry?.value;
  }

  admits(count: number): boolean {
    return count <= this.limit;
  }

  stats(): { hits: number; misses: number; bypasses: number; entries: number } {
    return { hits: this.hits, misses: this.misses, bypasses: this.bypasses, entries: this.entries.size };
  }

  set(key: string, value: T): void {
    this.remove(key);
    const weight = this.budget?.weightOf(value) ?? 1;

    if (this.budget && weight > this.budget.maxWeight) return;
    this.entries.set(key, { value, weight });
    this.weight += weight;

    while (this.entries.size > this.limit || (this.budget && this.weight > this.budget.maxWeight)) {
      this.remove(this.entries.keys().next().value!);
    }
  }

  private remove(key: string): void {
    this.weight -= this.entries.get(key)?.weight ?? 0;
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.weight = 0;
  }
}

const MARKER_LABEL_LIMIT = 50_000;
const MARKER_LABEL_BUDGET_CHARS = 4_000_000;
const MARKER_LABEL_KEY_CHARS = 48;

export class PlaceLabelCaches {
  readonly markers = new LabelResultCache<string>(MARKER_LABEL_LIMIT, {
    maxWeight: MARKER_LABEL_BUDGET_CHARS,
    weightOf: label => label.length + MARKER_LABEL_KEY_CHARS,
  });
  readonly paths = new LabelResultCache<GeoJSON.Feature[]>(1000, { maxWeight: 100_000, weightOf: features => features.length });

  clear(): void {
    this.markers.clear();
    this.paths.clear();
  }
}
