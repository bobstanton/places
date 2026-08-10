import { App, Modal, Notice, TFile } from "obsidian";
import { StringCompressor, getErrorMessage } from "places-shared/utils";

export type OverlayDecodeField = "Overlay Source" | "Overlay Cache";

export class DecodeOverlayFieldModal extends Modal {
  private decodedTextarea!: HTMLTextAreaElement;
  private encodedTextarea!: HTMLTextAreaElement;
  private encodeTimer: number | null = null;

  constructor(app: App, private fieldName: OverlayDecodeField, private file?: TFile) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    this.modalEl.addClass("places-decode-overlay-modal");

    contentEl.createEl("h1", { text: `Decode ${this.fieldName.toLowerCase()}` });

    const decodedSection = contentEl.createDiv({ cls: "places-decode-section" });
    decodedSection.createEl("h3", { text: "Decoded content" });
    this.decodedTextarea = decodedSection.createEl("textarea", {
      attr: { spellcheck: "false", placeholder: `Decoded ${this.fieldName} will appear here. Edit to update the encoded value below.` }
    });
    this.decodedTextarea.addClass("places-decoded-data-textarea");
    this.decodedTextarea.addClass("places-decode-decoded-textarea");

    const encodedSection = contentEl.createDiv({ cls: "places-decode-section" });
    encodedSection.createEl("h3", { text: "Encoded value" });
    this.encodedTextarea = encodedSection.createEl("textarea", {
      attr: { readonly: "true", spellcheck: "false" }
    });
    this.encodedTextarea.addClass("places-decoded-data-textarea");
    this.encodedTextarea.addClass("places-decode-encoded-textarea");

    this.decodedTextarea.addEventListener("input", () => this.scheduleEncode());

    if (this.file) {
      this.loadFromFile(this.file);
    }
  }

  private loadFromFile(file: TFile) {
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
    const encodedValue = frontmatter[this.fieldName] as string | undefined;
    if (!encodedValue) return;

    try {
      const decoded = StringCompressor.decodeAndDecompress(encodedValue);
      this.decodedTextarea.value = decoded;
      this.encodedTextarea.value = encodedValue;
    } catch (error) {
      this.encodedTextarea.value = encodedValue;
      new Notice(getErrorMessage(error), 8000);
    }
  }

  private scheduleEncode() {
    if (this.encodeTimer !== null) window.clearTimeout(this.encodeTimer);
    this.encodeTimer = window.setTimeout(() => this.encode(), 300);
  }

  private encode() {
    const decoded = this.decodedTextarea.value;
    if (!decoded.trim()) {
      this.encodedTextarea.value = "";
      return;
    }
    try {
      this.encodedTextarea.value = StringCompressor.compressAndEncode(decoded);
    } catch {
      // Empty: leave the encoded textarea unchanged.
    }
  }

  onClose() {
    if (this.encodeTimer !== null) window.clearTimeout(this.encodeTimer);
    this.contentEl.empty();
  }
}
