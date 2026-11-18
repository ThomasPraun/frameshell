import { ErrorCode, RpcError } from "@frameshell/protocol";
import {
  type AnyClip,
  type BatchFile,
  type BatchRow,
  type MediaClip,
  PROTOTYPE_KEYS,
  type Timeline,
  VOICEOVER_SLOT,
  parseSlotTarget,
  voiceoverOf,
} from "@frameshell/schema";
import type { AppliedOperation, OperationRequest, SourceInfo } from "../timeline/engine.js";
import { FrameGrid } from "../timeline/grid.js";
import { placeRowVoiceover } from "./voiceover.js";

/** What {@link rowVariant} looks up in the project. */
export interface VariantContext {
  /** Project root; the paths of a row (assets, voiceover scripts) are relative to it. */
  root: string;
  fps: number;
  /** One operation applied in memory with the project's edit context; see `TimelineService.applyInMemory`. */
  apply(timeline: Timeline, request: OperationRequest): Promise<AppliedOperation>;
  /** Probe of a project-relative asset. Throws an `RpcError` when it is missing or not media. */
  source(asset: string): Promise<SourceInfo>;
  /** True when the asset has a transcript (`transcripts/<asset>.words.json`). */
  hasTranscript(asset: string): Promise<boolean>;
  /** Seconds a TimeRef names on `loaded` (every form the protocol `TimeRef` lists, `word:` included); throws a `TimeRefError`. */
  resolve(ref: number | string, loaded: { timeline: Timeline; fps: number }): Promise<number>;
  /** Seconds the timeline runs, or null when it cannot be told (a nested timeline that fails to load). */
  duration(timeline: Timeline): Promise<number | null>;
  /**
   * Top-level props the generated `clip`'s adapter declares, or null when it declares none (any prop goes). Absent:
   * no adapter declares anything. See `TimelineService.declaredProps`.
   */
  declaredProps?(clip: AnyClip): Promise<readonly string[] | null>;
}

/** A row's timeline and what it says about it. */
export interface RowVariant {
  timeline: Timeline;
  /** Worth knowing before the render, e.g. a voiceover that makes the video longer than the template. */
  warnings: string[];
}

/** InvalidOperation naming the row and slot (ADR 0040 decision 8). */
export function rowError(row: string, slot: string | null, message: string, data: Record<string, unknown> = {}): RpcError {
  const where = slot === null ? `Row ${row}` : `Row ${row}, slot ${slot}`;
  return new RpcError(ErrorCode.InvalidOperation, `${where}: ${message}`, { ...data, op: "batch.render", row, slot });
}

/**
 * The template with `row`'s slot values applied, in memory: props through the engine's `clip.set` (the adapter's
 * schema checks them), assets swapped by {@link assetSwapProblem}'s rules, a voiceover placed last by
 * {@link placeRowVoiceover}. Slots the row leaves out keep the template's value. Throws {@link rowError} for the
 * first slot that fails.
 */
export async function rowVariant(template: Timeline, file: Pick<BatchFile, "slots">, row: BatchRow, context: VariantContext): Promise<RowVariant> {
  let timeline = template;
  const warnings: string[] = [];
  for (const [slot, target] of Object.entries(file.slots)) {
    if (!Object.hasOwn(row, slot)) continue;
    const value = row[slot];
    const parsed = parseSlotTarget(target, slot)!;
    if (parsed.kind === "voiceover") continue;
    const found = findClip(timeline, parsed.clip);
    if (!found) {
      throw rowError(row.id, slot, `no clip ${parsed.clip} in timeline ${template.id}. Slots name clip ids of the template (\`frameshell timeline show\`).`, { reason: "clip not found" });
    }
    const { clip, track } = found;
    if (parsed.kind === "props") {
      if (clip.type === "media" || clip.type === "timeline" || clip.type === "shot") {
        throw rowError(row.id, slot, `${clip.id} is a ${clip.type} clip; only generated (adapter) clips take props.`, { reason: "not an adapter clip" });
      }
      const declared = (await context.declaredProps?.(clip)) ?? null;
      const prop = parsed.path[0]!;
      if (declared && !declared.includes(prop)) {
        throw rowError(row.id, slot, `${clip.id}'s composition declares the props ${declared.join(", ")}, not ${prop}. Fix the slot's path (\`${slot}\`: ${target}).`, {
          reason: "unknown prop",
          prop,
          declared: [...declared],
        });
      }
      const current = (clip as { props?: Record<string, unknown> }).props ?? {};
      let props: Record<string, unknown>;
      try {
        props = withValueAt(current, parsed.path, value);
      } catch (error) {
        throw rowError(row.id, slot, (error as Error).message, { reason: "props path" });
      }
      try {
        timeline = (await context.apply(timeline, { op: "clip.set", args: { clip: clip.id, props } })).timeline;
      } catch (error) {
        if (!(error instanceof RpcError)) throw error;
        throw rowError(row.id, slot, error.message, { ...(error.data as Record<string, unknown> | undefined), reason: "props refused" });
      }
      continue;
    }
    if (clip.type !== "media" || track.kind === "program") {
      throw rowError(row.id, slot, `${clip.id} is a ${clip.type} clip; only media clips take an asset.`, { reason: "not a media clip" });
    }
    const asset = value as string;
    let info: SourceInfo;
    try {
      info = await context.source(asset);
    } catch (error) {
      if (!(error instanceof RpcError)) throw error;
      throw rowError(row.id, slot, error.message, { reason: "asset unreadable", asset });
    }
    const problem = assetSwapProblem(clip as MediaClip, track.kind, asset, info, context.fps);
    if (problem) throw rowError(row.id, slot, problem.message, { reason: problem.reason, asset });
    const follower = timeline.tracks.find((candidate) => candidate.kind === "subtitles" && candidate.follows === track.id);
    if (follower && !(await context.hasTranscript(asset))) {
      throw rowError(
        row.id,
        slot,
        `subtitle track ${follower.id} follows track ${track.id}, but ${asset} has no transcript. Transcribe it first: \`frameshell transcribe ${asset}\`.`,
        { reason: "no transcript", asset },
      );
    }
    timeline = structuredClone(timeline);
    (findClip(timeline, clip.id)!.clip as MediaClip).asset = asset;
  }
  // After every other slot, so the voice meets the timeline the row ends up with (a swapped asset, new props).
  const voiceSlot = Object.entries(file.slots).find(([slot, target]) => target === VOICEOVER_SLOT && Object.hasOwn(row, slot))?.[0];
  if (voiceSlot !== undefined) {
    let placed: Awaited<ReturnType<typeof placeRowVoiceover>>;
    try {
      placed = await placeRowVoiceover(timeline, voiceoverOf(row[voiceSlot]), context);
    } catch (error) {
      if (!(error instanceof RpcError)) throw error;
      const data = (error.data ?? {}) as Record<string, unknown>;
      throw rowError(row.id, voiceSlot, error.message.replace(/^voiceover\.place: /, ""), { ...data, op: "batch.render", reason: data["reason"] ?? "voiceover refused" });
    }
    warnings.push(...placed.warnings.map((warning) => `Voiceover: ${warning}`));
    const before = await context.duration(timeline);
    const after = await context.duration(placed.timeline);
    if (before !== null && after !== null && after > before + 0.0005) {
      warnings.push(
        `The voiceover makes the video ${after} s long, ${Math.round((after - before) * 1000) / 1000} s longer than the template's ${before} s. ` +
          "A batch never retimes the picture: shorten the lines, or make the template as long as the longest language.",
      );
    }
    timeline = placed.timeline;
  }
  return { timeline, warnings };
}

/**
 * Why `asset` cannot replace the media of `clip` on a `kind` track, or null: the clip keeps its in, out and
 * placement (never retimed), so the file must have the stream the track plays and last at least to `out`,
 * with the slack the engine gives a requested out (a file that snaps one frame short of it still fits).
 */
export function assetSwapProblem(
  clip: MediaClip,
  kind: "video" | "audio",
  asset: string,
  info: SourceInfo,
  fps: number,
): { reason: string; message: string } | null {
  if (kind === "video" && !info.video) return { reason: "no video stream", message: `${asset} has no video stream; ${clip.id} is on a video track.` };
  if (kind === "audio" && !info.audio) return { reason: "no audio stream", message: `${asset} has no audio stream; ${clip.id} is on an audio track.` };
  if (info.duration === null) return null;
  const grid = new FrameGrid(fps);
  if (grid.frame(clip.out) <= grid.frame(grid.floor(info.duration)) || clip.out <= info.duration + 0.0005) return null;
  return {
    reason: "asset too short",
    message:
      `${asset} lasts ${info.duration} s, shorter than ${clip.id}'s out ${clip.out} s. A batch never retimes a clip: ` +
      "use a file at least that long, or trim the clip in the template.",
  };
}

/**
 * `target` with `value` at `path`, deep-copied: missing objects on the way are created, an array is indexed by a
 * whole-number key. Throws when the path runs through a value that is neither (a string, a number), or uses a key
 * of {@link PROTOTYPE_KEYS}. Only own properties are read and written, so no path reaches a prototype.
 */
export function withValueAt(target: Record<string, unknown>, path: readonly string[], value: unknown): Record<string, unknown> {
  const reserved = path.find((key) => PROTOTYPE_KEYS.has(key));
  if (reserved !== undefined) throw new Error(`props.${path.join(".")} uses ${reserved}, which a props path may not.`);
  const copy = structuredClone(target);
  let node: unknown = copy;
  for (const [index, key] of path.entries()) {
    const last = index === path.length - 1;
    const container = node as Record<string, unknown> | unknown[];
    if (Array.isArray(container) && !/^\d+$/.test(key)) {
      throw new Error(`props.${path.slice(0, index).join(".")} is a list; index it with a number, not ${key}.`);
    }
    const slot = Array.isArray(container) ? Number(key) : key;
    if (last || !Object.hasOwn(container, slot) || (container as Record<string | number, unknown>)[slot] == null) {
      Object.defineProperty(container, slot, { value: last ? value : {}, writable: true, enumerable: true, configurable: true });
    }
    if (!last) node = (container as Record<string | number, unknown>)[slot];
    if (!last && (typeof node !== "object" || node === null)) {
      throw new Error(`props.${path.slice(0, index + 1).join(".")} is ${JSON.stringify(node)}, not an object, so props.${path.join(".")} cannot be set.`);
    }
  }
  return copy;
}

/** The clip with id `id` and its track; null when the timeline has none. */
export function findClip(timeline: Timeline, id: string): { clip: AnyClip; track: { id: string; kind: "video" | "audio" | "program" } } | null {
  for (const track of timeline.tracks) {
    if (track.kind === "subtitles") continue;
    const clip = (track.clips as AnyClip[]).find((candidate) => candidate.id === id);
    if (clip) return { clip, track };
  }
  return null;
}
