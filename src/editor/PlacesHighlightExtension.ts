import { syntaxTree } from '@codemirror/language';
import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import PlacesPlugin from '../main';
import { isCacheSettingValue, STYLE_RULE_KEYS } from "places-shared/settings";
import { CodeBlockRegistry, COMMON_KEYS, MAP_KEYS, QUERY_KEYS_HIGHLIGHT } from '../services/CodeBlockRegistry';
import { getYamlColumn, getYamlBlockScalarContentIndent, isQueryBlockContentLine, isYamlBlockScalarIndicator } from "places-shared/settings";

const KEY_CSS = 'css';
const KEY_RADIUS = 'radius';
const KEY_MAP_PROVIDER = 'mapProvider';

const FALLBACK_KEYS_SET = new Set([...COMMON_KEYS, ...MAP_KEYS]);
// optionsQuery is nested under queryParameters, not a root key (which is why it
// is not in QUERY_KEYS_HIGHLIGHT), but its value is SQL exactly like query:
// and shares the same tokenization, inline or as an indented continuation.
const QUERY_KEYS_SET = new Set([...QUERY_KEYS_HIGHLIGHT, 'optionsQuery']);

const keywordMark = Decoration.mark({
  class: 'cm-keyword',
  attributes: { spellcheck: 'false' },
});
const invalidKeyMark = Decoration.mark({ class: 'cm-places-invalid-key' });
const stringMark = Decoration.mark({ class: 'cm-string' });
const numberMark = Decoration.mark({ class: 'cm-number' });
const operatorMark = Decoration.mark({ class: 'cm-operator' });
const punctuationMark = Decoration.mark({ class: 'cm-places-punctuation' });  
const commentMark = Decoration.mark({ class: 'cm-comment' });
const metaMark = Decoration.mark({ class: 'cm-meta' });
const linkMark = Decoration.mark({ class: 'cm-link' });
const knownValueMark = Decoration.mark({ class: 'cm-places-valid-value' });
const invalidValueMark = Decoration.mark({ class: 'cm-places-invalid-value' });

// A value that is a placeholder cannot be validated against known values - it
// is substituted before the block is parsed. Covers `{parameter.*}` (control
// values) and `{note.*}` (the note's frontmatter).
function containsParameterPlaceholder(text: string): boolean {
  return text.includes('{parameter.') || text.includes('{note.');
}

// The first colon that is NOT inside a quoted string, or -1. A named-coordinate
// value like `- "Downtown Scranton: 41.4, -75.6"` must not be split at the colon
// inside its quotes, or the quoted text would be mistaken for an invalid key.
function firstUnquotedColon(text: string): number {
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < text.length; i++) {
    const character = text[i];

    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ':') {
      return i;
    }
  }

  return -1;
}

const cssSelectorMark = Decoration.mark({ class: 'cm-tag' });
const cssPropertyMark = Decoration.mark({ class: 'cm-propertyName' });
const sqlKeywordMark = Decoration.mark({ class: 'cm-keyword' });
const sqlFunctionMark = Decoration.mark({ class: 'cm-variableName cm-function' });
const sqlTypeMark = Decoration.mark({ class: 'cm-typeName' });

function isPlacesCodeBlock(languageId: string): boolean {
  return languageId === 'places' || languageId.startsWith('places-');
}

function isKeyValidForBlock(key: string, blockType: string): boolean {
  const validKeys = CodeBlockRegistry.instance.getValidKeys(blockType);

  if (validKeys) {
    return validKeys.has(key);
  }

  // For unknown block types (future sub-plugins), accept common keys
  return FALLBACK_KEYS_SET.has(key);
}

// A nested-only key (or an unknown key) used at the root is flagged, the same as any
// other unrecognized key - the parser simply ignores it.
function isRootKeyValidForBlock(key: string, blockType: string): boolean {
  const rootKeys = CodeBlockRegistry.instance.getRootKeys(blockType);

  if (rootKeys) {
    return rootKeys.has(key);
  }

  return FALLBACK_KEYS_SET.has(key);
}

function getKnownValuesForKey(key: string): Set<string> | undefined {
  return CodeBlockRegistry.instance.getKnownValues(key);
}

function isMultiValueKeyForBlock(blockType: string, key: string): boolean {
  return CodeBlockRegistry.instance.getMultiValueKeysForBlock(blockType).has(key);
}

function tokenizeDelimitedKnownValues(trimmed: string, baseOffset: number, builder: RangeSetBuilder<Decoration>, knownValues: Set<string>): void {
  let segmentStart = 0;

  for (let i = 0; i <= trimmed.length; i++) {
    const atEnd = i === trimmed.length;
    const isComma = !atEnd && trimmed[i] === ',';

    if (!atEnd && !isComma) {
      continue;
    }

    const rawPart = trimmed.slice(segmentStart, i);
    const trimmedPart = rawPart.trim();

    if (trimmedPart.length > 0) {
      const innerOffset = rawPart.indexOf(trimmedPart);
      const from = baseOffset + segmentStart + innerOffset;
      const to = from + trimmedPart.length;
      const lower = trimmedPart.toLowerCase();

      if (knownValues.has(lower)) {
        builder.add(from, to, knownValueMark);
      } else if (containsParameterPlaceholder(trimmedPart)) {
        builder.add(from, to, metaMark);
      } else {
        builder.add(from, to, invalidValueMark);
      }
    }

    if (isComma) {
      builder.add(baseOffset + i, baseOffset + i + 1, punctuationMark);
    }

    segmentStart = i + 1;
  }
}

function getNewKeyIfStarting(text: string, blockType: string): string | null {
  if (text.match(/^\s/) || !text.includes(':')) {
    return null;
  }

  const possibleKey = text.split(':')[0].trim();

  return isKeyValidForBlock(possibleKey, blockType) ? possibleKey : null;
}

function tokenizeListItem(text: string, baseOffset: number, builder: RangeSetBuilder<Decoration>): boolean {
  const trimmed = text.trim();

  if (!trimmed.startsWith('-')) {
    return false;
  }

  const dashPos = text.indexOf('-');

  builder.add(baseOffset + dashPos, baseOffset + dashPos + 1, operatorMark);
  tokenizeStyleRule(text.substring(dashPos + 1), baseOffset + dashPos + 1, builder);

  return true;
}

function consumeBlockComment(text: string, pos: number): number {
  const len = text.length;

  pos += 2;
  while (pos < len - 1 && !(text[pos] === '*' && text[pos + 1] === '/')) pos++;

  return Math.min(pos + 2, len);
}

function consumeQuotedString(text: string, pos: number, quote: '"' | "'", doubledQuoteEscape = false): number {
  const len = text.length;

  pos++;

  while (pos < len) {
    if (doubledQuoteEscape && text[pos] === quote && text[pos + 1] === quote) {
      pos += 2;
      continue;
    }

    if (text[pos] === quote) {
      return pos + 1;
    }

    pos++;
  }

  return pos;
}

function tokenizeSql(text: string, baseOffset: number, builder: RangeSetBuilder<Decoration>): void {
  const syntax = PlacesPlugin.getSqlSyntax();

  if (!syntax) return;

  let pos = 0;
  const len = text.length;

  while (pos < len) {
    const char = text[pos];

    if (/\s/.test(char)) {
      pos++;
      continue;
    }

    if (char === '-' && text[pos + 1] === '-') {
      const start = pos;

      while (pos < len && text[pos] !== '\n') pos++;
      builder.add(baseOffset + start, baseOffset + pos, commentMark);
      continue;
    }

    if (char === '/' && text[pos + 1] === '*') {
      const start = pos;

      pos = consumeBlockComment(text, pos);
      builder.add(baseOffset + start, baseOffset + pos, commentMark);
      continue;
    }

    if (char === "'") {
      const start = pos;

      pos = consumeQuotedString(text, pos, "'", true);
      builder.add(baseOffset + start, baseOffset + pos, stringMark);
      continue;
    }

    if (char === '"') {
      const start = pos;

      pos = consumeQuotedString(text, pos, '"');
      builder.add(baseOffset + start, baseOffset + pos, stringMark);
      continue;
    }

    if (/\d/.test(char) || (char === '.' && /\d/.test(text[pos + 1] || ''))) {
      const start = pos;

      while (pos < len && /[\d.eE+-]/.test(text[pos])) pos++;
      builder.add(baseOffset + start, baseOffset + pos, numberMark);
      continue;
    }

    if (/[a-zA-Z_]/.test(char)) {
      const start = pos;

      while (pos < len && /[a-zA-Z0-9_]/.test(text[pos])) pos++;
      const word = text.slice(start, pos);
      const lowerWord = word.toLowerCase();

      if (syntax.keywords.has(lowerWord)) {
        builder.add(baseOffset + start, baseOffset + pos, sqlKeywordMark);
      } else if (syntax.functions.has(lowerWord)) {
        builder.add(baseOffset + start, baseOffset + pos, sqlFunctionMark);
      } else if (syntax.types.has(lowerWord)) {
        builder.add(baseOffset + start, baseOffset + pos, sqlTypeMark);
      } else {
        builder.add(baseOffset + start, baseOffset + pos, cssPropertyMark); // Column/table names
      }

      continue;
    }

    const twoChar = text.slice(pos, pos + 2);

    if (twoChar === '<>' || twoChar === '!=' || twoChar === '<=' || twoChar === '>=' || twoChar === '||') {
      builder.add(baseOffset + pos, baseOffset + pos + 2, operatorMark);
      pos += 2;
      continue;
    }

    if ('=<>+-*/%'.includes(char)) {
      builder.add(baseOffset + pos, baseOffset + pos + 1, operatorMark);
      pos++;
      continue;
    }

    if ('()[]'.includes(char)) {
      builder.add(baseOffset + pos, baseOffset + pos + 1, operatorMark);
      pos++;
      continue;
    }

    // Skip commas, semicolons
    pos++;
  }
}

function tokenizeCssContent(text: string, baseOffset: number, builder: RangeSetBuilder<Decoration>): void {
  let pos = 0;
  const len = text.length;

  while (pos < len) {
    const char = text[pos];

    if (/\s/.test(char)) {
      pos++;
      continue;
    }

    if (char === '/' && text[pos + 1] === '*') {
      const start = pos;

      pos = consumeBlockComment(text, pos);
      builder.add(baseOffset + start, baseOffset + pos, commentMark);
      continue;
    }

    if (char === '.' || char === '#') {
      const start = pos;

      pos++;
      while (pos < len && /[a-zA-Z0-9_-]/.test(text[pos])) pos++;

      if (text[pos] === '[') {
        while (pos < len && text[pos] !== ']') pos++;
        if (pos < len) pos++;
      }

      builder.add(baseOffset + start, baseOffset + pos, cssSelectorMark);
      continue;
    }

    if (char === ':') {
      const start = pos;

      pos++;
      if (text[pos] === ':') pos++;
      while (pos < len && /[a-zA-Z0-9_-]/.test(text[pos])) pos++;
      builder.add(baseOffset + start, baseOffset + pos, cssSelectorMark);
      continue;
    }

    if (char === '{' || char === '}') {
      builder.add(baseOffset + pos, baseOffset + pos + 1, operatorMark);
      pos++;
      continue;
    }

    if (/[a-zA-Z-]/.test(char)) {
      const start = pos;

      while (pos < len && /[a-zA-Z0-9-]/.test(text[pos])) pos++;

      let nextNonSpace = pos;

      while (nextNonSpace < len && /\s/.test(text[nextNonSpace])) nextNonSpace++;

      if (text[nextNonSpace] === ':' && text[nextNonSpace + 1] !== ':') {
        builder.add(baseOffset + start, baseOffset + pos, cssPropertyMark);
      } else if (text[nextNonSpace] === '{' || text[nextNonSpace] === ',') {
        builder.add(baseOffset + start, baseOffset + pos, cssSelectorMark);
      } else {
        builder.add(baseOffset + start, baseOffset + pos, stringMark);
      }

      continue;
    }

    if (/[0-9#]/.test(char)) {
      const start = pos;

      if (char === '#') {
        pos++;
        while (pos < len && /[0-9a-fA-F]/.test(text[pos])) pos++;
      } else {
        while (pos < len && /[0-9.%a-zA-Z-]/.test(text[pos])) pos++;
      }

      builder.add(baseOffset + start, baseOffset + pos, numberMark);
      continue;
    }

    if (char === ';' || char === ',') {
      builder.add(baseOffset + pos, baseOffset + pos + 1, punctuationMark);
      pos++;
      continue;
    }

    if (char === '"' || char === "'") {
      const quote = char;
      const start = pos;

      pos++;

      while (pos < len && text[pos] !== quote) {
        if (text[pos] === '\\') pos++;
        pos++;
      }

      pos++;
      builder.add(baseOffset + start, baseOffset + pos, stringMark);
      continue;
    }

    pos++;
  }
}

// A style rule (iconStyles/labelStyles) reads "condition => css-properties",
// or just CSS properties.
function tokenizeStyleRule(text: string, baseOffset: number, builder: RangeSetBuilder<Decoration>): void {
  const arrowPos = text.indexOf('=>');

  if (arrowPos === -1) {
    // No arrow, might be inline CSS or simple value
    tokenizeCssContent(text, baseOffset, builder);

    return;
  }

  const condition = text.substring(0, arrowPos);
  const cssProps = text.substring(arrowPos + 2);

  if (condition.trim().length > 0) {
    tokenizeCondition(condition, baseOffset, builder);
  }

  builder.add(baseOffset + arrowPos, baseOffset + arrowPos + 2, operatorMark);

  tokenizeCssContent(cssProps, baseOffset + arrowPos + 2, builder);
}

// The left side of "=>".
function tokenizeCondition(text: string, baseOffset: number, builder: RangeSetBuilder<Decoration>): void {
  let pos = 0;
  const len = text.length;

  while (pos < len) {
    const char = text[pos];

    if (/\s/.test(char)) {
      pos++;
      continue;
    }

    const remaining = text.substring(pos).toUpperCase();

    if (remaining.startsWith('AND') && (pos + 3 >= len || /\s/.test(text[pos + 3]))) {
      builder.add(baseOffset + pos, baseOffset + pos + 3, operatorMark);
      pos += 3;
      continue;
    }

    if (remaining.startsWith('OR') && (pos + 2 >= len || /\s/.test(text[pos + 2]))) {
      builder.add(baseOffset + pos, baseOffset + pos + 2, operatorMark);
      pos += 2;
      continue;
    }

    if (remaining.startsWith('NOT') && (pos + 3 >= len || /\s/.test(text[pos + 3]))) {
      builder.add(baseOffset + pos, baseOffset + pos + 3, operatorMark);
      pos += 3;
      continue;
    }

    if (remaining.startsWith('IN') && (pos + 2 >= len || /\s/.test(text[pos + 2]))) {
      builder.add(baseOffset + pos, baseOffset + pos + 2, operatorMark);
      pos += 2;
      continue;
    }

    const twoChar = text.substring(pos, pos + 2);

    if (twoChar === '==' || twoChar === '!=' || twoChar === '<=' || twoChar === '>=') {
      builder.add(baseOffset + pos, baseOffset + pos + 2, operatorMark);
      pos += 2;
      continue;
    }

    if ('<>='.includes(char)) {
      builder.add(baseOffset + pos, baseOffset + pos + 1, operatorMark);
      pos++;
      continue;
    }

    if (text.substring(pos, pos + 4).toLowerCase() === 'tag:') {
      const start = pos;

      pos += 4;
      while (pos < len && /[a-zA-Z0-9_/-]/.test(text[pos])) pos++;
      builder.add(baseOffset + start, baseOffset + pos, knownValueMark);
      continue;
    }

    if (char === '"' || char === "'") {
      const quote = char;
      const start = pos;

      pos++;

      while (pos < len && text[pos] !== quote) {
        if (text[pos] === '\\') pos++;
        pos++;
      }

      pos++;
      builder.add(baseOffset + start, baseOffset + pos, stringMark);
      continue;
    }

    if (/[0-9-]/.test(char)) {
      const start = pos;

      if (char === '-') pos++;
      while (pos < len && /[0-9.]/.test(text[pos])) pos++;
      builder.add(baseOffset + start, baseOffset + pos, numberMark);
      continue;
    }

    if (/[a-zA-Z_]/.test(char)) {
      const start = pos;

      while (pos < len && /[a-zA-Z0-9_]/.test(text[pos])) pos++;
      builder.add(baseOffset + start, baseOffset + pos, cssPropertyMark);
      continue;
    }

    pos++;
  }
}

// Tokenize a radius value: "{distance}[unit] from {lat}, {lng} [or {lat}, {lng} ...]"
//   "10 from 41.408, -75.662"
//   "15mi from 41.408, -75.662 or 41.573, -75.501"
function tokenizeRadiusValue(text: string, baseOffset: number, builder: RangeSetBuilder<Decoration>): void {
  const distanceOnlyMatch = text.match(/^(\d+(?:\.\d+)?)\s*(mi|miles?|km|kilometers?|m|meters?|ft|feet)?$/i);

  if (distanceOnlyMatch) {
    const distanceNum = distanceOnlyMatch[1];
    const distanceStart = text.indexOf(distanceNum);

    builder.add(baseOffset + distanceStart, baseOffset + distanceStart + distanceNum.length, numberMark);
    const unit = distanceOnlyMatch[2];

    if (unit) {
      const unitStart = text.indexOf(unit, distanceStart + distanceNum.length);

      builder.add(baseOffset + unitStart, baseOffset + unitStart + unit.length, knownValueMark);
    }

    return;
  }

  const headerMatch = text.match(/^(\d+(?:\.\d+)?)\s*(mi|miles?|km|kilometers?|m|meters?|ft|feet)?\s+(from)\s+/i);

  if (!headerMatch) {
    builder.add(baseOffset, baseOffset + text.length, containsParameterPlaceholder(text) ? metaMark : invalidValueMark);

    return;
  }

  let pos = 0;

  const distanceNum = headerMatch[1];
  const distanceStart = text.indexOf(distanceNum);

  builder.add(baseOffset + distanceStart, baseOffset + distanceStart + distanceNum.length, numberMark);
  pos = distanceStart + distanceNum.length;

  const unit = headerMatch[2];

  if (unit) {
    const unitStart = text.indexOf(unit, pos);

    builder.add(baseOffset + unitStart, baseOffset + unitStart + unit.length, knownValueMark);
    pos = unitStart + unit.length;
  }

  const fromKeyword = headerMatch[3];
  const fromStart = text.toLowerCase().indexOf(fromKeyword.toLowerCase(), pos);

  builder.add(baseOffset + fromStart, baseOffset + fromStart + fromKeyword.length, keywordMark);
  pos = fromStart + fromKeyword.length;

  const coordsText = text.substring(headerMatch[0].length);

  const coordParts = coordsText.split(/(\s+or\s+)/i);

  let coordPos = headerMatch[0].length;

  for (let i = 0; i < coordParts.length; i++) {
    const part = coordParts[i];

    if (part.match(/^\s+or\s+$/i)) {
      // Highlight the "or" itself, not the whitespace around it.
      const orMatch = part.match(/\s+(or)\s+/i);

      if (orMatch && orMatch[1]) {
        const orStart = coordPos + part.indexOf(orMatch[1]);

        builder.add(baseOffset + orStart, baseOffset + orStart + 2, keywordMark);
      }

      coordPos += part.length;
      continue;
    }

    const coordMatch = part.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);

    if (!coordMatch) {
      builder.add(baseOffset + coordPos, baseOffset + coordPos + part.length, containsParameterPlaceholder(part) ? metaMark : invalidValueMark);
      coordPos += part.length;
      continue;
    }

    const lat = coordMatch[1];
    const lng = coordMatch[2];

    const latStart = coordPos + part.indexOf(lat);

    builder.add(baseOffset + latStart, baseOffset + latStart + lat.length, numberMark);

    const commaStart = coordPos + part.indexOf(',');

    builder.add(baseOffset + commaStart, baseOffset + commaStart + 1, punctuationMark);

    const lngStart = coordPos + part.lastIndexOf(lng);

    builder.add(baseOffset + lngStart, baseOffset + lngStart + lng.length, numberMark);

    coordPos += part.length;
  }
}

// `text` may include leading whitespace; `baseOffset` is a character offset in
// the document.
function tokenizeValue(text: string, baseOffset: number, builder: RangeSetBuilder<Decoration>, key: string, blockType: string): void {
  const trimmed = text.trim();

  if (trimmed.length === 0) return;

  const trimStart = text.indexOf(trimmed);

  if (key === KEY_RADIUS) {
    tokenizeRadiusValue(trimmed, baseOffset + trimStart, builder);

    return;
  }

  if (trimmed.match(/^https?:\/\//i)) {
    builder.add(baseOffset + trimStart, baseOffset + trimStart + trimmed.length, linkMark);

    return;
  }

  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    builder.add(baseOffset + trimStart, baseOffset + trimStart + trimmed.length, stringMark);

    return;
  }

  // Number (including CSS values)
  if (trimmed.match(/^-?\d+(\.\d+)?(%|px|vh|vw|em|rem)?$/i) || trimmed.match(/^calc\(/i)) {
    builder.add(baseOffset + trimStart, baseOffset + trimStart + trimmed.length, numberMark);

    return;
  }

  // Only the `places` block validates mapProvider against the registered map
  // providers; other block languages can define their own mapProvider semantics.
  if (key === KEY_MAP_PROVIDER && blockType === 'places') {
    const providers = PlacesPlugin.getAllMapProviders();

    if (providers.length === 0) {
      // No providers registered yet, accept any value
      builder.add(baseOffset + trimStart, baseOffset + trimStart + trimmed.length, stringMark);

      return;
    }

    if (!trimmed.includes(',')) {
      if (providers.includes(trimmed.toLowerCase())) {
        builder.add(baseOffset + trimStart, baseOffset + trimStart + trimmed.length, knownValueMark);
      } else if (containsParameterPlaceholder(trimmed)) {
        builder.add(baseOffset + trimStart, baseOffset + trimStart + trimmed.length, metaMark);
      } else {
        builder.add(baseOffset + trimStart, baseOffset + trimStart + trimmed.length, invalidValueMark);
      }

      return;
    }

    let searchPos = 0;
    const parts = trimmed.split(',');

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const partTrimmed = part.trim().toLowerCase();
      const partStart = part.indexOf(part.trim());

      const partAbsStart = trimStart + searchPos + partStart;
      const partAbsEnd = partAbsStart + partTrimmed.length;

      if (providers.includes(partTrimmed)) {
        builder.add(baseOffset + partAbsStart, baseOffset + partAbsEnd, knownValueMark);
      } else if (containsParameterPlaceholder(partTrimmed)) {
        builder.add(baseOffset + partAbsStart, baseOffset + partAbsEnd, metaMark);
      } else {
        builder.add(baseOffset + partAbsStart, baseOffset + partAbsEnd, invalidValueMark);
      }

      searchPos += part.length;

      if (i < parts.length - 1) {
        builder.add(baseOffset + trimStart + searchPos, baseOffset + trimStart + searchPos + 1, punctuationMark);
        searchPos += 1;
      }
    }

    return;
  }

  // `cache:` shares one grammar across every block (booleans, forever,
  // durations, and expiration dates), and is validated by the parser itself
  // rather than by a per-block value list that could only ever be a subset.
  if (key === 'cache') {
    const mark = isCacheSettingValue(trimmed)
      ? knownValueMark
      : containsParameterPlaceholder(trimmed) ? metaMark : invalidValueMark;

    builder.add(baseOffset + trimStart, baseOffset + trimStart + trimmed.length, mark);

    return;
  }

  const knownValuesForKey = CodeBlockRegistry.instance.getKnownValuesForBlock(blockType, key) ?? getKnownValuesForKey(key);

  if (knownValuesForKey) {
    if (isMultiValueKeyForBlock(blockType, key) && trimmed.includes(',')) {
      tokenizeDelimitedKnownValues(trimmed, baseOffset + trimStart, builder, knownValuesForKey);
    } else if (knownValuesForKey.has(trimmed.toLowerCase())) {
      builder.add(baseOffset + trimStart, baseOffset + trimStart + trimmed.length, knownValueMark);
    } else if (containsParameterPlaceholder(trimmed)) {
      builder.add(baseOffset + trimStart, baseOffset + trimStart + trimmed.length, metaMark);
    } else {
      builder.add(baseOffset + trimStart, baseOffset + trimStart + trimmed.length, invalidValueMark);
    }

    return;
  }

  // Default for keys without restricted values (height, width, location).
  builder.add(baseOffset + trimStart, baseOffset + trimStart + trimmed.length, stringMark);
}

interface TokenizerState {
  inPlacesBlock: boolean;
  inCssBlock: boolean;
  inQueryBlock: boolean;
  queryBlockIndent: number;
  inScalarBlock: boolean;
  scalarBlockParentIndent: number;
  scalarBlockContentIndent: number;
  inStylesBlock: boolean;
  currentKey: string;
  blockType: string;
}

function tokenizeLine(text: string, baseOffset: number, builder: RangeSetBuilder<Decoration>, state: TokenizerState): TokenizerState {
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return state;
  }

  if (state.inScalarBlock) {
    const contentIndent = getYamlBlockScalarContentIndent(
      text,
      state.scalarBlockParentIndent,
      state.scalarBlockContentIndent,
    );

    if (contentIndent === null) {
      return tokenizeLine(text, baseOffset, builder, {
        ...state,
        inScalarBlock: false,
        scalarBlockParentIndent: -1,
        scalarBlockContentIndent: -1,
        currentKey: '',
      });
    }

    return { ...state, scalarBlockContentIndent: contentIndent };
  }

  if (trimmed.startsWith('#')) {
    const hashPos = text.indexOf('#');

    builder.add(baseOffset + hashPos, baseOffset + text.length, commentMark);

    return state;
  }

  if (/^\S/u.test(text) && !/^-(?:\s|$)/u.test(text)) {
    state = { ...state, inPlacesBlock: (state.blockType === 'places' || state.blockType === 'places-template') && /^places:\s*(?:#.*)?$/iu.test(text) };
  }

  if (state.inCssBlock) {
    if (getNewKeyIfStarting(text, state.blockType)) {
      return tokenizeLine(text, baseOffset, builder, { ...state, inCssBlock: false, currentKey: '' });
    }

    tokenizeCssContent(text, baseOffset, builder);

    return state;
  }

  if (state.inQueryBlock) {
    if (!isQueryBlockContentLine(text, state.queryBlockIndent)) {
      return tokenizeLine(text, baseOffset, builder, { ...state, inQueryBlock: false, queryBlockIndent: -1, currentKey: '' });
    }

    const startPos = text.search(/\S/);

    if (startPos >= 0) {
      tokenizeSql(text.substring(startPos), baseOffset + startPos, builder);
    }

    return state;
  }

  if (state.inStylesBlock) {
    if (tokenizeListItem(text, baseOffset, builder)) {
      return state;
    }

    if (getNewKeyIfStarting(text, state.blockType)) {
      return tokenizeLine(text, baseOffset, builder, { ...state, inStylesBlock: false, currentKey: '' });
    }

    tokenizeStyleRule(text, baseOffset, builder);

    return state;
  }

  const colonPos = firstUnquotedColon(text);

  if (colonPos > 0) {
    const listKeyMatch = text.match(/^(\s*)-\s*([A-Za-z][\w-]*)\s*:/);
    const keyStart = listKeyMatch
      ? listKeyMatch[1].length + text.slice(listKeyMatch[1].length).indexOf(listKeyMatch[2])
      : text.search(/\S/);
    const key = listKeyMatch?.[2] ?? text.substring(keyStart, colonPos).trim();
    const keyEnd = keyStart + key.length;

    if (listKeyMatch) {
      const dashPos = text.indexOf('-');

      builder.add(baseOffset + dashPos, baseOffset + dashPos + 1, operatorMark);
    }

    const atRoot = keyStart === 0 && !listKeyMatch;
    const keyValid = state.inPlacesBlock || (atRoot ? isRootKeyValidForBlock(key, state.blockType) : isKeyValidForBlock(key, state.blockType));

    if (keyValid) {
      builder.add(baseOffset + keyStart, baseOffset + keyEnd, keywordMark);
    } else {
      builder.add(baseOffset + keyStart, baseOffset + keyEnd, invalidKeyMark);
    }

    builder.add(baseOffset + colonPos, baseOffset + colonPos + 1, punctuationMark);

    const valueStart = colonPos + 1;
    const value = text.substring(valueStart);
    const valueTrimmed = value.trim();

    if (!state.inPlacesBlock && key === KEY_CSS) {
      if (valueTrimmed === '|' || valueTrimmed === '|-' || valueTrimmed === '>') {
        const indicatorPos = text.indexOf(valueTrimmed, colonPos);

        builder.add(baseOffset + indicatorPos, baseOffset + indicatorPos + valueTrimmed.length, operatorMark);

        return { ...state, inCssBlock: true, currentKey: key };
      } else if (valueTrimmed.length > 0) {
        tokenizeCssContent(value, baseOffset + valueStart, builder);
      }

      return { ...state, currentKey: key };
    }

    if (!state.inPlacesBlock && QUERY_KEYS_SET.has(key)) {
      if (isYamlBlockScalarIndicator(valueTrimmed)) {
        const indicatorPos = text.indexOf(valueTrimmed, colonPos);

        builder.add(baseOffset + indicatorPos, baseOffset + indicatorPos + valueTrimmed.length, operatorMark);

        return { ...state, inQueryBlock: true, queryBlockIndent: getYamlColumn(text), currentKey: key };
      }

      if (valueTrimmed.length > 0) {
        tokenizeSql(value, baseOffset + valueStart, builder);
      }

      return { ...state, inQueryBlock: false, queryBlockIndent: -1, currentKey: key };
    }

    if (!state.inPlacesBlock && STYLE_RULE_KEYS.has(key)) {
      if (valueTrimmed.length > 0) {
        tokenizeStyleRule(value, baseOffset + valueStart, builder);
      }

      return { ...state, inStylesBlock: true, currentKey: key };
    }

    if (isYamlBlockScalarIndicator(valueTrimmed)) {
      const indicatorPos = text.indexOf(valueTrimmed, colonPos);

      builder.add(baseOffset + indicatorPos, baseOffset + indicatorPos + valueTrimmed.length, operatorMark);

      return {
        ...state,
        inScalarBlock: true,
        scalarBlockParentIndent: getYamlColumn(text, keyStart),
        scalarBlockContentIndent: -1,
        currentKey: key,
      };
    }

    tokenizeValue(value, baseOffset + valueStart, builder, state.inPlacesBlock ? '' : key, state.blockType);

    return { ...state, currentKey: key };
  }

  if (text.match(/^\s+/) && state.currentKey) {
    if (state.currentKey === KEY_CSS) {
      tokenizeCssContent(text, baseOffset, builder);
    } else if (QUERY_KEYS_SET.has(state.currentKey)) {
      const startPos = text.search(/\S/);

      if (startPos >= 0) {
        tokenizeSql(text.substring(startPos), baseOffset + startPos, builder);
      }
    } else if (STYLE_RULE_KEYS.has(state.currentKey)) {
      if (!tokenizeListItem(text, baseOffset, builder)) {
        tokenizeStyleRule(text, baseOffset, builder);
      }
    } else {
      tokenizeValue(text, baseOffset, builder, state.currentKey, state.blockType);
    }
  }

  return state;
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  const visibleRanges = view.visibleRanges;

  let currentBlock: {
    language: string;
    lines: Array<{ from: number; to: number }>;
  } | null = null;

  const intersectsVisible = (from: number, to: number): boolean =>
    visibleRanges.some(range => from <= range.to && to >= range.from);

  const flushBlock = () => {
    if (currentBlock && currentBlock.lines.length > 0) {
      const blockFrom = currentBlock.lines[0].from;
      const blockTo = currentBlock.lines[currentBlock.lines.length - 1].to;

      if (intersectsVisible(blockFrom, blockTo)) {
        let state: TokenizerState = {
          inPlacesBlock: false,
          inCssBlock: false,
          inQueryBlock: false,
          queryBlockIndent: -1,
          inScalarBlock: false,
          scalarBlockParentIndent: -1,
          scalarBlockContentIndent: -1,
          inStylesBlock: false,
          currentKey: '',
          blockType: currentBlock.language
        };

        for (const line of currentBlock.lines) {
          const content = doc.sliceString(line.from, line.to);

          state = tokenizeLine(content, line.from, builder, state);
        }
      }
    }

    currentBlock = null;
  };

  const tree = syntaxTree(view.state);

  tree.iterate({
    enter: (node: { name: string; from: number; to: number }) => {
      if (node.name.includes('HyperMD-codeblock-begin')) {
        const lineText = doc.sliceString(node.from, node.to);
        const match = lineText.match(/^```(\S+)/);

        if (match && isPlacesCodeBlock(match[1])) {
          currentBlock = {
            language: match[1],
            lines: []
          };
        } else {
          currentBlock = null;
        }

        return;
      }

      if (node.name.includes('HyperMD-codeblock-end')) {
        flushBlock();

        return;
      }

      if (currentBlock && node.name === 'hmd-codeblock') {
        currentBlock.lines.push({ from: node.from, to: node.to });
      }
    },
  });

  flushBlock();

  return builder.finish();
}

export const placesHighlightPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    sqlSyntax = PlacesPlugin.getSqlSyntax();

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      const syntax = PlacesPlugin.getSqlSyntax();

      if (syntax !== this.sqlSyntax || update.docChanged || update.viewportChanged || syntaxTree(update.state) !== syntaxTree(update.startState)) {
        this.sqlSyntax = syntax;
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);
