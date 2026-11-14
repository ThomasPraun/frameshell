import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { ANALYSIS_DIR, ANALYSIS_MANIFEST, ANALYZE_RESULT_LABELS, type AnalyzeDiffResultShape, type AnalyzeEvent, type AnalyzeResultShape, type AnalyzeSheet, type AnalyzeShotLook, ErrorCode, RpcError } from "@frameshell/protocol";
import { effectiveBeatGrid, isLowConfidence } from "@frameshell/schema";
import { pool } from "../export/service.js";
import { probeMedia, runTool } from "../media/ffmpeg.js";
import { BEAT_DETECTOR, MAX_BEAT_AUDIO_S } from "../media/beats.js";
import { type BeatsStore, beatsFileOf } from "../media/beats-store.js";
import { wavData } from "../media/energy-store.js";
import { ENERGY_HOP_S, energyEnvelope } from "../media/energy.js";
import { alignedAudioFilter } from "../media/recipe.js";
import { readRawFrames } from "../media/raw-frames.js";
import { Frames, writeSheetImages } from "../review/images.js";
import { type Critical, type FramePick, contactPicks, frameRange, sheetLayout } from "../review/plan.js";
import { captureParallelism, fileSource } from "../review/source.js";
import { classifyCuts } from "./cuts.js";
import { curveOf } from "./curve.js";
import { type AnalyzeDiffHooks, type AnalyzeDiffRequest, runDiff } from "./diff.js";
import { elementEvents, flashes, hitEvents, holds, soundHits } from "./events.js";
import { inkOf } from "./ink.js";
import { measureSync } from "./lip-run.js";
import { measureLoudness } from "./loudness.js";
import { type Look, LookBuilder } from "./look.js";
import { PALETTE_SIZE, PaletteBuilder } from "./palette.js";
import { MAX_PICTURE_S, readPicture } from "./picture.js";
import { rhythmOf } from "./rhythm.js";
import { sceneScores } from "./scene.js";
import { DEFAULT_CUT_THRESHOLD, detectCuts, frameAt, frameStart, shotLocator, shotMiddle, shotStats, shotsOf } from "./shots.js";

// `analyze` (#471): shot table, contact sheet, palette, look, rhythm, events, curve, ink, mouth sync, loudness and tempo of a reference video, on the managed ffmpeg.
// Frame sampling and sheet tiling are `review`'s (`review/plan.ts`, `review/images.ts`); the beat detector is `media/beats.ts`.

/** Most tiles of the contact sheet in all images: a longer film is sampled more coarsely than 2 per second. */
export const MAX_ANALYZE_CONTACT_TILES = 360;
/** Frames per second the palette is sampled at. */
const PALETTE_HZ = 4;
/** Width the palette samples are scaled to, px. */
const PALETTE_WIDTH = 64;
/** Longest side of the JPEG kept for each shot, px. */
const SHOT_IMAGE_SIDE = 640;
/** Sample rate the sound is decoded at for the beat detector: full rate, so its confidence is not capped. */
const BEAT_SAMPLE_RATE = 44_100;
/** Most events of one kind the result lists: a busier film is cut short, with a warning. */
const MAX_EVENTS_PER_KIND = 300;

/** Options for {@link AnalyzeService}. */
export interface AnalyzeServiceOptions {
  /** Absolute ffmpeg and ffprobe for the project rooted at `root`. */
  ffmpeg(root: string): Promise<string>;
  ffprobe(root: string): Promise<string>;
  beats: Pick<BeatsStore, "measureAudio">;
}

/** What one `analyze` run is asked for; see the `analyze` method. */
export interface AnalyzeRequest {
  /** Absolute path of the video. */
  file: string;
  /** Name of the analysis folder; default the file's name. */
  name?: string | undefined;
  /** Scene score that opens a shot; default {@link DEFAULT_CUT_THRESHOLD}. */
  threshold?: number | undefined;
}

/** What a run reports while it works. */
export interface AnalyzeHooks {
  signal?: AbortSignal | undefined;
  /** A line saying what the run is doing now. */
  stage?: ((message: string) => void) | undefined;
  /** Overall fraction done, 0 to 1. */
  progress?: ((fraction: number) => void) | undefined;
}

/** Name of the analysis folder for `file` when the caller gives none: its name without extension, in characters a folder name keeps. */
export function analysisName(file: string): string {
  const slug = basename(file, extname(file)).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "").slice(0, 64);
  return slug === "" ? "video" : slug;
}

/** Name of the comparison folder when the caller gives none: `<film>-vs-<reference>`, cut to 64 characters. */
export function diffName(film: string, reference: string): string {
  return `${analysisName(film)}-vs-${analysisName(reference)}`.slice(0, 64).replace(/[-._]+$/, "");
}

/** The sound of a video decoded for the detectors. */
interface Sound {
  rate: number;
  channels: number;
  /** 16-bit little-endian PCM. */
  data: Uint8Array;
}

/** Tempo as `analyze` reports it, with the beat lists that go to the file only. */
type TempoWithBeats = NonNullable<AnalyzeResultShape["tempo"]> & { beats: number[]; downbeats: number[] };

/**
 * `analyze` (#471): what a reference video does, in numbers an agent can copy the grammar of: where it cuts, what
 * colours it uses, how loud it is and what tempo it keeps. Never touches project files; writes `.frameshell/analysis/<name>/`.
 */
export class AnalyzeService {
  readonly #options: AnalyzeServiceOptions;

  constructor(options: AnalyzeServiceOptions) {
    this.#options = options;
  }

  /** Analyse `request.file` for the project at `root`; see the `analyze` method. */
  async run(root: string, request: AnalyzeRequest, hooks: AnalyzeHooks = {}): Promise<AnalyzeResultShape> {
    const { signal } = hooks;
    const stage = (message: string, from: number) => {
      hooks.stage?.(message);
      hooks.progress?.(from);
    };
    const name = request.name ?? analysisName(request.file);
    const threshold = request.threshold ?? DEFAULT_CUT_THRESHOLD;
    const ffmpeg = await this.#options.ffmpeg(root);
    const source = await fileSource(ffmpeg, await this.#options.ffprobe(root), request.file, "analyze");
    const { fps, frames, width, height } = source;
    if (frames < 1) throw new RpcError(ErrorCode.InvalidOperation, `analyze: ${request.file} is shorter than one frame.`, { op: "analyze", field: "file" });
    const probe = await probeMedia(await this.#options.ffprobe(root), request.file, signal);
    const warnings: string[] = [];

    stage(`Finding the shots of ${basename(request.file)}`, 0);
    const cuts = detectCuts(await sceneScores(ffmpeg, request.file, fps, signal), threshold);
    const shots = shotsOf(cuts, frames);

    stage("Reading the colours", 0.15);
    const palettes = await samplePalettes(ffmpeg, request.file, { width, height, fps }, shots, signal);

    stage("Looking at every frame", 0.25);
    const looks = shots.map(() => new LookBuilder());
    const overallLook = new LookBuilder();
    const { series, truncated } = await readPicture({
      ffmpeg,
      file: request.file,
      film: { width, height, fps, frames },
      shotAt: shotLocator(shots),
      looks,
      overall: overallLook,
      signal,
      progress: (fraction) => hooks.progress?.(0.25 + 0.2 * fraction),
    });
    if (series.frames < 1) throw new RpcError(ErrorCode.InvalidOperation, `analyze: ffmpeg decoded no picture from ${request.file}.`, { op: "analyze", field: "file" });
    if (truncated) warnings.push(`look, rhythm and events: measured on the first ${MAX_PICTURE_S / 60} minutes of the film.`);
    const cutFrames = cuts.map((cut) => cut.frame);
    const { rhythm, changes } = rhythmOf(series.activity, fps, shots.map((shot) => shot.endFrame - shot.startFrame), cutFrames);
    stage("Telling the cuts apart", 0.45);
    const cutKinds = await classifyCuts(
      { ffmpeg, file: request.file, film: { width, height, fps }, changes, shotFrames: cutFrames, signal, progress: (fraction) => hooks.progress?.(0.45 + 0.05 * fraction) },
      series.frames,
      warnings,
    );
    const events: AnalyzeEvent[] = [...flashes(series.brightness, fps), ...holds(series.activity, fps), ...elementEvents(series, cutFrames, fps)];
    const { curve, truncated: movesCut } = curveOf(series.activity, fps, changes.map((change) => change.frame));
    if (movesCut) warnings.push("curve: more than 200 moves found, the first 200 are listed.");
    const ink = inkOf(series, shots, fps);

    let loudness: AnalyzeResultShape["loudness"] = null;
    let tempo: TempoWithBeats | null = null;
    let voiceDb: Float32Array | null = null;
    if (probe.audio) {
      stage("Measuring the loudness", 0.5);
      loudness = await measureLoudness(ffmpeg, request.file, signal);
      if (loudness === null) warnings.push("loudness: ffmpeg reported no reading for the sound.");
      stage("Measuring the tempo and the hits of the sound", 0.55);
      const soundScratch = join(root, ".frameshell", "cache", "analyze", randomBytes(6).toString("hex"));
      try {
        const sound = await decodeSound(ffmpeg, request.file, soundScratch, warnings, signal);
        voiceDb = energyEnvelope(pcm16(sound.data), sound.rate);
        events.push(...hitEvents(soundHits(voiceDb, ENERGY_HOP_S), changes.map((change) => change.frame), fps, series.frames));
        tempo = await this.#tempo(root, request.file, sound, warnings, signal, (fraction) => hooks.progress?.(0.55 + 0.1 * fraction));
      } finally {
        await rm(soundScratch, { recursive: true, force: true });
      }
    } else warnings.push("audio: the video has no sound, so there is no loudness, tempo or hits.");
    stage("Looking for a talking face", 0.6);
    const sync = await measureSync(root, ffmpeg, request.file, { fps, frames, width, height }, voiceDb, signal);
    events.sort((a, b) => a.startFrame - b.startFrame || a.endFrame - b.endFrame);
    const listed = capEvents(events, warnings);

    stage("Writing the sheets", 0.65);
    const dir = join(root, ...ANALYSIS_DIR.split("/"), name);
    await rm(dir, { recursive: true, force: true });
    await mkdir(join(dir, "frames"), { recursive: true });
    const scratch = join(root, ".frameshell", "cache", "analyze", randomBytes(6).toString("hex"));
    await mkdir(scratch, { recursive: true });
    let sheets: AnalyzeSheet[];
    let images: string[];
    try {
      const made = await this.#sheets({ ffmpeg, source, shots, cuts: cuts.map((cut) => cut.frame), dir, scratch, signal, progress: (fraction) => hooks.progress?.(0.65 + 0.35 * fraction) });
      sheets = made.sheets;
      images = made.images;
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }

    const unmeasured = looks.filter((builder) => builder.frames === 0).length;
    if (unmeasured > 0) warnings.push(`look: ${unmeasured} shot${unmeasured === 1 ? "" : "s"} had no frame read (past the end of the picture pass) and carry the look of the nearest earlier shot, not their own.`);
    const lookOf = (builder: LookBuilder, shot: number) => builder.look() ?? fallbackLook(looks, shot, overallLook);
    const wholeLook = overallLook.look()!; // The picture pass read at least one frame.
    const result: AnalyzeResultShape = {
      file: request.file,
      name,
      dir,
      fps,
      width,
      height,
      frames,
      duration: frameStart(frames, fps),
      threshold,
      shots: shots.map((shot, i) => ({
        index: shot.index,
        startFrame: shot.startFrame,
        endFrame: shot.endFrame,
        start: frameStart(shot.startFrame, fps),
        end: frameStart(shot.endFrame, fps),
        length: frameStart(shot.endFrame - shot.startFrame, fps),
        cutScore: shot.cutScore === null ? null : Math.round(shot.cutScore * 1000) / 1000,
        image: images[i]!,
        palette: palettes.shots[i]!,
        look: shotLook(lookOf(looks[i]!, i)),
        ink: ink.shots[i]!,
      })),
      stats: shotStats(shots, fps),
      palette: palettes.overall,
      look: wholeLook,
      rhythm,
      cuts: cutKinds,
      events: listed,
      curve,
      ink: ink.film,
      sync,
      loudness,
      tempo: tempo ? withoutBeats(tempo) : null,
      sheets,
      warnings,
      labels: { ...ANALYZE_RESULT_LABELS },
    };
    const manifest = { ...result, shots: result.shots.map((shot, i) => ({ ...shot, look: lookOf(looks[i]!, i) })), tempo: tempo ?? null };
    await writeFile(join(dir, ANALYSIS_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    hooks.progress?.(1);
    return result;
  }

  /**
   * Compare our film with a reference (`analyze.diff`): lined up by activity, then SSIM, energy and a side-by-side sheet, into
   * `.frameshell/analysis/<name>/`. Never touches project files.
   */
  async diff(root: string, request: Omit<AnalyzeDiffRequest, "name"> & { name?: string | undefined }, hooks: AnalyzeDiffHooks = {}): Promise<AnalyzeDiffResultShape> {
    const name = request.name ?? diffName(request.file, request.reference);
    return runDiff({ root, ffmpeg: await this.#options.ffmpeg(root), ffprobe: await this.#options.ffprobe(root) }, { ...request, name }, hooks);
  }

  /** The tempo of `sound`, or null with a warning when it holds no steady beat. */
  async #tempo(root: string, file: string, sound: Sound, warnings: string[], signal: AbortSignal | undefined, progress: (fraction: number) => void): Promise<TempoWithBeats | null> {
    const { rate, channels, data } = sound;
    const hash = `sha256:${createHash("sha256").update(data).digest("hex")}`;
    try {
      const measured = await this.#options.beats.measureAudio(root, basename(file), hash, { pcm: data, channels, rate }, { signal, onProgress: progress });
      const file0 = beatsFileOf({ asset: basename(file), measured, previous: null, keepEdits: false });
      const grid = effectiveBeatGrid(file0);
      return {
        bpm: Math.round(grid.bpm * 100) / 100,
        meter: file0.meter,
        confidence: file0.confidence,
        low: isLowConfidence(file0),
        residualMs: file0.residualMs ?? 0,
        beatCount: grid.beats.length,
        downbeatCount: grid.downbeats.length,
        alternatives: file0.alternatives ?? [],
        detector: BEAT_DETECTOR,
        beats: grid.beats,
        downbeats: grid.downbeats,
      };
    } catch (error) {
      // No steady beat is an answer about the sound; any other failure is the run's.
      if (error instanceof RpcError && error.code === ErrorCode.InvalidOperation && (error.data as { reason?: string } | undefined)?.reason === "no beats") {
        warnings.push(`tempo: ${error.message.replace(/^No beats in [^:]*: /, "")}`);
        return null;
      }
      throw error;
    }
  }

  /** The contact sheet, the shots sheet and the JPEG of each shot; paths of the JPEGs in shot order. */
  async #sheets(options: {
    ffmpeg: string;
    source: Awaited<ReturnType<typeof fileSource>>;
    shots: ReturnType<typeof shotsOf>;
    cuts: number[];
    dir: string;
    scratch: string;
    signal: AbortSignal | undefined;
    progress: (fraction: number) => void;
  }): Promise<{ sheets: AnalyzeSheet[]; images: string[] }> {
    const { ffmpeg, source, shots, dir, scratch, signal } = options;
    const { fps, width, height } = source;
    const aspect = width / height;
    const frames = new Frames(source, join(scratch, "frames"));
    const layout = sheetLayout("contact", aspect);
    const sheets: AnalyzeSheet[] = [];
    const range = frameRange(source.frames, fps)!; // The caller checked for a frame.

    // A frame every half second, plus the first frame of every shot; a mid-frame second makes `frameIndex` land on it.
    const critical: Critical[] = options.cuts.map((frame) => ({ at: (frame + 0.5) / fps, tag: "cut" }));
    const contact = contactPicks(fps, range, critical, undefined, MAX_ANALYZE_CONTACT_TILES);
    sheets.push(...(await writeSheetImages({ ffmpeg, fps, aspect, frames, layout, picks: contact, dir, stem: "contact", scratch, signal })).map((image) => ({ kind: "contact" as const, ...image })));
    options.progress(0.5);

    const middles: FramePick[] = shots.map((shot, i) => ({ frame: shotMiddle(shot), tag: i === 0 ? "start" : "cut" }));
    const byFrame = new Map(shots.map((shot) => [shotMiddle(shot), shot] as const));
    const label = (pick: FramePick) => {
      const shot = byFrame.get(pick.frame)!;
      return `#${shot.index} ${frameStart(shot.startFrame, fps).toFixed(2)}`;
    };
    sheets.push(...(await writeSheetImages({ ffmpeg, fps, aspect, frames, layout, picks: middles, dir, stem: "shots", scratch, signal, label })).map((image) => ({ kind: "shots" as const, ...image })));
    options.progress(0.8);

    const scale = Math.min(1, SHOT_IMAGE_SIDE / Math.max(width, height));
    const size = `${2 * Math.round((width * scale) / 2)}:${2 * Math.round((height * scale) / 2)}`;
    const digits = Math.max(3, String(shots.length).length);
    const images = shots.map((shot) => join(dir, "frames", `shot-${String(shot.index).padStart(digits, "0")}.jpg`));
    await pool(shots, captureParallelism(), async (shot, i) => {
      signal?.throwIfAborted();
      await runTool(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", frames.path(shotMiddle(shot)), "-vf", `scale=${size}:flags=area`, "-frames:v", "1", "-q:v", "4", images[i]!], signal ? { signal } : {});
    });
    return { sheets, images };
  }
}

/** The first minutes of the sound of `file` as mono PCM at {@link BEAT_SAMPLE_RATE}; `scratch` is a folder the WAV goes in (the caller removes it). */
async function decodeSound(ffmpeg: string, file: string, scratch: string, warnings: string[], signal: AbortSignal | undefined): Promise<Sound> {
  await mkdir(scratch, { recursive: true });
  const wav = join(scratch, "sound.wav");
  // The cap keeps the detector within what it takes (a beat grid is for music, not for a lecture).
  await runTool(
    ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", file, "-map", "0:a:0", "-vn", "-t", String(MAX_BEAT_AUDIO_S), "-af", alignedAudioFilter(BEAT_SAMPLE_RATE), "-ac", "1", "-c:a", "pcm_s16le", wav],
    signal ? { signal } : {},
  );
  const sound = wavData(await readFile(wav));
  if (sound.data.byteLength / (2 * sound.channels * sound.rate) >= MAX_BEAT_AUDIO_S - 1) warnings.push(`tempo and hits: measured on the first ${MAX_BEAT_AUDIO_S / 60} minutes of the sound.`);
  return sound;
}

/** Samples of 16-bit little-endian PCM bytes (a copy: the bytes may not sit on an even offset). */
function pcm16(data: Uint8Array): Int16Array {
  const copy = data.slice(0, data.byteLength - (data.byteLength % 2));
  return new Int16Array(copy.buffer, copy.byteOffset, copy.byteLength / 2);
}

/** `events` with no more than {@link MAX_EVENTS_PER_KIND} of any kind (the first ones); a warning says which were cut. */
function capEvents(events: AnalyzeEvent[], warnings: string[]): AnalyzeEvent[] {
  const seen = new Map<string, number>();
  const cut = new Set<string>();
  const kept = events.filter((event) => {
    const count = (seen.get(event.kind) ?? 0) + 1;
    seen.set(event.kind, count);
    if (count > MAX_EVENTS_PER_KIND) cut.add(event.kind);
    return count <= MAX_EVENTS_PER_KIND;
  });
  for (const kind of cut) warnings.push(`events: ${seen.get(kind)} "${kind}" events found, the first ${MAX_EVENTS_PER_KIND} are listed.`);
  return kept;
}

/** The look of shot `index` when it had no frame to read (a film that ends early): the nearest earlier shot that has one, else the whole film's. */
function fallbackLook(looks: readonly LookBuilder[], index: number, overall: LookBuilder): Look {
  for (let i = index - 1; i >= 0; i--) {
    const found = looks[i]!.look();
    if (found) return found;
  }
  return overall.look()!;
}

/** The four figures of a look, without its grid. */
function shotLook({ brightness, contrast, saturation, warmth }: Look): AnalyzeShotLook {
  return { brightness, contrast, saturation, warmth };
}

function withoutBeats({ beats: _beats, downbeats: _downbeats, ...tempo }: TempoWithBeats): NonNullable<AnalyzeResultShape["tempo"]> {
  return tempo;
}

/** Dominant colours of each shot and of the whole film, from frames sampled {@link PALETTE_HZ} times a second. */
async function samplePalettes(
  ffmpeg: string,
  file: string,
  film: { width: number; height: number; fps: number },
  shots: ReturnType<typeof shotsOf>,
  signal: AbortSignal | undefined,
): Promise<{ shots: ReturnType<PaletteBuilder["colors"]>[]; overall: ReturnType<PaletteBuilder["colors"]> }> {
  const w = PALETTE_WIDTH;
  const h = Math.max(2, Math.round((PALETTE_WIDTH * film.height) / film.width));
  const builders = shots.map(() => new PaletteBuilder());
  const overall = new PaletteBuilder();
  const owner: number[] = [];
  const shotAt = shotLocator(shots);
  const last = shots.at(-1)!.endFrame - 1;
  for await (const rgb of readRawFrames(ffmpeg, file, `fps=${PALETTE_HZ},scale=${w}:${h}:flags=area,format=rgb24`, w * h * 3)) {
    signal?.throwIfAborted();
    const shot = shotAt(Math.min(last, frameAt(owner.length / PALETTE_HZ, film.fps)));
    owner.push(shot);
    builders[shot]!.add(rgb);
    overall.add(rgb);
  }
  const colors = builders.map((builder) => builder.colors(PALETTE_SIZE));
  // A shot shorter than a sample gets the colours of the shot the nearest sample belongs to.
  for (const [i, shot] of shots.entries()) {
    if (builders[i]!.pixels > 0 || owner.length === 0) continue;
    const middle = (frameStart(shot.startFrame, film.fps) + frameStart(shot.endFrame, film.fps)) / 2;
    const nearest = Math.min(owner.length - 1, Math.max(0, Math.round(middle * PALETTE_HZ)));
    colors[i] = colors[owner[nearest]!]!;
  }
  return { shots: colors, overall: overall.colors(PALETTE_SIZE) };
}
