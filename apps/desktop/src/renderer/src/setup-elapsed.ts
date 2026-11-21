import { elapsedLabel } from "./shoot/model.js";

/** A running step shows how long it has run once it passed this, so a long model load does not look hung (#742). */
export const SETUP_ELAPSED_AFTER_MS = 10_000;
/** A step with no percentage this long gets the "slow on CPU" hint (#742: a model load ran ~10 minutes). */
export const SETUP_SLOW_AFTER_MS = 60_000;

/** What the status bar adds to a running setup step that started at `since`. */
export interface SetupTiming {
  /** `m:ss` the step has run, or null while it is still short. */
  elapsed: string | null;
  /** True when the step ran long with no percentage: the hint that CPU transcription is slow. */
  slow: boolean;
}

/** {@link SetupTiming} of a running step that started at `since` (ms), at `now`; `fraction` null = no percentage. */
export function setupTiming(since: number, now: number, fraction: number | null): SetupTiming {
  const ran = now - since;
  return {
    elapsed: ran >= SETUP_ELAPSED_AFTER_MS ? elapsedLabel(ran) : null,
    slow: fraction === null && ran >= SETUP_SLOW_AFTER_MS,
  };
}
