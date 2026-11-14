import { logger, getErrorMessage, scalarToString, sleep } from "places-shared/utils";
import { App, BasesEntry, type BasesPropertyId } from "obsidian";
import { MapPlace } from "places-shared/overlay";
import { extractFrontmatterTagsFromFile } from "../services/PlaceTagExtractor";
import { PropertyMappings } from "./PlacesBasesView";
import { createMapPlaceFromProperties } from "../services/MapPlaceFactory";

export class BasesDataAdapter {
	static async convertToMapPlaces(entries: BasesEntry[], app: App, propertyMappings: PropertyMappings, options: {
		isCanceled: () => boolean;
		onTiming: (timing: { rows: number; places: number; activeMs: number; yieldMs: number; maxRowMs: number; yields: number }) => void;
	}): Promise<MapPlace[]> {
		const places: MapPlace[] = [];
		let activeMs = 0, yieldMs = 0, maxRowMs = 0, yields = 0, rows = 0;
		let sliceStarted = performance.now();

		for (const entry of entries) {
			if (options.isCanceled()) break;
			const started = performance.now();

			try {
				const cache = app.metadataCache.getFileCache(entry.file);
				const frontmatter = cache?.frontmatter;

				const locationValue = this.resolveMappedValue(entry, frontmatter, propertyMappings.locationId, propertyMappings.location);

				if (!locationValue) continue;

				const titleValue = this.resolveMappedValue(entry, frontmatter, propertyMappings.titleId, propertyMappings.title);
				const name = titleValue || entry.file.basename;

				const tags = extractFrontmatterTagsFromFile(app, entry.file.path);
				const iconValue = this.resolveMappedValue(entry, frontmatter, propertyMappings.iconId, propertyMappings.icon);
				const place = createMapPlaceFromProperties({
					properties: { ...frontmatter, Location: locationValue, icon: iconValue },
					name,
					filePath: entry.file.path,
					tags,
					metadata: { ...frontmatter, sourceFile: entry.file.path },
				});

				if (!place) continue;

				places.push(place);
			} catch (error) {
				logger.scope("Bases").debug("Skipped an entry that failed to build into a place", { path: entry.file?.path, error: getErrorMessage(error) });
			} finally {
				const elapsed = performance.now() - started;

				activeMs += elapsed;
				maxRowMs = Math.max(maxRowMs, elapsed);
				rows++;

				if (performance.now() - sliceStarted >= 8 && rows < entries.length && !options.isCanceled()) {
					const yieldStarted = performance.now();

					await sleep(0);
					yieldMs += performance.now() - yieldStarted;
					yields++;
					sliceStarted = performance.now();
				}
			}
		}

		options.onTiming({ rows, places: places.length, activeMs, yieldMs, maxRowMs, yields });

		return places;
	}

	private static resolveMappedValue(entry: BasesEntry, frontmatter: Record<string, unknown> | undefined, propertyId: BasesPropertyId | null, fallbackKey: string): string | null {
		if (propertyId) {
			const value = entry.getValue(propertyId);

			if (value !== null) {
				const text = BasesDataAdapter.formatBasesValue(value).trim();

				if (text && text.toLowerCase() !== "null") return text;
			}

			return null;
		}

		if (fallbackKey) {
			const raw = frontmatter?.[fallbackKey];
			const text = scalarToString(raw).trim();

			if (text) return text;
		}

		return null;
	}

	private static formatBasesValue(value: unknown): string {
		if (typeof value === "string") return value;
		if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
		if (value instanceof Date) return value.toISOString();

		if (typeof value === "object" && value !== null) {
			const toText = (value as { toString?: () => string }).toString;

			if (typeof toText !== "function" || toText === Object.prototype.toString) return "";

			return toText.call(value);
		}

		return "";
	}
}
