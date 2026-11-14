import { App, MarkdownPostProcessorContext } from "obsidian";
import { ParsedCodeBlock } from 'places/core';
import { MapRefreshService } from "./MapRefreshService";
import { QueryParameterState, createBlockParameterTransform } from "./QueryParameterState";
import { parseQueryParameterDefinitions, resolveOptionsQueries, settingsUseParameters } from "places/core";
import { renderParameterStrip } from "../ui/ParameterStrip";
import { normalizeQueryParameterLayout, normalizeQueryParameterPosition } from "../ui/QueryParameterControls";
import { readNoteProperties } from "./NoteProperties";
import { parseBooleanOptional } from "places-shared/settings";
import { VaultQueryService } from "./VaultQueryService";

export interface AppliedBlockParameters {
  // Also renders transform errors. Call after the block content rendered.
  renderStrip: () => Promise<void>;
}

export class BlockParameterSupport {
  constructor(private app: App, private vaultQueryService: VaultQueryService) {}

  // Drives note-scoped refresh registration.
  blockUsesParameters(parsedBlock: ParsedCodeBlock): boolean {
    return parsedBlock.settings.queryParameters !== undefined || settingsUseParameters(parsedBlock.settings);
  }

  async apply(parsedBlock: ParsedCodeBlock, el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<AppliedBlockParameters | null> {
    const stateKey = QueryParameterState.getStateKey(ctx.sourcePath, ctx.getSectionInfo(el)?.lineStart, JSON.stringify(parsedBlock));
    const runQuery = (sql: string): Promise<unknown[]> => this.vaultQueryService.executeQuery(sql, ctx.sourcePath);

    let transformErrors: string[] = [];
    const transform = createBlockParameterTransform(
      stateKey,
      errors => { transformErrors = errors; },
      definitions => resolveOptionsQueries(definitions, runQuery, QueryParameterState.peek(stateKey)),
      ctx.sourcePath,
      () => readNoteProperties(this.app, ctx.sourcePath),
    );
    const { parameterSignature } = await transform(parsedBlock);

    if (parameterSignature === '' && transformErrors.length === 0) {
      return null;
    }

    const { definitions } = parseQueryParameterDefinitions(parsedBlock.settings.queryParameters);

    return {
      renderStrip: () => renderParameterStrip({
        app: this.app,
        container: el,
        definitions,
        stateKey,
        position: normalizeQueryParameterPosition(parsedBlock.settings.queryParametersPosition ?? 'above'),
        layout: normalizeQueryParameterLayout(parsedBlock.settings.queryParametersLayout),
        collapsed: parseBooleanOptional(parsedBlock.settings.queryParametersCollapsed),
        runQuery,
        rebuildOnDependentOptions: false,
        onValuesApplied: () => { void MapRefreshService.getInstance().refreshBlockForElement(el); },
        addChild: child => ctx.addChild(child),
        transformErrors,
      }),
    };
  }
}
