import { App, MarkdownPostProcessorContext } from "obsidian";
import { ParsedCodeBlock } from "./CodeBlockParser";
import { MapRefreshService } from "./MapRefreshService";
import { QueryParameterState, createBlockParameterTransform } from "./QueryParameterState";
import { parseQueryParameterDefinitions, resolveOptionsQueries, settingsUseParameters } from "./QueryParameters";
import { renderParameterStrip } from "../ui/ParameterStrip";
import { normalizeQueryParameterLayout, normalizeQueryParameterPosition } from "../ui/QueryParameterControls";
import { readNoteProperties } from "./NoteProperties";
import { parseBooleanOptional } from "places-shared/settings";
import { VaultQueryService } from "./VaultQueryService";

export interface AppliedBlockParameters {
  // Also renders transform errors. Call after the block content rendered.
  renderStrip: () => Promise<void>;
}

// Parameter support for the data blocks (chart, heatmap, similar, compare):
// substitutes `{parameter.*}` into the parsed settings before the block reads
// them, and renders a control strip whose changes re-render the whole block
// through BlockRefreshRegistry. Session state keys and note-scoped parameter
// resolution match the places map block exactly.
export class BlockParameterSupport {
  constructor(private app: App, private vaultQueryService: VaultQueryService) {}

  // Drives note-scoped refresh registration.
  blockUsesParameters(parsedBlock: ParsedCodeBlock): boolean {
    return parsedBlock.settings.queryParameters !== undefined || settingsUseParameters(parsedBlock.settings);
  }

  // Substitute parameters into the parsed block in place; returns null when the block declares and references none.
  async apply(parsedBlock: ParsedCodeBlock, el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<AppliedBlockParameters | null> {
    const stateKey = QueryParameterState.getStateKey(ctx.sourcePath, ctx.getSectionInfo(el)?.lineStart);
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

    // Parsed from the transformed settings, not a snapshot taken before the
    // transform: a control whose label, default or options references
    // `{note.*}` renders substituted.
    const { definitions } = parseQueryParameterDefinitions(parsedBlock.settings.queryParameters);
    return {
      renderStrip: () => renderParameterStrip({
        app: this.app,
        container: el,
        definitions,
        stateKey,
        // Without an anchor element 'floating' overlays the block itself.
        position: normalizeQueryParameterPosition(parsedBlock.settings.queryParametersPosition ?? 'above'),
        layout: normalizeQueryParameterLayout(parsedBlock.settings.queryParametersLayout),
        collapsed: parseBooleanOptional(parsedBlock.settings.queryParametersCollapsed),
        runQuery,
        // Data blocks re-render wholesale, strip included; the re-render
        // re-resolves cascading options.
        rebuildOnDependentOptions: false,
        onValuesApplied: () => { void MapRefreshService.getInstance().refreshBlockForElement(el); },
        addChild: child => ctx.addChild(child),
        transformErrors,
      }),
    };
  }
}

