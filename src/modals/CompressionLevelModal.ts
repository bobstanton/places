import { App, SuggestModal } from "obsidian";

export class CompressionLevelModal extends SuggestModal<number> {
  private readonly levels = Array.from({ length: 19 }, (_, index) => 19 - index);

  constructor(app: App, private readonly onChoose: (level: number) => void) {
    super(app);
    this.setPlaceholder("Choose overlay compression level (19 = smallest)");
  }

  getSuggestions(query: string): number[] {
    const trimmed = query.trim();
    return trimmed ? this.levels.filter((level) => String(level).includes(trimmed)) : this.levels;
  }

  renderSuggestion(level: number, el: HTMLElement): void {
    el.createDiv({ text: `Level ${level}${level === 19 ? " (maximum compression)" : ""}` });
  }

  onChooseSuggestion(level: number): void {
    this.onChoose(level);
  }
}
