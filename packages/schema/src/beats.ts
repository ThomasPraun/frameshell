import { z } from "zod";
import { SCHEMA_VERSION, type ParseResult, formatIssues } from "./common.js";

/** Canonical `$schema` URL for `beats/*.beats.json`. */
export const BEATS_SCHEMA_URL = `https://frameshell.dev/schema/v${SCHEMA_VERSION}/beats.json`;

/** `detector` of a grid that was written, not measured (generated music knows its own beats). */
export const EXACT_DETECTOR = "exact";

/** Confidence under which a measured grid is "LOW": offered with alternatives, never snapped to. */
export const LOW_BEAT_CONFIDENCE = 0.5;

/** A grid someone corrected by hand. Applied on top of the measured `beats` by {@link effectiveBeatGrid}. */
export const BeatsEditsSchema = z.strictObject({
  tempo: z
    .enum(["double", "half"])
    .optional()
    .describe("Calm music gets a double-time grid, fast music a half-time one: `double` adds a beat halfway between each pair, `half` keeps every other beat."),
  downbeat: z
    .int()
    .min(0)
    .optional()
    .describe("Index (from 0) among the effective beats of the first beat that starts a bar; bars repeat every `meter` beats from there."),
  offset: z.number().min(-0.5).max(0.5).optional().describe("Seconds added to every beat, to nudge a grid that sits early or late."),
});

/**
 * Zod model of the beat grid of one music asset (ADR 0029, SPEC §5.9):
 * `beats/<name>.beats.json`, written by `beats.measure` (or by a generator that knows its beats, with
 * `detector: "exact"`), corrected by hand in `edits`. Times are source-asset seconds.
 */
export const BeatsFileSchema = z
  .strictObject({
    $schema: z.string().optional(),
    schemaVersion: z.literal(SCHEMA_VERSION),
    /** Project-relative, `/`-separated. */
    asset: z.string().min(1),
    /** `sha256:<hex>` of the asset bytes; a mismatch means the grid is stale. */
    assetHash: z.string().regex(/^sha256:[0-9a-f]{64}$/, "must be `sha256:` + 64 lowercase hex digits"),
    /** `exact` (written, not measured) or the detector and its version, e.g. `onset-flux@1`. */
    detector: z.string().regex(/^(exact|[a-z][a-z0-9-]*@\d+)$/, "must be `exact` or look like `onset-flux@1`"),
    /** Sample rate of the audio that was analysed; under 44.1 kHz the grid is the less precise fallback. Absent for `exact`. */
    sampleRate: z.int().positive().optional(),
    /** Beats per minute of the measured `beats`, before `edits`. */
    bpm: z.number().positive(),
    /** Beats per bar. */
    meter: z.int().min(1).max(16).default(4),
    /** Index (from 0) among `beats` of the first beat that starts a bar. */
    downbeat: z.int().min(0).default(0),
    /** 0..1; under {@link LOW_BEAT_CONFIDENCE} the grid may be wrong (double time, a bar off) and `alternatives` lists others. */
    confidence: z.number().min(0).max(1),
    /** Largest gap between the straight grid and a hit it matched, in ms; absent for `exact`. */
    residualMs: z.number().min(0).optional(),
    /** Beat times in source seconds, strictly increasing, snapped to measured hits where one was within 8 ms. */
    beats: z.array(z.number().min(0)).min(2),
    /** Strong measured hits in source seconds (SFX cues land on the nearest within 40 ms), increasing. */
    onsets: z.array(z.number().min(0)).optional(),
    /** Other tempi worth trying when `confidence` is low; apply one with `edits.tempo`. */
    alternatives: z.array(z.strictObject({ tempo: z.enum(["double", "half"]), bpm: z.number().positive() })).optional(),
    edits: BeatsEditsSchema.default({}),
  })
  .superRefine((file, ctx) => {
    file.beats.forEach((time, index) => {
      if (index > 0 && time <= file.beats[index - 1]!) ctx.addIssue({ code: "custom", message: "beats must be strictly increasing", path: ["beats", index] });
    });
    file.onsets?.forEach((time, index) => {
      if (index > 0 && time < file.onsets![index - 1]!) ctx.addIssue({ code: "custom", message: "onsets must be increasing", path: ["onsets", index] });
    });
    if (file.downbeat >= file.meter) ctx.addIssue({ code: "custom", message: `downbeat ${file.downbeat} must be below meter ${file.meter}`, path: ["downbeat"] });
  });

/** Validated beat grid file. */
export type BeatsFile = z.infer<typeof BeatsFileSchema>;

/** Validate unknown input as a beats file. Never throws. */
export function parseBeatsFile(input: unknown): ParseResult<BeatsFile> {
  const result = BeatsFileSchema.safeParse(input);
  return result.success ? { ok: true, value: result.data } : { ok: false, error: formatIssues(result.error) };
}

/** True when the grid should not be trusted without a look: low confidence and no human `edits` vouching for it. */
export function isLowConfidence(file: Pick<BeatsFile, "confidence" | "edits">): boolean {
  return file.confidence < LOW_BEAT_CONFIDENCE && Object.keys(file.edits).length === 0;
}

/** A beat grid with `edits` applied. */
export interface BeatGrid {
  bpm: number;
  meter: number;
  /** Index among `beats` of the first beat that starts a bar. */
  downbeat: number;
  /** Source seconds, increasing. */
  beats: number[];
  /** The beats that start a bar, source seconds. */
  downbeats: number[];
}

/**
 * The grid to use: `file.beats` with the human `edits` applied (tempo, then offset, then downbeat), so
 * nothing downstream re-implements them. Half time keeps every other beat; double time adds the midpoint of
 * each pair (none after the last beat). A negative offset drops the beats that land before 0 and moves the
 * measured downbeat by that many, so bar starts stay on the same musical beats. Half time with an odd measured
 * `downbeat` puts the bar start on the kept beat before it (half a beat early): set `edits.downbeat` to fix.
 */
export function effectiveBeatGrid(file: Pick<BeatsFile, "bpm" | "meter" | "downbeat" | "beats" | "edits">): BeatGrid {
  const { edits } = file;
  let beats = file.beats;
  let bpm = file.bpm;
  let downbeat = file.downbeat;
  if (edits.tempo === "double") {
    beats = beats.flatMap((time, index) => (index < beats.length - 1 ? [time, (time + beats[index + 1]!) / 2] : [time]));
    bpm *= 2;
    downbeat *= 2;
  } else if (edits.tempo === "half") {
    beats = beats.filter((_, index) => index % 2 === 0);
    bpm /= 2;
    downbeat = Math.floor(downbeat / 2);
  }
  if (edits.offset) {
    const shifted = beats.map((time) => time + edits.offset!);
    const kept = shifted.filter((time) => time >= 0);
    const dropped = shifted.length - kept.length;
    beats = kept;
    downbeat = (((downbeat - dropped) % file.meter) + file.meter) % file.meter;
  }
  if (edits.downbeat !== undefined) downbeat = edits.downbeat;
  const round = (time: number) => Math.round(time * 10_000) / 10_000;
  beats = beats.map(round);
  const { meter } = file;
  const downbeats = beats.filter((_, index) => (((index - downbeat) % meter) + meter) % meter === 0);
  return { bpm, meter, downbeat, beats, downbeats };
}

/**
 * Frame of beat `index` of a nominal grid (no music yet, so a film can be blocked in beats): computed from
 * the index and rounded once. Adding a rounded step instead drifts 2 frames in 32 beats at 128 BPM and 30 fps.
 * `offset` is the grid's first beat in seconds.
 */
export function nominalBeatFrame(index: number, bpm: number, fps: number, offset = 0): number {
  return Math.round((fps * 60 * index) / bpm + offset * fps);
}
