import { completionStatus } from "@codemirror/autocomplete";
import { getIndentUnit, indentService, indentString, type IndentContext } from "@codemirror/language";
import { EditorSelection, Prec, type Extension } from "@codemirror/state";
import { keymap, type Command } from "@codemirror/view";
import { CodeBlockRegistry } from "../services/CodeBlockRegistry";
import { getPlacesFenceAtPos, getPreviousMeaningfulLine, getYamlEmptyKey, YAML_CHILD_BLOCK_KEYS } from "./PlacesEditorContext";

const YAML_LIST_ITEM = /^(\s*)-\s?(.*)$/u;
const YAML_BLOCK_SCALAR_VALUE = /^[A-Za-z][\w-]*\s*:\s*[|>](?:[1-9][+-]?|[+-][1-9]?)?\s*$/u;

export function isYamlChildBlockKey(blockType: string, key: string): boolean {
  return YAML_CHILD_BLOCK_KEYS.has(key) || CodeBlockRegistry.instance.hasChildBlockKeys(blockType, key);
}

function getPlacesIndent(context: IndentContext, pos: number): number | null | undefined {
  const fence = getPlacesFenceAtPos(context.state, pos);
  if (!fence) {
    return undefined;
  }

  const currentLine = context.lineAt(pos);
  const currentTrimmed = currentLine.text.trim();
  if (currentTrimmed) {
    return undefined;
  }

  const previous = getPreviousMeaningfulLine(context.state, fence, context.state.doc.lineAt(pos).number);
  if (!previous) {
    return undefined;
  }

  const previousTrimmed = previous.text.trim();
  const previousIndent = context.lineIndent(previous.from);
  const previousKey = getYamlEmptyKey(previousTrimmed);
  if (previousKey && isYamlChildBlockKey(fence.language, previousKey)) {
    return previousIndent + context.unit;
  }

  const previousListItem = previous.text.match(YAML_LIST_ITEM);
  if (previousListItem) {
    return previousListItem[1].length;
  }

  return previousIndent;
}

export const continuePlacesYamlList: Command = (view) => {
  const { state } = view;
  // Let CodeMirror's completion keymap consume Enter while its popup is open.
  if (completionStatus(state) !== null) {
    return false;
  }

  const changes = state.changeByRange((range) => {
    if (!range.empty) {
      return { range };
    }

    const fence = getPlacesFenceAtPos(state, range.from);
    if (!fence) {
      return { range };
    }

    const line = state.doc.lineAt(range.from);
    const beforeCursor = line.text.slice(0, range.from - line.from);
    const listItem = beforeCursor.match(YAML_LIST_ITEM);
    if (!listItem) {
      return { range };
    }

    const indent = listItem[1];
    const contentBeforeCursor = listItem[2].trim();
    const afterCursor = line.text.slice(range.from - line.from);

    if (!afterCursor.trim() && YAML_BLOCK_SCALAR_VALUE.test(contentBeforeCursor)) {
      const insert = `\n${indent}${indentString(state, getIndentUnit(state))}`;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.cursor(range.from + insert.length),
      };
    }

    if (!contentBeforeCursor && !afterCursor.trim()) {
      return {
        changes: { from: line.from, to: range.from, insert: indent },
        range: EditorSelection.cursor(line.from + indent.length),
      };
    }

    const insert = `\n${indent}- `;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(range.from + insert.length),
    };
  });

  if (changes.changes.empty) {
    return false;
  }

  view.dispatch(state.update(changes, { userEvent: "input" }));
  return true;
};

export const placesIndentExtension: Extension = [
  indentService.of(getPlacesIndent),
  Prec.highest(keymap.of([{ key: "Enter", run: continuePlacesYamlList }])),
];
