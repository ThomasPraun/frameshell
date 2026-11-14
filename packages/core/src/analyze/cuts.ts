import { ANALYZE_CUT_KINDS, ANALYZE_MAX_CUTS, type AnalyzeCut, type AnalyzeCuts } from "@frameshell/protocol";
import { classifyChange, readBoundaryFrames } from "./framing.js";
import { type Cut, MIN_CUT_GAP_FRAMES, frameStart } from "./shots.js";

// Tells the big changes of the picture apart: new scene, jump cut, punch in or out, or no cut. The scene score of
// `shots.ts` only sees the first; this reads the frames either side of every big change (`rhythm.ts`) to find the rest.
// After HyperFrames' `measure` (Apache-2.0), ported per #478.

/** What {@link classifyCuts} reads. */
export interface CutsRequest {
  ffmpeg: string;
  /** Absolute path of the video. */
  file: string;
  film: { width: number; height: number; fps: number };
  /** The big changes of the picture, ascending (`bigChanges`): the cuts of the shot table are among them. */
  changes: readonly Cut[];
  /** Frames that opened a shot at the scene threshold. */
  shotFrames: readonly number[];
  signal?: AbortSignal | undefined;
  /** Fraction read, 0 to 1. */
  progress?: ((fraction: number) => void) | undefined;
}

/** Counts of each kind of cut, zero for those not found. */
function emptyCounts(): AnalyzeCuts["counts"] {
  return Object.fromEntries(ANALYZE_CUT_KINDS.map((kind) => [kind, 0])) as AnalyzeCuts["counts"];
}

/**
 * Classify the first {@link ANALYZE_MAX_CUTS} big changes of the film from the grey frame before and after each, in one
 * more pass over the picture; `warnings` gets a line when there are more. `filmFrames` over `fps` is the length the
 * per-minute figure is taken over.
 */
export async function classifyCuts(request: CutsRequest, filmFrames: number, warnings: string[]): Promise<AnalyzeCuts> {
  const { film, changes } = request;
  const taken = changes.slice(0, ANALYZE_MAX_CUTS);
  if (changes.length > taken.length) warnings.push(`cuts: ${changes.length} big changes found, the first ${ANALYZE_MAX_CUTS} are classified.`);
  const { size, pairs } = await readBoundaryFrames(
    request.ffmpeg,
    request.file,
    film,
    taken.map((change) => change.frame),
    request.signal,
    request.progress,
  );
  const counts = emptyCounts();
  const list: AnalyzeCut[] = [];
  let unread = 0;
  for (const change of taken) {
    const pair = pairs.get(change.frame);
    if (!pair) {
      unread++;
      continue;
    }
    const framing = classifyChange(pair.before, pair.after, size.width, size.height);
    counts[framing.kind]++;
    list.push({
      frame: change.frame,
      time: frameStart(change.frame, film.fps),
      kind: framing.kind,
      score: Math.round(change.score * 100) / 100,
      similarity: framing.similarity,
      scale: framing.scale,
      changed: framing.changed,
      opensShot: request.shotFrames.some((frame) => Math.abs(frame - change.frame) < MIN_CUT_GAP_FRAMES),
    });
  }
  if (unread > 0) warnings.push(`cuts: ${unread} big change${unread === 1 ? "" : "s"} could not be classified (no frame read on one side).`);
  const minutes = filmFrames / film.fps / 60;
  const jumps = counts.jump + counts["punch-in"] + counts["punch-out"];
  return { counts, jumpsPerMinute: minutes > 0 ? Math.round((jumps / minutes) * 100) / 100 : 0, list };
}
