// The one Audition dialog's state (ADR 0038): the sounds read through `audio.inspect`, the "Match loudness" switch and
// which row plays. One store outside the view, like the voiceover dialog, so it opens from the Explorer or the timeline.
import type { AudioInspectResult } from "@frameshell/protocol";
import { selection } from "../selection.js";
import { playingVoice, setVoiceGain, stopVoice } from "../people/voice-play.js";
import { matchGains } from "./model.js";

/** What the dialog shows. */
export interface AuditionState {
  /** Project-relative sound files, in the order asked. */
  files: string[];
  /** Window the dialog shows in: the project window, or a detached panel's (ADR 0012). */
  view: Window;
  read: { kind: "reading" } | { kind: "ready"; result: AuditionResult } | { kind: "failed"; message: string };
  /** "Match loudness" is on. */
  match: boolean;
}

/** The daemon's reading of the files. */
export type AuditionResult = AudioInspectResult;

/** Prefix of the keys of rows in the one-at-a-time player (`people/voice-play.ts`). */
const KEY = "audition:";

/** Key of the row of `file` in the player. */
export function playKey(file: string): string {
  return `${KEY}${file}`;
}

let current: AuditionState | null = null;
/** Identifies the dialog being shown: a reading that arrives after it closed or was replaced is dropped. */
let session = 0;
const listeners = new Set<() => void>();

function publish(next: AuditionState | null): void {
  current = next;
  for (const listener of listeners) listener();
}

/** Stop the row playing, if one of this dialog's rows is what plays. */
function stopRow(): void {
  if (playingVoice()?.startsWith(KEY)) stopVoice();
}

/** Playback gain of `file` in `state`, dB. */
export function gainOf(state: AuditionState, file: string): number {
  if (state.read.kind !== "ready") return 0;
  const { items } = state.read.result;
  const index = items.findIndex((item) => item.asset === file);
  return index < 0 ? 0 : matchGains(items.map((item) => item.lufs), state.match)[index]!;
}

/** The dialog's actions; {@link auditionDialog.get} is what it shows. */
export const auditionDialog = {
  /** Open the dialog on `files` (project-relative sound files) in `view`, the window the command was given in. */
  async open(files: string[], view: Window = window): Promise<void> {
    stopRow();
    const id = ++session;
    publish({ files, view, read: { kind: "reading" }, match: false });
    if (view !== window) view.addEventListener("pagehide", () => id === session && current && publish({ ...current, view: window }), { once: true });
    try {
      const result = await window.frameshell.media.inspect(files);
      if (id === session && current) publish({ ...current, read: { kind: "ready", result } });
    } catch (error) {
      if (id === session && current) publish({ ...current, read: { kind: "failed", message: (error as Error).message ?? String(error) } });
    }
  },

  /** Turn "Match loudness" on or off; the row playing changes level at once. */
  setMatch(match: boolean): void {
    if (!current) return;
    publish({ ...current, match });
    const playing = playingVoice();
    if (playing?.startsWith(KEY)) setVoiceGain(playing, gainOf(current, playing.slice(KEY.length)));
  },

  /** "Use this": select `file` in the Explorer (the shared selection) and close. No timeline edit. */
  use(file: string): void {
    selection.selectFiles([file], "explorer");
    auditionDialog.close();
  },

  /** Close the dialog and stop its row playing. */
  close(): void {
    if (!current) return;
    stopRow();
    session++;
    publish(null);
  },

  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  get: (): AuditionState | null => current,
};
