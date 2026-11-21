import type { EventParams, Progress } from "@frameshell/protocol";

/** Progress-only updates of one run go out at most this often; state changes at once. */
export const ANNOUNCE_EVERY_MS = 250;

/** One `transcription.progress` update without its `project` (the daemon adds it). */
export type TranscriptionUpdate = Omit<EventParams<"transcription.progress">, "project">;

/** What a `transcribe` run reports to every subscriber of its project, besides its own caller. */
export interface TranscriptionAnnouncer {
  /** Pass to the run in place of the caller's progress: it forwards every report and announces it (throttled). */
  progress(update: Progress): void;
  /**
   * Announce the end: `done`, or `failed` with the error's message. Nothing when the run never reported progress (a
   * consent refusal, a missing asset): it never showed, so it does not end either. Later calls do nothing.
   */
  end(error?: unknown): void;
}

/**
 * Announce run `id` of `asset` through `publish` so a UI that did not start it shows it (#742: a CLI transcription
 * was invisible in the app). `forward` is the caller's own progress; `now` the clock, for tests.
 */
export function announceTranscription(
  id: string,
  asset: string,
  publish: (update: TranscriptionUpdate) => void,
  forward: (update: Progress) => void,
  now: () => number = Date.now,
): TranscriptionAnnouncer {
  let last = -Infinity;
  let started = false;
  let ended = false;
  let latest: Progress | null = null;
  const send = (state: TranscriptionUpdate["state"], update: Progress) =>
    publish({
      id,
      asset,
      state,
      message: update.message,
      ...(update.fraction !== undefined ? { fraction: update.fraction } : {}),
      ...(update.stage !== undefined ? { stage: update.stage } : {}),
      ...(update.values !== undefined ? { values: update.values } : {}),
    });
  return {
    progress(update) {
      forward(update);
      if (ended) return;
      const stepChanged = latest === null || update.stage !== latest.stage || update.message !== latest.message;
      latest = update;
      if (!stepChanged && now() - last < ANNOUNCE_EVERY_MS) return;
      last = now();
      started = true;
      send("running", update);
    },
    end(error) {
      if (ended) return;
      ended = true;
      if (!started) return;
      if (error === undefined) send("done", { message: "Transcribed" });
      else send("failed", { message: error instanceof Error ? error.message : String(error) });
    },
  };
}
