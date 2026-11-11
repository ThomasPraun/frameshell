import { type CleanupCandidate, type CleanupResult, ErrorCode, RpcError } from "@frameshell/protocol";
import { type Timeline, withProgramSound } from "@frameshell/schema";
import { sourceTranscripts } from "../transcripts/verify.js";
import { type SpeechSources, gatherSpeech } from "./speech.js";
import { type PlannedCut, planCleanup } from "./plan.js";

/** What `cleanup` was asked for, defaults filled in. */
export interface CleanupRequest {
  pauses: number | false;
  breath: number;
  retakes: boolean;
  minConfidence: number;
  skip?: readonly string[] | undefined;
}

/** What the plan needs from the project. */
export interface CleanupDeps extends Omit<SpeechSources, "transcripts"> {
  /** Current `sha256:<hex>` of a project-relative asset, or null when unknown; a transcript of other content is stale. */
  assetHash(asset: string): Promise<string | null>;
}

/** A plan: the cuts to make, in timeline order, and what was seen on the way. */
export type CleanupPlan = Pick<CleanupResult, "candidates" | "skipped" | "words" | "warnings" | "removed">;

const invalid = (message: string, data: Record<string, unknown>) =>
  new RpcError(ErrorCode.InvalidOperation, `cleanup: ${message}`, { op: "cleanup", ...data });

/**
 * The cuts `cleanup` proposes for `timeline` (#455): pauses and retakes of the words its media clips keep, edges placed
 * by the audio. Reads only; applying is the caller's, last cut first. Throws InvalidOperation for options that cannot
 * work, a `skip` id that is no candidate, or a timeline with no transcribed speech.
 */
export async function planTimelineCleanup(projectDir: string, timeline: Timeline, fps: number, request: CleanupRequest, deps: CleanupDeps): Promise<CleanupPlan> {
  if (request.pauses === false && !request.retakes) {
    throw invalid("nothing to look for: pauses are off and retakes were not asked for.", { reason: "nothing to do", field: "retakes", hint: "Pass `retakes: true`, or give `pauses` seconds." });
  }
  if (request.pauses !== false && request.breath * 2 >= request.pauses) {
    throw invalid(`breath ${request.breath} s on each side leaves nothing of a ${request.pauses} s pause.`, {
      reason: "breath",
      field: "breath",
      valid: { max: Math.max(0, Math.floor((request.pauses / 2) * 1000 - 1) / 1000) },
      hint: "Lower `breath`, or raise `pauses`.",
    });
  }
  // Words are heard, not seen: a program track counts as its angles' sound.
  const heard = withProgramSound(timeline);
  const transcripts = await sourceTranscripts(projectDir, heard, deps.assetHash);
  const speech = await gatherSpeech(heard, fps, { transcripts, profile: deps.profile, hasAudio: deps.hasAudio });
  if (speech.clips === 0) {
    const why = speech.unchecked.map((entry) => `${entry.clip} (${entry.asset}): ${entry.reason}`);
    throw invalid(
      why.length > 0 ? `no clip has speech to look at: ${why.join("; ")}.` : "the timeline has no unmuted media clip.",
      { reason: "no speech", unchecked: speech.unchecked, hint: "Transcribe the assets first: `frameshell transcribe <asset>`." },
    );
  }
  const warnings = speech.unchecked.map((entry) => `Clip ${entry.clip} (${entry.asset}) is left alone: ${entry.reason}.`);
  const { cuts, skipped, absorbed } = planCleanup(speech.words, speech.audio, { fps, ...request });

  // Ids follow a dry run: the pauses it lists first, then, after them, the ones a retake covers. Rejecting that retake
  // brings those back without renumbering the rest.
  const shown = cuts.filter((cut) => cut.kind === "pause");
  const covered = [...new Set([...absorbed.values()].flat())].sort((a, b) => a.start - b.start);
  const retakeCuts = cuts.filter((cut) => cut.kind === "retake");
  const idOf = new Map<PlannedCut, string>([
    ...[...shown, ...covered].map((cut, index) => [cut, `p${index + 1}`] as const),
    ...retakeCuts.map((cut, index) => [cut, `r${index + 1}`] as const),
  ]);
  const numbered: CleanupCandidate[] = cuts.map((cut) => ({ id: idOf.get(cut)!, ...cut }));
  const skipIds = new Set(request.skip ?? []);
  const unknown = [...skipIds].filter((id) => !numbered.some((candidate) => candidate.id === id));
  if (unknown.length > 0) {
    throw invalid(`${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not a candidate.`, {
      reason: "skip",
      field: "skip",
      valid: numbered.map((candidate) => candidate.id),
      hint: "Run a dry run with the same options and skip ids from its candidates.",
    });
  }
  const remaining = cuts.filter((cut) => !skipIds.has(idOf.get(cut)!));
  // A rejected retake gives back the pauses it covered, unless another retake still covers them.
  const standing = remaining.filter((cut) => cut.kind === "retake");
  const restored = retakeCuts
    .filter((retake) => skipIds.has(idOf.get(retake)!))
    .flatMap((retake) => absorbed.get(retake) ?? [])
    .filter((pause, index, all) => all.indexOf(pause) === index && !standing.some((retake) => pause.start < retake.end && retake.start < pause.end));
  const candidates: CleanupCandidate[] = [...remaining, ...restored]
    .sort((a, b) => a.start - b.start)
    .map((cut) => ({ id: idOf.get(cut)!, ...cut }));
  return {
    candidates,
    skipped,
    words: speech.words.length,
    removed: Math.round(candidates.reduce((sum, candidate) => sum + candidate.duration, 0) * 1000) / 1000,
    warnings,
  };
}

/** Transaction label for the cuts of `candidates`: `Cleanup: 5 pauses, 2 retakes`. */
export function cleanupLabel(candidates: readonly CleanupCandidate[]): string {
  const count = (kind: CleanupCandidate["kind"]) => candidates.filter((candidate) => candidate.kind === kind).length;
  const [pauses, retakes] = [count("pause"), count("retake")];
  const parts = [pauses > 0 ? `${pauses} pause${pauses === 1 ? "" : "s"}` : null, retakes > 0 ? `${retakes} retake${retakes === 1 ? "" : "s"}` : null];
  return `Cleanup: ${parts.filter((part) => part !== null).join(", ")}`;
}
