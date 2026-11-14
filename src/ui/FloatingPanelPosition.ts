export function positionFloatingPanel(host: HTMLElement, panel: HTMLElement): () => void {
  const view = host.ownerDocument.defaultView;

  if (!view?.ResizeObserver) return () => undefined;

  const block = host.closest<HTMLElement>('[class*="block-language-"]') ?? host;
  const widget = block.parentElement?.matches('.cm-preview-code-block') ? block.parentElement : null;
  let rows: HTMLElement[] = [];
  let appliedOffset = 0;
  let disposed = false;

  const update = (): void => {
    if (disposed || !host.isConnected) return;
    const panelBounds = panel.getBoundingClientRect();
    const top = panelBounds.top - appliedOffset;
    const bottom = top + panelBounds.height;
    const collidingRows = rows.filter(row =>
      Array.from(row.querySelectorAll<HTMLElement>('.places-floating-button, .embed-action, .edit-block-button')).some(button => {
        const bounds = button.getBoundingClientRect();

        return bounds.width > 0 && bounds.height > 0
          && panelBounds.left < bounds.right && panelBounds.right > bounds.left
          && top < bounds.bottom && bottom > bounds.top;
      }),
    );
    const hostTop = host.getBoundingClientRect().top;
    const offset = Math.ceil(Math.max(0, ...collidingRows.map(row => row.getBoundingClientRect().bottom - hostTop)));

    if (offset !== appliedOffset) {
      appliedOffset = offset;
      panel.style.setProperty('--places-floating-panel-actions-offset', `${offset}px`);
    }
  };

  const resize = new view.ResizeObserver(update);
  const sync = (): void => {
    if (disposed) return;

    if (!host.contains(panel) || (widget && block.parentElement !== widget)) {
      dispose();

      return;
    }

    const nativeRow = widget?.querySelector<HTMLElement>(':scope > .embed-actions');

    rows = nativeRow ? [nativeRow] : Array.from(block.querySelectorAll<HTMLElement>(
      ':scope > .places-floating-buttons, :scope > .places-heatmap-container > .places-heatmap-floating-buttons',
    ));
    resize.disconnect();
    for (const element of new Set([host, block, panel, ...rows])) resize.observe(element);
    mutations.disconnect();
    mutations.observe(block, { childList: true });
    if (widget) mutations.observe(widget, { childList: true });
    mutations.observe(panel, { attributes: true, attributeFilter: ['class'] });
    for (const row of rows) mutations.observe(row, { childList: true, subtree: true });
    update();
  };

  const mutations = new view.MutationObserver(sync);

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    mutations.disconnect();
    resize.disconnect();
    panel.style.removeProperty('--places-floating-panel-actions-offset');
  };

  sync();

  return dispose;
}
