import { App, TFile } from "obsidian";

export async function readTrackFileContent(app: App, file: TFile): Promise<string | Uint8Array> {
  if (file.extension.toLowerCase() === 'fit') {
    return new Uint8Array(await app.vault.readBinary(file));
  }

  return app.vault.cachedRead(file);
}
