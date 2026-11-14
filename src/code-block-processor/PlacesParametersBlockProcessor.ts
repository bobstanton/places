import { App, MarkdownPostProcessorContext, MarkdownRenderChild } from "obsidian";
import { renderError } from "places-shared/utils";
import { parseBooleanOptional } from "places-shared/settings";
import { parseCodeBlock } from 'places/core';
import { MapRefreshService } from "../services/MapRefreshService";
import { NoteParameterRegistry } from "../services/QueryParameterState";
import { parseQueryParameterDefinitions } from "places/core";
import { readNoteProperties, resolveSettingsNoteProperties, settingsUseNoteProperties } from "../services/NoteProperties";
import { VaultQueryService } from "../services/VaultQueryService";
import { renderParameterStrip } from "../ui/ParameterStrip";
import { normalizeQueryParameterLayout } from "../ui/QueryParameterControls";
import { createOwnNoteEditRefreshGuard, registerRefreshableCodeBlock } from './RefreshableCodeBlock';

export class PlacesParametersBlockProcessor {
  constructor(private app: App, private vaultQueryService: VaultQueryService) {}

  async processCodeBlock(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
    const parsed = parseCodeBlock(source);
    const autoRefresh = parsed.settings.autorefresh;

    registerRefreshableCodeBlock({
      autoRefresh,
      source, el, ctx,
      process: (nextSource, nextEl, nextCtx) => this.processCodeBlock(nextSource, nextEl, nextCtx),
      shouldAutoRefresh: createOwnNoteEditRefreshGuard(source, ctx.sourcePath, path => readNoteProperties(this.app, path)),
    });
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
        NoteParameterRegistry.unregister(ctx.sourcePath, lineStart, token);
        MapRefreshService.getInstance().refreshParameterConsumers(ctx.sourcePath);
      });
      ctx.addChild(registration);

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
      runQuery: sql => this.vaultQueryService.executeQuery(sql, ctx.sourcePath),
      onValuesApplied: () => MapRefreshService.getInstance().refreshParameterConsumers(ctx.sourcePath),
      addChild: child => ctx.addChild(child),
      transformErrors: blockErrors,
    });

    MapRefreshService.getInstance().refreshParameterConsumers(sourcePath);
  }
}
