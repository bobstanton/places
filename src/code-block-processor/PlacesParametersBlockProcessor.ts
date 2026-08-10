import { App, MarkdownPostProcessorContext, MarkdownRenderChild } from "obsidian";
import { renderError } from "places-shared/utils";
import { parseBooleanOptional } from "places-shared/settings";
import { parseCodeBlock } from "../services/CodeBlockParser";
import { MapRefreshService } from "../services/MapRefreshService";
import { NoteParameterRegistry } from "../services/QueryParameterState";
import { parseQueryParameterDefinitions } from "../services/QueryParameters";
import { readNoteProperties, resolveSettingsNoteProperties, settingsUseNoteProperties } from "../services/NoteProperties";
import { VaultQueryService } from "../services/VaultQueryService";
import { renderParameterStrip } from "../ui/ParameterStrip";
import { normalizeQueryParameterLayout } from "../ui/QueryParameterControls";

// The `places-parameters` block: declares note-scoped parameters and renders
// their control strip where the block sits. Every parameter-consuming block
// in the note resolves `{parameter.*}` against these definitions (block-local
// declarations shadow them by name); value changes re-render the note's
// consuming blocks in place.
export class PlacesParametersBlockProcessor {
  constructor(private app: App, private vaultQueryService: VaultQueryService) {}

  async processCodeBlock(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
    const parsed = parseCodeBlock(source);
    // `{note.*}` resolves here as it does in a consuming block's own
    // queryParameters; the substituted declarations are what gets registered.
    const noteErrors: string[] = [];
    if (settingsUseNoteProperties(parsed.settings)) {
      const resolved = await resolveSettingsNoteProperties(parsed.settings, readNoteProperties(this.app, ctx.sourcePath));
      parsed.settings = resolved.settings;
      noteErrors.push(...resolved.errors);
    }
    const { definitions, errors } = parseQueryParameterDefinitions(parsed.settings.queryParameters);
    el.addClass('places-parameters-block');

    if (definitions.length === 0 && errors.length === 0) {
      renderError(el, {
        icon: '⚠️',
        title: 'No Parameters Declared',
        message: 'A places-parameters block requires a queryParameters list.',
      });
      return;
    }

    const sourcePath = ctx.sourcePath;
    const lineStart = ctx.getSectionInfo(el)?.lineStart;
    const blockErrors = [...errors, ...noteErrors];
    if (lineStart !== undefined) {
      const token = NoteParameterRegistry.register(sourcePath, lineStart, parsed.settings.queryParameters);
      const registration = new MarkdownRenderChild(el);
      registration.register(() => {
        NoteParameterRegistry.unregister(sourcePath, lineStart, token);
        MapRefreshService.getInstance().refreshParameterConsumers(sourcePath);
      });
      ctx.addChild(registration);

      // definitionsFor keeps the first declaration of a name across the note; a
      // name already declared by an earlier places-parameters block is ignored here.
      for (const name of NoteParameterRegistry.conflictingNamesFor(sourcePath, lineStart, definitions.map(definition => definition.name))) {
        blockErrors.push(`Parameter "${name}" was already declared by an earlier places-parameters block in this note; the earlier declaration is used.`);
      }
    }

    await renderParameterStrip({
      app: this.app,
      container: el,
      definitions,
      stateKey: NoteParameterRegistry.noteStateKey(sourcePath),
      position: 'below',
      layout: normalizeQueryParameterLayout(parsed.settings.queryParametersLayout),
      collapsed: parseBooleanOptional(parsed.settings.queryParametersCollapsed),
      runQuery: sql => this.vaultQueryService.executeQuery(sql, sourcePath),
      onValuesApplied: () => MapRefreshService.getInstance().refreshParameterConsumers(sourcePath),
      addChild: child => ctx.addChild(child),
      transformErrors: blockErrors,
    });

    // Consuming blocks may have rendered before this block registered its
    // definitions (initial note load renders top to bottom, but reading view
    // renders sections independently).
    MapRefreshService.getInstance().refreshParameterConsumers(sourcePath);
  }
}
