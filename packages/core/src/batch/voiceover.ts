import { ErrorCode, RpcError } from "@frameshell/protocol";
import { type BatchVoiceover, type Timeline, VOICEOVER_LINE_GAP_S } from "@frameshell/schema";
import type { OperationRequest } from "../timeline/engine.js";
import { type VoiceoverPlaceParams, planVoiceoverPlacement, runVoiceoverPlan } from "../voiceover/place.js";
import type { VariantContext } from "./variant.js";

/** A row's voiceover placed on its variant. */
export interface RowVoiceover {
  timeline: Timeline;
  /** Warnings of the placement (a take said from older text, and what the engine noted). */
  warnings: string[];
}

/**
 * Place the takes of `spec.script` on `timeline` in memory, with the planner and the writer of `voiceover.place`
 * (ADR 0034 decision 19): the same phrase clips, spacing, anchors, tempo, fades and overlap rules, applied to the
 * variant instead of a file. Never generates (a line with no take fails). Throws the placement's errors as they are;
 * a subtitle track that follows the voice track needs a transcript of every take, so one without it fails naming the take.
 */
export async function placeRowVoiceover(timeline: Timeline, spec: BatchVoiceover, context: VariantContext): Promise<RowVoiceover> {
  const params: VoiceoverPlaceParams = {
    cwd: context.root,
    timeline: timeline.id,
    script: spec.script,
    ...(spec.lines ? { lines: spec.lines } : {}),
    ...(spec.at ? { at: spec.at } : {}),
    ...(spec.tempo ? { tempo: spec.tempo } : {}),
    ...(spec.start !== undefined ? { start: spec.start } : {}),
    gap: spec.gap ?? VOICEOVER_LINE_GAP_S,
    ...(spec.track ? { track: spec.track } : {}),
    replace: spec.replace ?? false,
    dryRun: false,
  };
  const loaded = { timeline, fps: context.fps };
  const plan = await planVoiceoverPlacement(params, {
    root: context.root,
    load: async () => loaded,
    resolve: (ref, from) => context.resolve(ref, from),
  });
  if (plan.clips.length === 0) {
    throw new RpcError(ErrorCode.InvalidOperation, `${spec.script} has no phrase to place: ${plan.warnings.join(" ") || "its lines are shorter than one frame"}`, { reason: "no phrase" });
  }
  // The voice track the phrases go on is known now: subtitles that follow it read the words of each take.
  const follower = plan.track.id === null ? undefined : timeline.tracks.find((candidate) => candidate.kind === "subtitles" && candidate.follows === plan.track.id);
  if (follower) {
    for (const file of new Set(plan.clips.map((clip) => clip.file))) {
      if (!(await context.hasTranscript(file))) {
        throw new RpcError(
          ErrorCode.InvalidOperation,
          `subtitle track ${follower.id} follows track ${plan.track.id}, but ${file} has no transcript. Transcribe it first: \`frameshell transcribe ${file}\`.`,
          { reason: "no transcript", asset: file },
        );
      }
    }
  }
  let current = timeline;
  const written = await runVoiceoverPlan(plan, async (step) => {
    const applied = await context.apply(current, step as OperationRequest);
    current = applied.timeline;
    return { revision: applied.timeline.revision, warnings: applied.warnings, added: applied.changes.added };
  });
  return { timeline: current, warnings: [...new Set([...plan.warnings, ...written.warnings])] };
}
