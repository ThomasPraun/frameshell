import type { PeopleSuggestion } from "@frameshell/protocol";
import { useSyncExternalStore } from "react";
import type { PersonTarget } from "../../../shared/api.js";
import { type PeopleSnapshot, type UndoEntry, type UndoStep, inverseOf } from "./model.js";

/** Scan job (`people.scan`) as the panel shows it. */
export interface ScanState {
  running: boolean;
  /** 0..1 of the running job. */
  progress: number;
  /** Why the last scan failed; null otherwise. */
  error: string | null;
}

/**
 * The voice model `people.suggest` compares voices with, as the panel offers it: `ready` (installed, or no voice to
 * compare), `needed` (voices were left out; a download of `bytes` would compare them), `downloading` while asked for.
 */
export interface VoiceModelState {
  state: "ready" | "needed" | "downloading";
  /** Bytes the download fetches; 0 unless `needed` or `downloading`. */
  bytes: number;
  /** 0..1 of the download while it runs; null when unknown, or while voices are compared after it. */
  progress: number | null;
  /** Why the last download failed; null otherwise. */
  error: string | null;
}

/** Everything the People panel reads. */
export interface PeopleState {
  /** `loading` until the first `people.list`; `error` while it fails (e.g. an invalid `people.json`). */
  status: "loading" | "ready" | "error";
  error: string | null;
  snapshot: PeopleSnapshot;
  suggestions: readonly PeopleSuggestion[];
  /** `people.suggest` is running (voice prints are computed on first use: seconds). */
  suggesting: boolean;
  /** The voice model: never downloaded without {@link peopleActions.findVoiceMatches}. */
  voices: VoiceModelState;
  scan: ScanState;
  /** What Cmd/Ctrl+Z puts back: the last change by anyone; null when none, or after an undo. */
  undo: UndoEntry | null;
}

/** Changes arriving this close together are one change: a confirmation of several suggestions emits one event per link. */
const SETTLE_MS = 150;

const INITIAL: PeopleState = {
  status: "loading",
  error: null,
  snapshot: { people: [], dismissed: [] },
  suggestions: [],
  suggesting: false,
  voices: { state: "ready", bytes: 0, progress: null, error: null },
  scan: { running: false, progress: 0, error: null },
  undo: null,
};

let state: PeopleState = INITIAL;
const listeners = new Set<() => void>();
let stop: (() => void) | null = null;
let settleNow: (() => Promise<void>) | null = null;
let beginUndo: (() => Promise<void>) | null = null;
let suggestNow: (() => Promise<void>) | null = null;
/** The next `people.suggest` may download the voice model: the person asked for it. */
let downloadAsked = false;
/** Suggestions answered here that a `people.suggest` in flight may still list. */
const answeredIds = new Set<string>();

function publish(update: Partial<PeopleState>): void {
  state = { ...state, ...update };
  for (const listener of listeners) listener();
}

/**
 * Follow `people.json` through the daemon: read it now and after every `people.changed` (any author, agents
 * included), keep the suggestions current, and track the scan job. The undo entry is the inverse of the last
 * settled change, found by comparing the list before and after it (so it covers an agent's change as well as the
 * panel's own); an undo clears it, so Cmd/Ctrl+Z is one step with no history behind it.
 */
function follow(): () => void {
  let live = true;
  let baseline: PeopleSnapshot | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let undoing = false;
  let suggestingAgain = false;

  const suggest = async () => {
    if (state.suggesting) {
      suggestingAgain = true;
      return;
    }
    publish({ suggesting: true });
    do {
      suggestingAgain = false;
      const download = downloadAsked;
      downloadAsked = false;
      try {
        const { suggestions, voiceDownload } = await window.frameshell.people.suggest(download);
        // A run that started before an answer still lists it; once a run leaves it out the daemon has caught up.
        for (const id of answeredIds) if (!suggestions.some((suggestion) => suggestion.id === id)) answeredIds.delete(id);
        if (live) {
          publish({
            suggestions: suggestions.filter((suggestion) => !answeredIds.has(suggestion.id)),
            // A download asked for meanwhile runs next: its state stays on screen until then.
            voices: !voiceDownload
              ? { state: "ready", bytes: 0, progress: null, error: null }
              : downloadAsked
                ? state.voices
                : { state: "needed", bytes: voiceDownload.bytes, progress: null, error: null },
          });
        }
      } catch (error) {
        // Suggestions are a convenience: a model that cannot be fetched must not block the list.
        if (live) publish({ suggestions: [], ...(download ? { voices: { ...state.voices, state: "needed", progress: null, error: (error as Error).message } } : {}) });
      }
    } while (suggestingAgain && live);
    if (live) publish({ suggesting: false });
  };

  const read = async (): Promise<PeopleSnapshot | null> => {
    try {
      const { people, dismissed } = await window.frameshell.people.list();
      return { people, dismissed };
    } catch (error) {
      if (live) publish({ status: "error", error: (error as Error).message });
      return null;
    }
  };

  const settle = async () => {
    if (undoing) return;
    const next = await read();
    if (!next || !live || undoing) return;
    let undo = state.undo;
    if (baseline) {
      const { entry, changed } = inverseOf(baseline, next);
      if (changed) undo = entry;
    }
    baseline = next;
    publish({ status: "ready", error: null, snapshot: next, undo });
    void suggest();
  };
  settleNow = settle;
  suggestNow = suggest;

  beginUndo = async () => {
    const entry = state.undo;
    if (!entry || undoing) return;
    undoing = true;
    try {
      for (const step of entry.steps) await apply(step);
    } finally {
      undoing = false;
      const next = await read();
      if (next && live) {
        baseline = next;
        publish({ status: "ready", error: null, snapshot: next, undo: null });
        void suggest();
      }
    }
  };

  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void settle(), SETTLE_MS);
  };
  const offChanged = window.frameshell.people.onChanged(later);
  const offScan = window.frameshell.people.onScan((job) => {
    if (!job) return;
    const running = job.state === "queued" || job.state === "running";
    const wasRunning = state.scan.running;
    publish({ scan: { running, progress: job.progress, error: job.state === "failed" ? (job.error ?? "failed") : null } });
    if (wasRunning && job.state === "done") void suggest();
  });
  const offSuggestProgress = window.frameshell.people.onSuggestProgress(({ download, fraction }) => {
    if (state.voices.state === "downloading") publish({ voices: { ...state.voices, progress: download ? fraction : null } });
  });
  void settle();
  return () => {
    live = false;
    clearTimeout(timer);
    offChanged();
    offScan();
    offSuggestProgress();
  };
}

/** One undo step as a daemon call. */
async function apply(step: UndoStep): Promise<void> {
  const { people } = window.frameshell;
  switch (step.kind) {
    case "add":
      await people.add(step.name);
      return;
    case "remove":
      await people.remove(step.person);
      return;
    case "rename":
      await people.rename(step.person, step.name);
      return;
    case "link":
      await people.link(step.person, step.target);
      return;
    case "unlink":
      await people.unlink(step.person, step.target);
      return;
  }
}

/**
 * Drop an answered suggestion at once: the next `people.suggest` may take seconds (voice prints, a model download)
 * and must not leave it on screen meanwhile.
 */
function answered(id: string): void {
  answeredIds.add(id);
  publish({ suggestions: state.suggestions.filter((suggestion) => suggestion.id !== id) });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  stop ??= follow();
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    stop?.();
    stop = null;
    settleNow = null;
    beginUndo = null;
    suggestNow = null;
    downloadAsked = false;
    state = INITIAL;
  };
}

/** The project's people, live; one shared feed that stops with its last caller. */
export function usePeople(): PeopleState {
  return useSyncExternalStore(subscribe, () => state);
}

/**
 * The panel's commands. Each rejects with the daemon's message (a taken name, a link that is gone); the list
 * itself follows `people.changed`, and is read again at once so a command never waits on its event.
 */
export const peopleActions = {
  async add(name: string): Promise<void> {
    await window.frameshell.people.add(name);
    await settleNow?.();
  },
  async rename(person: string, name: string): Promise<void> {
    await window.frameshell.people.rename(person, name);
    await settleNow?.();
  },
  async remove(person: string): Promise<void> {
    await window.frameshell.people.remove(person);
    await settleNow?.();
  },
  async link(person: string, target: PersonTarget): Promise<void> {
    await window.frameshell.people.link(person, target);
    await settleNow?.();
  },
  async unlink(person: string, target: PersonTarget): Promise<void> {
    await window.frameshell.people.unlink(person, target);
    await settleNow?.();
  },
  /** Say yes to a suggestion; `person` names who it is when the suggestion names nobody. */
  async confirm(suggestion: string, person?: string): Promise<void> {
    await window.frameshell.people.confirm([suggestion], person ? { person } : {});
    answered(suggestion);
    await settleNow?.();
  },
  async dismiss(suggestion: string): Promise<void> {
    await window.frameshell.people.confirm([suggestion], { reject: true });
    answered(suggestion);
    await settleNow?.();
  },
  /** Scan every video for faces; progress is in {@link PeopleState.scan}. */
  async scan(): Promise<void> {
    publish({ scan: { running: true, progress: 0, error: null } });
    try {
      await window.frameshell.people.scan();
      publish({ scan: { running: false, progress: 1, error: null } });
    } catch (error) {
      publish({ scan: { running: false, progress: 0, error: (error as Error).message } });
    }
    await settleNow?.();
  },
  /** Download the voice model (the person agreed to, see {@link PeopleState.voices}) and compare voices with it. */
  async findVoiceMatches(): Promise<void> {
    downloadAsked = true;
    publish({ voices: { ...state.voices, state: "downloading", progress: 0, error: null } });
    await suggestNow?.();
  },
  /** Ask for suggestions again: transcripts or multicam groups changed, which no `people.changed` reports. */
  async refreshSuggestions(): Promise<void> {
    await suggestNow?.();
  },
  /** Put the last change back; false when there was nothing to undo. */
  async undo(): Promise<boolean> {
    if (!state.undo || !beginUndo) return false;
    await beginUndo();
    return true;
  },
};
