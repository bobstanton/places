import { App, TFile } from "obsidian";
import { isPlacesCodeBlock } from "../editor/PlacesEditorContext";
import { extractTemplateBlock } from "./TemplateNoteService";
import { logger as rootLogger } from "places-shared/utils";

const logger = rootLogger.scope("Places");

// The key whose values are template references, in its lowercase comparison form.
const TEMPLATE_KEY = "fromtemplate";

export interface TemplateRenameTarget {
  // Old path without the `.md` extension, e.g. `Places Templates/Base Map`.
  oldLinkpath: string;
  // New path without the `.md` extension.
  newLinkpath: string;
  // Whether a reference written as a bare basename may be rewritten.
  //
  // A basename is only unambiguous while no other note shares it. Obsidian
  // resolves this from the link cache it captured before the move; that cache
  // is already stale by the time a rename event arrives here, and the caller
  // checks the vault instead and says whether it is safe.
  allowBasenameMatch: boolean;
  // Whether a bare-name reference must be rewritten as the full new path.
  //
  // The short form only names this note while no other note shares the new
  // basename. When one does, the short spelling would resolve to whichever
  // note Obsidian ranks first, and the full path is the only rewrite that
  // still means the renamed note.
  qualifyBareReferences: boolean;
}

// Rewrite `fromTemplate:` references to a renamed note.
//
// Obsidian does not rewrite links inside code fences, because it does not parse
// them as links in the first place, and a template note rename would silently
// break every block referencing it. This does that one job, scoped tightly: only
// inside `places` fences, only on template keys, and only for references that
// name the renamed note.
//
// The written form is preserved rather than normalized. Someone who wrote a full
// path meant to disambiguate, and someone who wrote a bare name meant it to read
// short; a rename is no reason to overrule either. Headings and aliases ride
// along untouched. The one exception is a bare name whose new spelling another
// note also carries (`qualifyBareReferences`) - keeping it short would repoint
// it, and only the full path is written.
//
// Returns the new markdown, or undefined when nothing referenced the note.
export function rewriteTemplateReferences(markdown: string, target: TemplateRenameTarget): string | undefined {
  const lines = markdown.split("\n");
  let changed = false;
  let fenceLanguage: string | undefined;
  let fenceMarker: string | undefined;
  let inTemplateList = false;
  let listIndent = 0;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fence = line.match(/^\s*(`{3,}|~{3,})\s*([A-Za-z][\w-]*)?/u);

    if (fence) {
      const marker = fence[1];
      if (fenceMarker === undefined) {
        fenceMarker = marker;
        fenceLanguage = fence[2];
      } else if (marker[0] === fenceMarker[0] && marker.length >= fenceMarker.length) {
        fenceMarker = undefined;
        fenceLanguage = undefined;
      }
      inTemplateList = false;
      continue;
    }

    if (fenceMarker === undefined || !fenceLanguage || !isPlacesCodeBlock(fenceLanguage)) continue;

    const keyMatch = line.match(/^(\s*)([A-Za-z]\w*)(\s*:\s*)(.*)$/u);
    if (keyMatch) {
      const [, indent, key, separator, value] = keyMatch;
      if (key.toLowerCase() !== TEMPLATE_KEY) {
        inTemplateList = false;
        continue;
      }
      // `fromTemplate:` with nothing after it opens a YAML list; its items are
      // the following `- ` lines at the key's own indent or deeper.
      inTemplateList = value.trim().length === 0;
      listIndent = indent.length;
      if (!inTemplateList) {
        const rewritten = rewriteValue(value, target);
        if (rewritten !== undefined) {
          lines[index] = `${indent}${key}${separator}${rewritten}`;
          changed = true;
        }
      }
      continue;
    }

    if (!inTemplateList) continue;

    const item = line.match(/^(\s*)(-\s+)(.*)$/u);
    if (!item || item[1].length < listIndent) {
      inTemplateList = false;
      continue;
    }
    const rewritten = rewriteValue(item[3], target);
    if (rewritten !== undefined) {
      lines[index] = `${item[1]}${item[2]}${rewritten}`;
      changed = true;
    }
  }

  return changed ? lines.join("\n") : undefined;
}

// Rewrite every reference in one key's value, which may be comma-separated.
function rewriteValue(value: string, target: TemplateRenameTarget): string | undefined {
  const trailing = value.match(/\s*$/u)?.[0] ?? "";
  const parts = value.trimEnd().split(",");
  let changed = false;

  const rewritten = parts.map(part => {
    const leading = part.match(/^\s*/u)?.[0] ?? "";
    const token = part.trim();
    const next = rewriteReference(token, target);
    // A bare name matched during a folder rename rebuilds to itself; reporting
    // that as a change would write - and sync - a byte-identical note.
    if (next === undefined || next === token) return part;
    changed = true;
    return `${leading}${next}`;
  });

  return changed ? rewritten.join(",") + trailing : undefined;
}

// Rewrite one reference, keeping its quote and bracket form, heading and alias.
function rewriteReference(token: string, target: TemplateRenameTarget): string | undefined {
  // A quoted wikilink is how YAML authors keep `[[..]]` a plain string; the
  // parser resolves it the same as an unquoted one, and the rewrite must see
  // through the quotes too.
  const quoted = token.match(/^(["'])(.+)\1$/u);
  if (quoted) {
    const inner = rewriteReference(quoted[2], target);
    return inner === undefined ? undefined : `${quoted[1]}${inner}${quoted[1]}`;
  }

  const linked = token.match(/^\[\[(.+?)\]\]$/u);
  const inner = linked?.[1] ?? token;
  if (!inner.trim()) return undefined;

  const [beforeAlias, ...aliasParts] = inner.split("|");
  const hashIndex = beforeAlias.indexOf("#");
  const linkpath = (hashIndex < 0 ? beforeAlias : beforeAlias.slice(0, hashIndex)).trim();
  const heading = hashIndex < 0 ? "" : beforeAlias.slice(hashIndex);

  const replacement = matchLinkpath(linkpath, target);
  if (replacement === undefined) return undefined;

  const alias = aliasParts.length > 0 ? `|${aliasParts.join("|")}` : "";
  const rebuilt = `${replacement}${heading}${alias}`;
  return linked ? `[[${rebuilt}]]` : rebuilt;
}

// The new linkpath for a reference naming the renamed note, in the form it was written unless only the full path is unambiguous.
function matchLinkpath(linkpath: string, target: TemplateRenameTarget): string | undefined {
  const normalized = linkpath.replace(/\.md$/iu, "");
  if (normalized.toLowerCase() === target.oldLinkpath.toLowerCase()) return target.newLinkpath;

  if (!target.allowBasenameMatch) return undefined;
  const oldBase = basename(target.oldLinkpath);
  if (normalized.toLowerCase() !== oldBase.toLowerCase()) return undefined;
  return target.qualifyBareReferences ? target.newLinkpath : basename(target.newLinkpath);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

// Whether a renamed note is one anything could reference as a template.
// One read of the renamed note replaces a read of every note in the vault.
async function definesTemplate(app: App, path: string): Promise<boolean> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile) || file.extension.toLowerCase() !== "md") return false;
  try {
    return extractTemplateBlock(await app.vault.cachedRead(file)) !== undefined;
  } catch {
    return false;
  }
}

// Build the rewrite target for one rename, deciding whether bare names are safe to touch.
function buildTarget(app: App, oldPath: string, newPath: string): TemplateRenameTarget | undefined {
  const oldLinkpath = oldPath.replace(/\.md$/iu, "");
  const newLinkpath = newPath.replace(/\.md$/iu, "");
  if (oldLinkpath === newLinkpath) return undefined;

  // A bare `[[Base Map]]` only meant this note while no other note shares the
  // name. If one does now, the reference is genuinely ambiguous and leaving it
  // alone is better than repointing it at the wrong note.
  const files = app.vault.getMarkdownFiles();
  const oldBase = basename(oldLinkpath).toLowerCase();
  const allowBasenameMatch = !files.some(file => file.path !== newPath && file.basename.toLowerCase() === oldBase);

  // The same ambiguity exists on the write side: a short name another note
  // also carries would resolve to whichever Obsidian ranks first, and those
  // rewrites must spell out the full path.
  const newBase = basename(newLinkpath).toLowerCase();
  const qualifyBareReferences = files.some(file => file.path !== newPath && file.basename.toLowerCase() === newBase);

  return { oldLinkpath, newLinkpath, allowBasenameMatch, qualifyBareReferences };
}

// Rewrite every note referencing any of these renamed template notes, in one pass.
//
// The vault is scanned because template references live inside code fences,
// which Obsidian's link index does not cover - there is no cache to ask. Taking
// several renames together matters for a folder rename, which arrives as one
// event per file inside it and would otherwise scan once per template.
export async function renameTemplateReferences(app: App, targets: readonly TemplateRenameTarget[]): Promise<number> {
  if (targets.length === 0) return 0;
  let updated = 0;

  for (const file of app.vault.getMarkdownFiles()) {
    try {
      const current = await app.vault.cachedRead(file);
      if (!current.toLowerCase().includes("fromtemplate")) continue;
      // Decide from the cached copy: a note that merely mentions the key is
      // never written back. `process` writes whatever it is handed, and a write
      // means a new mtime, a modify event, and a sync of an unchanged note.
      if (applyTargets(current, targets) === undefined) continue;

      await app.vault.process(file, data => applyTargets(data, targets) ?? data);
      updated++;
    } catch (error) {
      logger.warn("Could not update template references", { path: file.path, error });
    }
  }

  if (updated > 0) {
    logger.info("Updated template references after rename", { renames: targets.length, notes: updated });
  }
  return updated;
}

// Apply every rename to one note's text, or undefined when none of them matched.
function applyTargets(markdown: string, targets: readonly TemplateRenameTarget[]): string | undefined {
  let result: string | undefined;
  for (const target of targets) {
    const next = rewriteTemplateReferences(result ?? markdown, target);
    if (next !== undefined) result = next;
  }
  return result;
}

// Collects renames and rewrites references once they stop arriving.
//
// Renaming a folder emits one event per file inside it. Handling them
// individually would scan the vault once per template; waiting a moment turns
// that into a single pass. The wait also keeps the scan off the event handler,
// and a rename never blocks on it.
export class TemplateRenameQueue {
  private readonly pending: TemplateRenameTarget[] = [];
  private timer: number | null = null;

  constructor(private readonly app: App, private readonly onUpdated: () => void) {}

  // Note a rename; scans only if the renamed note actually defined a template.
  async queue(oldPath: string, newPath: string): Promise<void> {
    if (!oldPath.toLowerCase().endsWith(".md")) return;
    if (!await definesTemplate(this.app, newPath)) return;

    const target = buildTarget(this.app, oldPath, newPath);
    if (!target) return;

    this.pending.push(target);
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { void this.flush(); }, BATCH_WINDOW_MS);
  }

  private async flush(): Promise<void> {
    this.timer = null;
    const targets = this.pending.splice(0);
    if (await renameTemplateReferences(this.app, targets) > 0) this.onUpdated();
  }

  dispose(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.pending.length = 0;
  }
}

// Long enough to absorb a folder rename's per-file events, short enough to feel immediate.
const BATCH_WINDOW_MS = 100;
