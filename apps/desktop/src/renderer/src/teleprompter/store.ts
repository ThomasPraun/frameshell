import { useSyncExternalStore } from "react";
import { FONT_SIZES, type PromptPosition, fontSize } from "./model.js";

/** Who moved the teleprompter: the person's keys, or a driver such as live following (#393) or the session's takes (#391). */
export type PromptSource = "keys" | "follow";

/** The teleprompter's position: the one copy the renderer keeps, read and set by the Shoot view and the panel. */
export interface TeleprompterState {
  /** Shoot script shown, project-relative; null until one is chosen. */
  script: string | null;
  /** Where the reader is in `script`; null until a scene is set (the panel then starts at `shoot.status` `next`). */
  position: PromptPosition | null;
  /** Held: drivers' moves are ignored until resumed; the person's keys still move it. */
  held: boolean;
  /**
   * Sentences live following jumped over, each by its first word: provisional marks drawn struck through, never
   * written to the project. Cleared with the script.
   */
  skipped: readonly PromptPosition[];
}

/** Per-viewer display settings, kept in this renderer's storage. */
export interface TeleprompterSettings {
  /** px; see {@link FONT_SIZES}. */
  fontSize: number;
  /** Flipped left to right, for a beam-splitter prompter. */
  mirror: boolean;
  /** Cues shown (small); a `[FREE: …]` slot shows either way. */
  cues: boolean;
  /** Live recognition moves it (ADR 0024 decision 5) when it is available. */
  follow: boolean;
}

const SETTINGS_KEY = "frameshell.teleprompter.settings";
const DEFAULT_SETTINGS: TeleprompterSettings = { fontSize: FONT_SIZES.initial, mirror: false, cues: true, follow: true };

let state: TeleprompterState = { script: null, position: null, held: false, skipped: [] };
let settings: TeleprompterSettings = readSettings();
const listeners = new Set<() => void>();
const openers = new Set<() => void>();

function set(next: TeleprompterState): void {
  if (next.script === state.script && next.position === state.position && next.held === state.held && next.skipped === state.skipped) return;
  state = next;
  for (const listener of [...listeners]) listener();
}

function readSettings(): TeleprompterSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<Record<keyof TeleprompterSettings, unknown>>;
    return {
      fontSize: fontSize(raw.fontSize),
      mirror: typeof raw.mirror === "boolean" ? raw.mirror : DEFAULT_SETTINGS.mirror,
      cues: typeof raw.cues === "boolean" ? raw.cues : DEFAULT_SETTINGS.cues,
      follow: typeof raw.follow === "boolean" ? raw.follow : DEFAULT_SETTINGS.follow,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/**
 * The teleprompter (ADR 0024 decision 6): which shoot script it shows, where the reader is, and whether it is held.
 * Detached panels are drawn by this same renderer (ADR 0012), so the panel in its own window and the Shoot view
 * share this one store.
 */
export const teleprompter = {
  /** Latest state. */
  get(): TeleprompterState {
    return state;
  },
  /** Call `listener` after each change of the state. Returns the function that removes it. */
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
  /** Show `script`; a different script drops the position, so the panel starts it at its next scene. */
  setScript(script: string | null): void {
    if (script !== state.script) set({ ...state, script, position: null, skipped: [] });
  },
  /**
   * Move to `position` in the current script (`script` names another to switch to it first). A driver's move
   * (`follow`) is ignored while held; the person's keys always move. Returns whether it moved.
   */
  setPosition(position: PromptPosition, source: PromptSource = "keys", script = state.script): boolean {
    if (source === "follow" && state.held) return false;
    const current = state.position;
    if (script === state.script && current && current.scene === position.scene && current.line === position.line && current.word === position.word) return true;
    set({ ...state, script, position: { ...position }, skipped: script === state.script ? state.skipped : [] });
    return true;
  },
  /** Replace the provisional skipped marks (see {@link TeleprompterState.skipped}). */
  setSkipped(skipped: readonly PromptPosition[]): void {
    set({ ...state, skipped });
  },
  /** Hold or resume: see {@link TeleprompterState.held}. */
  setHeld(held: boolean): void {
    set({ ...state, held });
  },
  /** Ask the project window to show the teleprompter in its own window. */
  open(): void {
    for (const opener of [...openers]) opener();
  },
  /** Called on each {@link open}. Returns the function that removes it. */
  onOpen(listener: () => void): () => void {
    openers.add(listener);
    return () => void openers.delete(listener);
  },
  /** Per-viewer display settings. */
  settings(): TeleprompterSettings {
    return settings;
  },
  /** Change display settings and remember them for this viewer. */
  setSettings(change: Partial<TeleprompterSettings>): void {
    const next = { ...settings, ...change };
    next.fontSize = fontSize(next.fontSize);
    if (next.fontSize === settings.fontSize && next.mirror === settings.mirror && next.cues === settings.cues && next.follow === settings.follow) return;
    settings = next;
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // Storage blocked: the settings hold until the window reloads.
    }
    for (const listener of [...listeners]) listener();
  },
};

/** The teleprompter's state, live. */
export function useTeleprompter(): TeleprompterState {
  return useSyncExternalStore(teleprompter.subscribe, teleprompter.get);
}

/** The display settings, live. */
export function useTeleprompterSettings(): TeleprompterSettings {
  return useSyncExternalStore(teleprompter.subscribe, teleprompter.settings);
}
