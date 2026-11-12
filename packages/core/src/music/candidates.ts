import { ErrorCode, type MusicCandidate, type MusicCandidatesResult, RpcError } from "@frameshell/protocol";
import type { AnyClip, ClipTrack, Timeline } from "@frameshell/schema";
import type { LoudnessReading } from "../analyze/loudness.js";
import { isBinaryError } from "../binaries/errors.js";
import { candidateTarget, gainFor, peakWarning } from "../media/loudness-plan.js";
import { resolveTimeRefArg } from "../timeline/time-ref.js";
import { type MusicFitDeps, planMusicFit } from "./run.js";

/** What `music.candidates` needs from the project besides what `music.fit` does. */
export interface MusicCandidatesDeps extends MusicFitDeps {
  /** EBU R128 reading of a project-relative asset (the cached one); throws when it has no sound or cannot be decoded. */
  reading(asset: string): Promise<LoudnessReading>;
  /** Seconds of the sound of a project-relative asset. */
  duration(asset: string): Promise<number>;
}

/** What `music.candidates` was asked, with project-relative `assets`. */
export interface MusicCandidatesRequest {
  assets: readonly string[];
  end?: number | string | undefined;
  from?: number | string | undefined;
  loudness?: number | undefined;
}

/** The placement before anything is written: the report, in rank order, with no track or clip ids yet. */
export type MusicCandidatesPlan = Omit<MusicCandidatesResult, "timeline" | "revision" | "dryRun" | "applied" | "tx">;

const invalid = (message: string, data: Record<string, unknown>) => new RpcError(ErrorCode.InvalidOperation, `music.candidates: ${message}`, { op: "music.candidates", ...data });

const RANKING_FITTED =
  "Files that cover the picture before the final hit first, then by how sure the final hit is; ties keep the order of `assets`.";
const RANKING_GIVEN = "The order of `assets` (without `end` nothing is fitted, so nothing sets them apart).";

/** Track and id the candidate is planned on: a clip of a track no real timeline has, so `planMusicFit` can fit it. */
const PLAN_TRACK = "t_candidate";
const PLAN_CLIP = "c_candidate";

/**
 * The candidates of `request` on `timeline`: each file read for loudness and, with `end`, fitted like `music.fit`
 * slides a clip (its own final hit lands on `end`), then ranked and given the static gain that brings them all to one
 * loudness (ADR 0037 decision 4). A file that cannot be placed goes to `skipped` and the rest go on. Reads only. Throws
 * InvalidOperation (a file twice, `end` not after `from`, nothing placeable) and the `Binary*` errors.
 */
export async function planMusicCandidates(timeline: Timeline, fps: number, request: MusicCandidatesRequest, deps: MusicCandidatesDeps): Promise<MusicCandidatesPlan> {
  const seen = new Set<string>();
  for (const asset of request.assets) {
    if (seen.has(asset)) throw invalid(`${asset} is given twice.`, { reason: "duplicate", field: "assets", hint: "Each candidate is a different file." });
    seen.add(asset);
  }
  const end = request.end === undefined ? null : resolveTimeRefArg("music.candidates", "end", request.end, timeline);
  const from = request.from === undefined ? 0 : resolveTimeRefArg("music.candidates", "from", request.from, timeline);
  if (end !== null && end <= from) {
    throw invalid(`end (${end} s) is not after from (${from} s): there is no picture to fit the music to.`, { reason: "end before from", field: "end", hint: "Give an `end` later than `from`." });
  }

  const skipped: MusicCandidatesPlan["skipped"] = [];
  const placed: Omit<MusicCandidate, "rank" | "name" | "muted" | "gain">[] = [];
  const warnings: string[] = [];
  for (const asset of request.assets) {
    try {
      const reading = await deps.reading(asset);
      if (reading.integrated === null) {
        skipped.push({ asset, reason: "it is silent: there is no loudness to match." });
        continue;
      }
      const duration = await deps.duration(asset);
      const base = { asset, track: null, clip: null, loudness: reading.integrated, truePeak: reading.truePeak, warnings: [] as string[] };
      if (end === null) {
        placed.push({ ...base, place: { start: from, in: 0, speed: 1, end: round3(from + duration) }, hit: null, landsAt: null, introCut: 0, silentBefore: 0 });
        continue;
      }
      const fit = await planMusicFit(withCandidate(timeline, asset, from, duration), fps, { clip: PLAN_CLIP, end, from, exact: false, dryRun: true }, deps);
      placed.push({
        ...base,
        warnings: fit.warnings,
        place: { start: fit.after.start, in: fit.after.in, speed: 1, end: fit.after.end },
        hit: fit.hit,
        landsAt: fit.landsAt,
        introCut: fit.introCut,
        silentBefore: fit.silentBefore,
      });
    } catch (error) {
      if (isBinaryError(error)) throw error;
      skipped.push({ asset, reason: error instanceof Error ? error.message.replace(/^music\.fit: /, "") : String(error) });
    }
  }
  if (placed.length === 0) {
    throw invalid(`none of the ${request.assets.length} files can be placed: ${skipped.map((entry) => `${entry.asset}: ${entry.reason}`).join(" ")}`, {
      reason: "none placeable",
      field: "assets",
      skipped,
      hint: "Pass `end` only for files with a clear final hit, or leave `end` out to place them whole.",
    });
  }
  if (placed.length === 1) warnings.push("Only one file could be placed, so there is nothing to compare.");
  if (skipped.length > 0) warnings.push(`${skipped.length} file(s) left out (see \`skipped\`).`);

  const order = placed.map((candidate, index) => ({ candidate, index }));
  if (end !== null) {
    order.sort((a, b) => Number(a.candidate.silentBefore > 0) - Number(b.candidate.silentBefore > 0) || (b.candidate.hit?.confidence ?? 0) - (a.candidate.hit?.confidence ?? 0) || a.index - b.index);
  }
  const { target, source } = candidateTarget(
    order.map(({ candidate }) => candidate.loudness),
    request.loudness,
  );
  const candidates = order.map(({ candidate }, i): MusicCandidate => {
    const gain = gainFor(candidate.loudness, target);
    const peak = peakWarning(candidate.asset, candidate.truePeak, gain);
    return { ...candidate, rank: i + 1, name: `Music ${i + 1}`, muted: i > 0, gain, warnings: peak ? [...candidate.warnings, peak] : candidate.warnings };
  });
  return { end, loudness: { target, source }, ranking: end === null ? RANKING_GIVEN : RANKING_FITTED, candidates, skipped, warnings };
}

/** `Music candidates: 3 tracks at -18 LUFS`. */
export function musicCandidatesLabel(plan: Pick<MusicCandidatesPlan, "candidates" | "loudness">): string {
  return `Music candidates: ${plan.candidates.length} tracks at ${plan.loudness.target} LUFS`;
}

/** `timeline` with one more audio track holding a clip of `asset` playing it whole from `start`: what `planMusicFit` fits. */
function withCandidate(timeline: Timeline, asset: string, start: number, duration: number): Timeline {
  const clip = { id: PLAN_CLIP, type: "media", asset, start, in: 0, out: duration } as AnyClip;
  const track: ClipTrack = { id: PLAN_TRACK, kind: "audio", clips: [clip] as ClipTrack["clips"] };
  return { ...timeline, tracks: [...timeline.tracks, track] };
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;
