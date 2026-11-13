// File commands of context menus, shared by the Explorer and the timeline: Reveal, Copy path, Move to Trash.
import { parseVoiceoverScript } from "@frameshell/schema";
import type { MenuItem } from "./components/ContextMenu.js";
import { t } from "./i18n.js";

const agent = navigator.userAgent;
const PLATFORM = agent.includes("Mac") ? "mac" : agent.includes("Windows") ? "windows" : "linux";

/** "Reveal in Finder", or the platform's file manager. */
export function revealLabel(): string {
  return t.editor.reveal(PLATFORM);
}

/** {@link revealLabel} for project-relative `path`. */
export function revealItem(path: string, separated = false): MenuItem {
  return { label: revealLabel(), separated, run: () => void window.frameshell.files.reveal(path) };
}

/** "Copy path": the absolute path of project-relative `path` on the clipboard. */
export function copyPathItem(path: string): MenuItem {
  return { label: t.editor.copyPath, run: () => void window.frameshell.files.copyPath(path) };
}

/**
 * "Generate voiceover…" for the script at project-relative `path`, only when its frontmatter says `voiceover: true`
 * (the file is read to know); empty for any other script, or when it cannot be read. Says its lines, asking first when the provider charges.
 */
export async function voiceoverItems(path: string): Promise<MenuItem[]> {
  const text = await window.frameshell.files.read(path).catch(() => null);
  if (text === null || !parseVoiceoverScript(text).voiceover.voiceover) return [];
  return [{ label: t.editor.generateVoiceover, run: () => void window.frameshell.files.generateVoiceover(path) }];
}

/** Reveal, Copy path, then Move to Trash (main asks first; the OS trash is the undo) for project-relative `path`. */
export function placeItems(path: string): MenuItem[] {
  const files = window.frameshell.files;
  return [
    revealItem(path, true),
    copyPathItem(path),
    { label: t.editor.moveToTrash(PLATFORM === "windows"), separated: true, danger: true, run: () => void files.trash(path) },
  ];
}
