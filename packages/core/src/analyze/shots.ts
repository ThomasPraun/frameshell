// Shots of a film from the scene scores ffmpeg gives each frame. Pure: `scene.ts` reads the scores, `service.ts` writes the table.

/** Scene score at or above which a frame opens a new shot: ffmpeg's own rule of thumb for a hard cut (0.3 to 0.5). */
export const DEFAULT_CUT_THRESHOLD = 0.3;
/** Frames two cuts must be apart: a run of high scores closer than this (a flash, a whip pan) is one cut, the strongest. */
export const MIN_CUT_GAP_FRAMES = 3;

/** The scene score of one frame: how much its picture differs from the frame before, 0 to 1. */
export interface SceneScore {
  frame: number;
  score: number;
}

/** A frame that opens a shot. */
export interface Cut {
  frame: number;
  score: number;
}

/** Seconds of the start of frame `frame`, rounded down to the millisecond: the way every time of an analysis is written. */
export function frameStart(frame: number, fps: number): number {
  return Math.floor((frame * 1000) / fps + 1e-6) / 1000;
}

/** Frame that shows at `seconds` (the frame whose start is the last one not after it). */
export function frameAt(seconds: number, fps: number): number {
  return Math.floor(seconds * fps + 1e-6);
}

/**
 * The cuts among `scores`: frames from the second on scoring at least `threshold`, where a run of candidates
 * within {@link MIN_CUT_GAP_FRAMES} of the one before counts once, as its strongest (the first on a tie). Sorted by frame.
 */
export function detectCuts(scores: readonly SceneScore[], threshold = DEFAULT_CUT_THRESHOLD): Cut[] {
  const candidates = scores.filter(({ frame, score }) => frame > 0 && score >= threshold).sort((a, b) => a.frame - b.frame);
  const cuts: Cut[] = [];
  let last = -Infinity;
  for (const candidate of candidates) {
    const near = candidate.frame - last < MIN_CUT_GAP_FRAMES;
    last = candidate.frame;
    if (!near) cuts.push({ ...candidate });
    else if (candidate.score > cuts.at(-1)!.score) cuts[cuts.length - 1] = { ...candidate };
  }
  return cuts;
}

/** One shot: frames `startFrame` to `endFrame - 1`. */
export interface Shot {
  /** 1-based. */
  index: number;
  startFrame: number;
  endFrame: number;
  /** Score of the cut that opens it; null for the first shot. */
  cutScore: number | null;
}

/** The shots of a film of `frames` frames cut at `cuts` (frames outside 1 to `frames - 1` are ignored). */
export function shotsOf(cuts: readonly Cut[], frames: number): Shot[] {
  const inside = cuts.filter((cut) => cut.frame > 0 && cut.frame < frames);
  const starts = [{ frame: 0, score: null as number | null }, ...inside.map((cut) => ({ frame: cut.frame, score: cut.score as number | null }))];
  return starts.map((start, i) => ({
    index: i + 1,
    startFrame: start.frame,
    endFrame: starts[i + 1]?.frame ?? frames,
    cutScore: start.score,
  }));
}

/** A function giving the 0-based position in `shots` of the shot a frame belongs to (the last one for a frame past the end). */
export function shotLocator(shots: readonly Pick<Shot, "startFrame">[]): (frame: number) => number {
  const starts = shots.map((shot) => shot.startFrame);
  return (frame) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (starts[mid]! <= frame) low = mid;
      else high = mid - 1;
    }
    return low;
  };
}

/** The frame that stands for a shot: its middle, which a transition at either end does not touch. */
export function shotMiddle(shot: Pick<Shot, "startFrame" | "endFrame">): number {
  return Math.floor((shot.startFrame + shot.endFrame - 1) / 2);
}

/** Rhythm of a film's cutting. */
export interface ShotStats {
  shotCount: number;
  /** Cuts per minute of film: `shotCount - 1` over the length. */
  cutsPerMinute: number;
  /** Seconds, rounded down to the millisecond. */
  averageLength: number;
  medianLength: number;
  shortest: number;
  longest: number;
}

/** Counts and lengths of `shots` of a film at `fps`. At least one shot. */
export function shotStats(shots: readonly Pick<Shot, "startFrame" | "endFrame">[], fps: number): ShotStats {
  const lengths = shots.map((shot) => shot.endFrame - shot.startFrame).sort((a, b) => a - b);
  const total = lengths.reduce((sum, length) => sum + length, 0);
  const middle = Math.floor(lengths.length / 2);
  const median = lengths.length % 2 === 1 ? lengths[middle]! : (lengths[middle - 1]! + lengths[middle]!) / 2;
  const minutes = total / fps / 60;
  return {
    shotCount: shots.length,
    cutsPerMinute: minutes > 0 ? Math.round(((shots.length - 1) / minutes) * 100) / 100 : 0,
    averageLength: frameStart(total / shots.length, fps),
    medianLength: frameStart(median, fps),
    shortest: frameStart(lengths[0]!, fps),
    longest: frameStart(lengths.at(-1)!, fps),
  };
}

/**
 * Scene scores in the text of ffmpeg's `metadata=print` filter (one `frame:<n> pts:<p> pts_time:<s>` line then
 * `lavfi.scene_score=<v>` per frame), as frame indexes of a film at `fps`. Lines it does not know are skipped.
 */
export function parseSceneScores(text: string, fps: number): SceneScore[] {
  const scores: SceneScore[] = [];
  let frame: number | null = null;
  for (const line of text.split("\n")) {
    const time = /pts_time:(-?[0-9.]+)/.exec(line);
    if (time) {
      frame = Math.max(0, Math.round(Number(time[1]) * fps));
      continue;
    }
    const score = /lavfi\.scene_score=([0-9.]+)/.exec(line);
    if (score && frame !== null) {
      scores.push({ frame, score: Number(score[1]) });
      frame = null;
    }
  }
  return scores;
}
