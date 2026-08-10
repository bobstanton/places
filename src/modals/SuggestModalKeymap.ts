import { SuggestModal } from "obsidian";
import { Place } from "places-shared/place";

type SuggestModalWithInternalUpdate<T> = SuggestModal<T> & {
  updateSuggestions(): void;
};

export function refreshSuggestModal<T>(modal: SuggestModal<T>): void {
  (modal as SuggestModalWithInternalUpdate<T>).updateSuggestions();
}

const textNavigationInstalled = new WeakSet<SuggestModal<unknown>>();

export function useTextInputHomeEndKeys(modal: SuggestModal<unknown>): void {
  if (textNavigationInstalled.has(modal)) return;
  textNavigationInstalled.add(modal);

  modal.inputEl.addEventListener('keydown', event => {
    if (event.key !== 'Home' && event.key !== 'End') return;
    const position = event.key === 'Home' ? 0 : modal.inputEl.value.length;
    event.preventDefault();
    event.stopPropagation();
    modal.inputEl.setSelectionRange(position, position);
  }, { capture: true });
}

export function renderPlaceAttributions(parentEl: HTMLElement | null, places: Place[]): void {
  const attributions = new Set(
    places
      .map(place => place.attribution)
      .filter((attr): attr is string => Boolean(attr && attr.trim().length > 0))
  );

  parentEl?.findAll(".places-attributions").forEach(el => el.remove());

  if (places.length === 0 || attributions.size === 0 || !parentEl) {
    return;
  }

  const attributionsEl = createDiv({ cls: "places-attributions" });
  for (const attribution of attributions) {
    attributionsEl.createEl("p", {
      text: attribution.replace(/<[^>]*>?/gm, '').replace(/&copy;/g, "©")
    });
  }
  parentEl.appendChild(attributionsEl);
}
