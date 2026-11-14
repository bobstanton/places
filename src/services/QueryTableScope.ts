import type { FileIndexedSource } from "vaultquery/api";

const SOURCE_TABLES: Record<Exclude<FileIndexedSource, "note">, readonly string[]> = {
  "other-file": ["other_files"],
  image: ["image_files", "image_metadata", "image_tags"],
  csv: ["_csv_files"],
};

const PLACES_VIEW_TABLES: Record<string, readonly string[]> = {
  places: ["notes", "note_properties", "properties"],
  places_simple: ["notes", "note_properties"],
  places_tracks: ["notes", "note_properties", "properties"],
  places_files: ["other_files"],
};

export function tablesForIndexedFile(source: FileIndexedSource, indexedPath: string): readonly string[] | null {
  if (source === "note") return null;

  return source === "csv" ? [...SOURCE_TABLES.csv, indexedPath] : SOURCE_TABLES[source];
}

const VAULTQUERY_TABLES = new Set([
  "notes", "note_properties", "properties", "tasks", "headings", "links", "unresolved_links",
  "embeds", "blocks", "tags", "list_items", "table_cells", "other_files", "image_files",
  "image_metadata", "image_tags", "_csv_files",
]);

function candidateRelations(query: string): string[] {
  return [...query.matchAll(/\b(?:from|join)\s+("[^"]+"|[A-Za-z_]\w*)/gi)]
    .map(match => match[1].replace(/^"|"$/g, "").toLowerCase());
}

const CONTINUED_FROM_LIST = /\b(?:from|join)\s+(?:"[^"]+"|[A-Za-z_]\w*)(?:\s+(?:as\s+)?[A-Za-z_]\w*)?\s*,/i;

export function queryReadsTables(query: string | undefined, tables: readonly string[], resolved?: ReadonlySet<string>): boolean {
  if (tables.length === 0) return true;
  if (resolved) return tables.some(table => resolved.has(table.toLowerCase()));
  if (!query) return true;

  const wanted = new Set(tables.map(table => table.toLowerCase()));
  const candidates = candidateRelations(query);

  if (!candidates.length || CONTINUED_FROM_LIST.test(query)) return true;

  for (const name of candidates) {
    if (wanted.has(name)) return true;
    const behind = PLACES_VIEW_TABLES[name];

    if (behind) {
      if (behind.some(table => wanted.has(table.toLowerCase()))) return true;
      continue;
    }

    if (VAULTQUERY_TABLES.has(name) || name.endsWith(".csv")) continue;

    return true;
  }

  return false;
}

export function relationKeys(relations: Iterable<string>): Set<string> {
  return new Set(Array.from(relations, relation => relation.toLowerCase()));
}
