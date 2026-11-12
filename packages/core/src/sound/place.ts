// `sound.place` (ADR 0038): what to place and when (wishes) → the takes → whole frames → audio tracks → one batch of
// `track.add` and `clip.add`. Planning is separate from the transaction so the daemon opens it only once there is
// something to write; sounds whose cue could not be met are reported, never fatal.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ErrorCode, type OperationResult, RpcError, type SoundPlaceResult, type SoundSfxResult, type ValidatedParams } from "@frameshell/protocol";
import {
  SFX_SEED_MAX,
  SFX_VARIANTS,
  SOUND_DEFAULT_ROLES,
  SOUND_DEFAULT_TIERS,
  SOUND_KEY_GAP_MS,
  SOUND_MAX_PER_FRAME,
  SOUND_MAX_PLACEMENTS,
  SOUND_MIN_GAP_MS,
  SOUND_RISER_END_BEFORE_MS,
  SOUND_ROLE_OFFSETS,
  SOUND_TIER_OFFSETS_DB,
  type SfxKind,
  type SoundRole,
  type SoundTier,
  type Timeline,
  type Track,
  isShotClip,
} from "@frameshell/schema";
import { FrameGrid } from "../timeline/grid.js";
import { TimeRefError } from "../timeline/time-ref.js";
import { rngOf } from "./dsp.js";
import { SOUND_DIR, soundMarkOf } from "./takes.js";

/** Params of `sound.place`. */
export type PlaceParams = ValidatedParams<"sound.place">;

/** Name of the audio track the sounds go on; overflow lanes are `SFX 2`, `SFX 3`… */
export const SFX_TRACK_NAME = "SFX";

/** Which part of the call asked for a sound. */
type Source = "cue" | "cut" | "typing";

/** One sound to place: what it is and the picture event it belongs to, before its take exists. */
export interface SoundWish {
  from: Source;
  /** Timeline second of the picture event. */
  cue: number;
  kind: SfxKind;
  /** Role whose offset applies; null for a riser's own rule or an explicit `offset`. */
  role: SoundRole | null;
  /** Milliseconds from the cue to the take's anchor. */
  offsetMs: number;
  tier: SoundTier;
  variant: number | undefined;
  seed: number;
  pitch: number | undefined;
  length: number | undefined;
  /** Clip gain in dB when the caller set it. */
  gain: number | undefined;
}

/** A sound already on the timeline, or about to be, as the warnings see it. */
export interface SoundItem {
  kind: SfxKind;
  file: string;
  /** Timeline second of the take's anchor. */
  at: number;
  /** Placed by this call. */
  fresh: boolean;
}

/** What `planSounds` needs from the daemon. */
export interface PlanDeps {
  root: string;
  timeline: string;
  /** The timeline as the caller sees it, with its frame rate. */
  load(): Promise<{ timeline: Timeline; fps: number }>;
  /** Seconds a time reference names on `timeline`; throws `TimeRefError`. */
  resolve(ref: number | string, timeline: Timeline): number;
  /** Make (or reuse) a take; serialised with other sound work of the project by the caller. */
  take(spec: { kind: SfxKind; variant: number; seed: number; pitch?: number | undefined; length?: number | undefined }): Promise<SoundSfxResult>;
  /** dB the style puts sound effects under the voice. */
  sfxUnderVoice(): Promise<number>;
}

/** A sound with its take, frame and lane settled. */
export interface PlannedSound {
  wish: SoundWish;
  take: SoundSfxResult;
  lane: number;
  /** Timeline second the clip starts. */
  start: number;
  /** Source seconds cut off the head of the take. */
  headIn: number;
  anchorAt: number;
  gain: number;
}

/** An audio track the sounds go on. */
export interface PlannedLane {
  /** Existing track id; null = this call makes it. */
  id: string | null;
  name: string;
}

/** What the transaction will do; `runPlan` writes it. */
export interface SoundPlan {
  timeline: string;
  revision: number;
  /** Transaction label. */
  label: string;
  lanes: PlannedLane[];
  sounds: PlannedSound[];
  skipped: SoundPlaceResult["skipped"];
  generated: number;
  warnings: string[];
}

function invalid(field: string, message: string, extra: Record<string, unknown> = {}): RpcError {
  return new RpcError(ErrorCode.InvalidOperation, `sound.place: ${field}: ${message}`, { op: "sound.place", reason: message, field, ...extra });
}

/** Seconds `ref` names, with a time-reference failure turned into `InvalidOperation` that names the argument. */
function resolveAt(resolve: PlanDeps["resolve"], timeline: Timeline, ref: number | string, field: string): number {
  try {
    return resolve(ref, timeline);
  } catch (error) {
    if (!(error instanceof TimeRefError)) throw error;
    throw invalid(field, error.message, { value: ref, ...(error.hint ? { hint: error.hint } : {}) });
  }
}

type CueFields = {
  kind: SfxKind;
  role?: SoundRole | undefined;
  tier?: SoundTier | undefined;
  variant?: number | undefined;
  seed: number;
  pitch?: number | undefined;
  length?: number | undefined;
  offset?: number | undefined;
  gain?: number | undefined;
};

function wishOf(from: Source, cue: number, fields: CueFields, tier: SoundTier): SoundWish {
  const role = fields.role ?? SOUND_DEFAULT_ROLES[fields.kind];
  const explicit = fields.offset !== undefined;
  return {
    from,
    cue,
    kind: fields.kind,
    role: explicit || role === null ? null : role,
    offsetMs: explicit ? fields.offset! : role === null ? -SOUND_RISER_END_BEFORE_MS : SOUND_ROLE_OFFSETS[role],
    tier,
    variant: fields.variant,
    seed: fields.seed,
    pitch: fields.pitch,
    length: fields.length,
    gain: fields.gain,
  };
}

/** Edit points of `track`: the start of every clip after the first, in time order. */
function cutsOf(track: Track): number[] {
  if (track.kind === "subtitles") return [];
  return track.clips.map((clip) => clip.start).sort((a, b) => a - b).slice(1);
}

/**
 * The sounds a call asks for, in time order: `cues` as given, `cuts` at the edit points of a track, `typing` as keys
 * a seeded jitter apart. Throws `InvalidParams` for an empty call or too many sounds, `InvalidOperation` for an
 * unknown name, track or cut number.
 */
export function wishesOf(params: PlaceParams, timeline: Timeline, deps: Pick<PlanDeps, "resolve">): SoundWish[] {
  const { cues, cuts, typing } = params;
  if (!cues && !cuts && !typing) {
    throw new RpcError(ErrorCode.InvalidParams, "sound.place: give `cues`, `cuts` or `typing`: nothing to place.", {
      issues: [{ path: ["cues"], message: "nothing to place" }],
    });
  }
  const wishes: SoundWish[] = [];
  const at = (ref: number | string, field: string) => resolveAt(deps.resolve, timeline, ref, field);
  cues?.forEach((cue, i) => wishes.push(wishOf("cue", at(cue.at, `cues[${i}].at`), cue, cue.tier ?? SOUND_DEFAULT_TIERS[cue.kind])));
  if (cuts) {
    const track = timeline.tracks.find((candidate) => candidate.id === cuts.track);
    if (!track) throw invalid("cuts.track", `no track "${cuts.track}" in timeline ${timeline.id}.`, { available: timeline.tracks.map((candidate) => candidate.id) });
    if (track.kind === "subtitles") throw invalid("cuts.track", `${track.id} is a subtitle track; cuts are the edit points of a video, audio or program track.`);
    const points = cutsOf(track);
    for (const number of cuts.which ?? points.map((_, i) => i + 1)) {
      const point = points[number - 1];
      if (point === undefined) throw invalid("cuts.which", `track ${track.id} has ${points.length} cut${points.length === 1 ? "" : "s"}, not ${number}.`);
      wishes.push(wishOf("cut", point, cuts, cuts.tier ?? SOUND_DEFAULT_TIERS[cuts.kind]));
    }
  }
  if (typing) {
    const from = at(typing.from, "typing.from");
    const to = at(typing.to, "typing.to");
    if (to <= from) throw invalid("typing.to", `${to} s is not after typing.from (${from} s).`);
    const interval = 1 / typing.rate;
    // Per-interval jitter of ±10 %: at the top rate the gap stays above SOUND_KEY_GAP_MS.
    const rng = rngOf("typing", typing.seed, from, to, typing.rate);
    const room = SOUND_MAX_PLACEMENTS - (cues?.length ?? 0) - wishes.filter((wish) => wish.from === "cut").length;
    let t = from;
    for (let i = 0; t < to; i++) {
      if (i >= room) throw invalid("typing", `a run of more than ${room} keys: shorten it or lower \`rate\` (at most ${SOUND_MAX_PLACEMENTS} sounds per call).`);
      // Rotating takes: 3 variants times 2 seeds, so a key never repeats the one before it.
      const seed = (typing.seed + (Math.floor(i / SFX_VARIANTS) % 2)) % (SFX_SEED_MAX + 1);
      wishes.push(wishOf("typing", t, { ...typing, variant: (i % SFX_VARIANTS) + 1, seed }, typing.tier ?? "texture"));
      t += Math.max(interval * (1 + (rng() * 2 - 1) * 0.1), SOUND_KEY_GAP_MS / 1000);
    }
  }
  if (wishes.length > SOUND_MAX_PLACEMENTS) {
    throw new RpcError(ErrorCode.InvalidParams, `sound.place: ${wishes.length} sounds asked for; at most ${SOUND_MAX_PLACEMENTS} per call.`, {
      issues: [{ path: ["cues"], message: "too many sounds" }],
    });
  }
  return wishes.sort((a, b) => a.cue - b.cue);
}

/** Variants for the wishes that name none: each kind rotates along the timeline, starting after the sounds of that kind already there. */
function rotateVariants(wishes: SoundWish[], existing: SoundItem[]): void {
  const next = new Map<SfxKind, number>();
  for (const item of existing) next.set(item.kind, (next.get(item.kind) ?? 0) + 1);
  for (const wish of wishes) {
    if (wish.variant !== undefined) continue;
    const n = next.get(wish.kind) ?? 0;
    wish.variant = (n % SFX_VARIANTS) + 1;
    next.set(wish.kind, n + 1);
  }
}

/** Marks of the takes under `assets/sound/` read once each. */
async function markOfAsset(root: string, asset: string, cache: Map<string, ReturnType<typeof soundMarkOf>>) {
  if (!cache.has(asset)) {
    cache.set(asset, await readFile(join(root, ...asset.split("/"))).then(soundMarkOf, () => null));
  }
  return cache.get(asset)!;
}

/** Sounds already on audio tracks of `timeline`: clips of takes whose anchor still plays. */
export async function soundsOn(root: string, timeline: Timeline): Promise<SoundItem[]> {
  const cache = new Map<string, ReturnType<typeof soundMarkOf>>();
  const items: SoundItem[] = [];
  for (const track of timeline.tracks) {
    if (track.kind !== "audio") continue;
    for (const clip of track.clips) {
      if (!("asset" in clip) || !clip.asset.startsWith(`${SOUND_DIR}/`)) continue;
      const mark = await markOfAsset(root, clip.asset, cache);
      if (!mark || mark.peakAt < clip.in) continue;
      items.push({ kind: mark.kind, file: clip.asset, at: clip.start + (mark.peakAt - clip.in) / (clip.speed ?? 1), fresh: false });
    }
  }
  return items;
}

/** Frames `[start, end)` of the clips of `track`, for lane fitting; a clip of unknown length holds its first frame. */
function occupied(track: Track, grid: FrameGrid): [number, number][] {
  if (track.kind === "subtitles") return [];
  return track.clips.map((clip) => {
    const start = grid.frame(clip.start);
    let seconds = 0;
    if ("asset" in clip) seconds = (clip.out - clip.in) / (clip.speed ?? 1);
    else if (isShotClip(clip)) seconds = clip.out - clip.in;
    else if (clip.duration !== undefined) seconds = clip.duration;
    return [start, start + Math.max(1, grid.frame(seconds))];
  });
}

/** The warnings of taste (ADR 0038 decision 5): crowded frames, short gaps, a take twice in a row. Only those that involve a fresh sound. */
export function soundWarnings(items: SoundItem[], fps: number): string[] {
  const out: string[] = [];
  const sorted = [...items].sort((a, b) => a.at - b.at);
  const shown = (seconds: number) => `${seconds.toFixed(3)} s`;

  const byFrame = new Map<number, SoundItem[]>();
  for (const item of sorted) {
    const frame = Math.round(item.at * fps);
    byFrame.set(frame, [...(byFrame.get(frame) ?? []), item]);
  }
  for (const [frame, group] of byFrame) {
    if (group.length > SOUND_MAX_PER_FRAME && group.some((item) => item.fresh)) {
      out.push(`${group.length} sounds land on frame ${frame} (${shown(frame / fps)}): ${group.map((item) => item.kind).join(", ")}; at most ${SOUND_MAX_PER_FRAME} per frame. Move or remove one.`);
    }
  }

  for (const [kind, gap] of Object.entries(SOUND_MIN_GAP_MS) as [SfxKind, number][]) {
    const same = sorted.filter((item) => item.kind === kind);
    for (let i = 1; i < same.length; i++) {
      const [a, b] = [same[i - 1]!, same[i]!];
      const ms = (b.at - a.at) * 1000;
      if (ms < gap - 0.5 && (a.fresh || b.fresh)) out.push(`${kind} at ${shown(b.at)} is ${Math.round(ms)} ms after the one at ${shown(a.at)}; ${kind}s need ${gap} ms between them.`);
    }
  }

  for (let i = 1; i < sorted.length; i++) {
    const [a, b] = [sorted[i - 1]!, sorted[i]!];
    if (a.file === b.file && (a.fresh || b.fresh)) out.push(`${a.file} plays twice in a row (${shown(a.at)} and ${shown(b.at)}): vary \`variant\` or \`seed\`.`);
  }
  return out;
}

/** Warnings joined, with a long run of one kind cut short. */
function limited(warnings: string[], most = 6): string[] {
  return warnings.length <= most ? warnings : [...warnings.slice(0, most), `…and ${warnings.length - most} more like these.`];
}

function labelOf(wishes: SoundWish[]): string {
  const counts = new Map<SfxKind, number>();
  for (const wish of wishes) counts.set(wish.kind, (counts.get(wish.kind) ?? 0) + 1);
  return `Sound: ${[...counts].map(([kind, n]) => `${n} ${kind}`).join(", ")}`;
}

/**
 * Plan the call: resolve every time, make the takes, fit each sound on whole frames and on audio tracks, and collect
 * the warnings. Writes nothing to the timeline. Throws `StaleRevision` when the timeline changed while the takes
 * were made (the times were read from the older one).
 */
export async function planSounds(params: PlaceParams, deps: PlanDeps): Promise<SoundPlan> {
  const before = (await deps.load()).timeline;
  const wishes = wishesOf(params, before, deps);
  rotateVariants(wishes, await soundsOn(deps.root, before));

  const takes = new Map<string, SoundSfxResult>();
  let generated = 0;
  for (const wish of wishes) {
    const spec = { kind: wish.kind, variant: wish.variant!, seed: wish.seed, pitch: wish.pitch, length: wish.length };
    const id = JSON.stringify([spec.kind, spec.variant, spec.seed, spec.pitch ?? null, spec.length ?? null]);
    if (takes.has(id)) continue;
    const take = await deps.take(spec);
    if (take.state === "generated") generated += 1;
    takes.set(id, take);
  }

  const { timeline, fps } = await deps.load();
  if (timeline.revision !== before.revision) {
    throw new RpcError(ErrorCode.StaleRevision, `sound.place: timeline ${timeline.id} changed from revision ${before.revision} to ${timeline.revision} while the sounds were made. Nothing was placed; run it again.`, {
      op: "sound.place",
      timeline: timeline.id,
      revision: before.revision,
      current: timeline.revision,
    });
  }
  const grid = new FrameGrid(fps);
  const underVoice = await deps.sfxUnderVoice();

  // Lane 0 is the audio track named, else the one called SFX, else a new one; busier moments spill onto `SFX 2`, `SFX 3`….
  let main: Track | undefined;
  if (params.track !== undefined) {
    main = timeline.tracks.find((candidate) => candidate.id === params.track);
    if (!main) throw invalid("track", `no track "${params.track}" in timeline ${timeline.id}.`, { available: timeline.tracks.map((candidate) => candidate.id) });
    if (main.kind !== "audio") throw invalid("track", `${main.id} is a ${main.kind} track; sounds go on an audio track.`);
  } else {
    main = timeline.tracks.find((candidate) => candidate.kind === "audio" && candidate.name?.toLowerCase() === SFX_TRACK_NAME.toLowerCase());
  }
  const lanes: PlannedLane[] = [main ? { id: main.id, name: main.name ?? main.id } : { id: null, name: SFX_TRACK_NAME }];
  const busy: [number, number][][] = [main ? occupied(main, grid) : []];
  const laneAt = (index: number) => {
    while (lanes.length <= index) {
      const name = `${SFX_TRACK_NAME} ${lanes.length + 1}`;
      const found = timeline.tracks.find((candidate) => candidate.kind === "audio" && candidate.name?.toLowerCase() === name.toLowerCase() && candidate.id !== main?.id);
      lanes.push({ id: found?.id ?? null, name: found?.name ?? name });
      busy.push(found ? occupied(found, grid) : []);
    }
  };

  const sounds: PlannedSound[] = [];
  const skipped: SoundPlan["skipped"] = [];
  const warnings: string[] = [];
  for (const wish of wishes) {
    const take = takes.get(JSON.stringify([wish.kind, wish.variant, wish.seed, wish.pitch ?? null, wish.length ?? null]))!;
    // The engine keeps whole frames of a take (it cuts the source at the last frame boundary): a riser loses its last partial frame, a sound under one frame cannot be a clip.
    const whole = grid.frame(grid.floor(take.duration));
    if (whole < 1) {
      skipped.push({ cue: wish.cue, kind: wish.kind, reason: `${take.file} is ${Math.round(take.duration * 1000)} ms, shorter than one frame at ${fps} fps; it cannot be a clip.` });
      continue;
    }
    const anchor = Math.min(take.peakAt, whole / fps);
    let startFrame = grid.frame(wish.cue + wish.offsetMs / 1000 - anchor) || 0;
    let headFrames = 0;
    if (startFrame < 0) {
      headFrames = -startFrame;
      startFrame = 0;
    }
    if (headFrames >= whole) {
      skipped.push({ cue: wish.cue, kind: wish.kind, reason: `it would start ${Math.round((headFrames / fps) * 1000)} ms before the timeline does, and nothing of ${take.file} would be left to play.` });
      continue;
    }
    if (headFrames > 0) {
      warnings.push(`${wish.kind} at ${wish.cue.toFixed(3)} s starts before the timeline does: ${Math.round((headFrames / fps) * 1000)} ms of its head are cut off.`);
    }
    const kept = whole - headFrames;
    // One spare frame after a new clip: the engine measures the file itself, so a rounding difference must not make two clips touch.
    const end = startFrame + kept + 1;
    let lane = 0;
    for (;; lane++) {
      laneAt(lane);
      if (!busy[lane]!.some(([s, e]) => startFrame < e && s < end)) break;
    }
    busy[lane]!.push([startFrame, end]);
    const gain = wish.gain ?? Math.round((-underVoice + SOUND_TIER_OFFSETS_DB[wish.tier]) * 10) / 10;
    sounds.push({
      wish,
      take,
      lane,
      start: grid.seconds(startFrame),
      headIn: grid.seconds(headFrames),
      anchorAt: Math.round((startFrame / fps + anchor - headFrames / fps) * 1e6) / 1e6,
      gain,
    });
  }

  const fresh: SoundItem[] = sounds.map((sound) => ({ kind: sound.wish.kind, file: sound.take.file, at: sound.anchorAt, fresh: true }));
  const existing = await soundsOn(deps.root, timeline);
  warnings.push(...limited(soundWarnings([...existing, ...fresh], fps)));
  return {
    timeline: timeline.id,
    revision: timeline.revision,
    label: labelOf(sounds.map((sound) => sound.wish)),
    lanes: sounds.length > 0 ? lanes : [],
    sounds: sounds.sort((a, b) => a.start - b.start),
    skipped,
    generated,
    warnings,
  };
}

/** One operation of the transaction. */
export type PlaceStep = { op: "track.add"; args: { kind: "audio"; name: string } } | { op: "clip.add"; args: { track: string; type: "media"; asset: string; start: number; in?: number; gain: number } };

/** Result of one applied step. */
export type StepResult = Pick<OperationResult, "revision" | "warnings"> & { added: string[] };

/**
 * Write `plan` with `apply`, one step at a time: the tracks it needs first, then a clip per sound. Returns the parts
 * of the `sound.place` result that come from the writes.
 */
export async function runPlan(plan: SoundPlan, apply: (step: PlaceStep) => Promise<StepResult>): Promise<Pick<SoundPlaceResult, "revision" | "tracks" | "placed" | "warnings">> {
  const warnings: string[] = [];
  let revision = plan.revision;
  const ids: (string | undefined)[] = [];
  const tracks: SoundPlaceResult["tracks"] = [];
  const used = new Set(plan.sounds.map((sound) => sound.lane));
  for (const [index, lane] of plan.lanes.entries()) {
    // A lane some earlier call made and this one does not use is not listed.
    if (!used.has(index)) continue;
    let id: string | undefined = lane.id ?? undefined;
    if (id === undefined) {
      const done = await apply({ op: "track.add", args: { kind: "audio", name: lane.name } });
      revision = done.revision;
      warnings.push(...done.warnings);
      id = done.added[0];
      if (id === undefined) throw new Error("sound.place: track.add reported no new track");
    }
    ids[index] = id;
    tracks.push({ id, name: lane.name, created: lane.id === null });
  }
  const placed: SoundPlaceResult["placed"] = [];
  for (const sound of plan.sounds) {
    const track = ids[sound.lane]!;
    const done = await apply({
      op: "clip.add",
      args: { track, type: "media", asset: sound.take.file, start: sound.start, ...(sound.headIn > 0 ? { in: sound.headIn } : {}), gain: sound.gain },
    });
    revision = done.revision;
    warnings.push(...done.warnings);
    placed.push({
      clip: done.added[0] ?? "",
      track,
      file: sound.take.file,
      state: sound.take.state,
      kind: sound.wish.kind,
      role: sound.wish.role,
      tier: sound.wish.tier,
      from: sound.wish.from,
      cue: sound.wish.cue,
      offset: sound.wish.offsetMs,
      start: sound.start,
      in: sound.headIn,
      anchorAt: sound.anchorAt,
      gain: sound.gain,
    });
  }
  return { revision, tracks, placed, warnings };
}

/** The `warnings` of the result: taste warnings first, then the engine's, each once. */
export function allWarnings(plan: SoundPlan, written: string[]): string[] {
  return [...new Set([...plan.warnings, ...written])];
}
