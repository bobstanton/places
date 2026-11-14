import { scanYamlStructure, type YamlLine, type YamlScope } from "places-shared/settings";
import type { EditorState } from "@codemirror/state";

export interface PlacesFence {
  language: string;
  startLine: number;
  endLine: number;
}

export function isPlacesCodeBlock(language: string): boolean {
  return language === "places" || language.startsWith("places-");
}

export function getYamlEmptyKey(trimmedLine: string): string | null {
  return trimmedLine.match(/^([A-Za-z][\w.-]*)\s*:\s*(?:#.*)?$/u)?.[1] ?? null;
}

export function getPlacesFenceAtLine(state: EditorState, lineNumber: number): PlacesFence | null {
  const doc = state.doc;

  for (let startLine = lineNumber; startLine >= 1; startLine--) {
    const line = doc.line(startLine).text.trim();

    if (!line.startsWith("```")) {
      continue;
    }

    if (startLine === lineNumber) {
      return null;
    }

    const language = line.slice(3).trim().split(/\s+/u)[0] ?? "";

    if (!isPlacesCodeBlock(language)) {
      return null;
    }

    for (let endLine = startLine + 1; endLine <= doc.lines; endLine++) {
      if (doc.line(endLine).text.trim().startsWith("```")) {
        return endLine >= lineNumber ? { language, startLine, endLine } : null;
      }
    }

    return { language, startLine, endLine: doc.lines };
  }

  return null;
}

export function getPlacesFenceAtPos(state: EditorState, pos: number): PlacesFence | null {
  return getPlacesFenceAtLine(state, state.doc.lineAt(pos).number);
}

export function getPreviousMeaningfulLine(state: EditorState, fence: PlacesFence, lineNumber: number): { text: string; from: number; lineNumber: number } | null {
  for (let currentLine = lineNumber - 1; currentLine > fence.startLine; currentLine--) {
    const line = state.doc.line(currentLine);
    const trimmed = line.text.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    return { text: line.text, from: line.from, lineNumber: currentLine };
  }

  return null;
}

const structures = new WeakMap<EditorState["doc"], Map<number, YamlLine[]>>();

export function getPlacesYamlLine(state: EditorState, fence: PlacesFence, lineNumber: number): YamlLine {
  let blocks = structures.get(state.doc);

  if (!blocks) structures.set(state.doc, blocks = new Map<number, YamlLine[]>());
  let lines = blocks.get(fence.startLine);

  if (!lines) {
    const last = state.doc.line(fence.endLine).text.trim().startsWith("```") ? fence.endLine - 1 : fence.endLine;

    lines = scanYamlStructure(Array.from({ length: last - fence.startLine }, (_, index) => state.doc.line(fence.startLine + index + 1).text));
    blocks.set(fence.startLine, lines);
  }

  return lines[lineNumber - fence.startLine - 1];
}

export function getListParentKey(state: EditorState, fence: PlacesFence, lineNumber: number): string | null {
  return getPlacesYamlLine(state, fence, lineNumber)?.scope.path.split('.').slice(-1)[0] || null;
}

export function yamlScopeValues(scope: YamlScope, inherit = false): Map<string, string> {
  const values = inherit && scope.parent ? yamlScopeValues(scope.parent, true) : new Map<string, string>();

  for (const [key, field] of scope.fields) {
    const value = field.value.trim().replace(/\s+#.*$/u, '').replace(/^['"]|['"]$/gu, '');

    if (value) values.set(key, value);
  }

  return values;
}
