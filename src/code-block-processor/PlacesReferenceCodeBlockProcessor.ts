import { formatParameterValues, type ParameterDefinition } from "places-shared/services";
import { CodeBlockRegistry } from "../services/CodeBlockRegistry";

export class PlacesReferenceCodeBlockProcessor {
  constructor(private registry: CodeBlockRegistry = CodeBlockRegistry.instance) {}

  processReferenceCodeBlock(el: HTMLElement): void {
    const container = el.createDiv({ cls: "places-reference-container" });
    const definitions = this.registry.getAllDefinitions();

    definitions.forEach(blockDef => {
      const section = container.createDiv({ cls: "places-reference-section" });

      const header = section.createEl("h3");

      header.createEl("code", { text: blockDef.type });
      header.appendText(` - ${blockDef.description}`);

      this.renderSettingsTable(section, blockDef.parameters);
    });
  }

  private renderSettingsTable(container: HTMLElement, parameters: ParameterDefinition[]): void {
    const table = container.createEl("table", { cls: "places-help-table" });

    const thead = table.createEl("thead");
    const headerRow = thead.createEl("tr");

    headerRow.createEl("th", { text: "Setting" });
    headerRow.createEl("th", { text: "Description" });
    headerRow.createEl("th", { text: "Examples" });

    const tbody = table.createEl("tbody");

    for (const param of parameters) {
      const row = tbody.createEl("tr");

      row.createEl("td", { text: param.name, cls: "places-setting-name" });
      row.createEl("td", { text: param.description ?? "" });

      const valuesCell = row.createEl("td");

      this.renderBoldMarkdown(valuesCell, formatParameterValues(param.values));
    }
  }

  private renderBoldMarkdown(container: HTMLElement, text: string): void {
    const parts = text.split(/(\*\*.*?\*\*)/g);

    for (const part of parts) {
      if (part.startsWith("**") && part.endsWith("**")) {
        container.createEl("strong", { text: part.slice(2, -2) });
      } else {
        container.appendText(part);
      }
    }
  }
}
