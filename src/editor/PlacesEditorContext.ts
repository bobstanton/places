import type { EditorState } from "@codemirror/state";

export interface PlacesFence {
  language: string;
  startLine: number;
  endLine: number;
}

// Structural parents whose children indent on Enter but that carry no
// schema-declared sub-keys or list templates (string-rule lists). Keys with
// nestedKeys/listItemTemplates in the CodeBlockRegistry indent through
// isYamlChildBlockKey without appearing here.
export const YAML_CHILD_BLOCK_KEYS = new Set(["iconStyles", "labelStyles"]);

export function isPlacesCodeBlock(language: string): boolean {
  return language === "places" || language.startsWith("places-");
}

export function getLineIndent(line: string): number {
  return line.match(/^\s*/u)?.[0].length ?? 0;
}

export function getYamlEmptyKey(trimmedLine: string): string | null {
  return trimmedLine.match(/^([A-Za-z][\w-]*)\s*:\s*$/u)?.[1] ?? null;
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
