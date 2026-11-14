import type { ReviewFinding, ReviewSound, SoundRole } from "@frameshell/protocol";
import { type Clip, type SfxKind, type Timeline, clipTime, edgeTransitions, fadeWeight, gainAt, isSubjectClip, soundCurve, withProgramSound } from "@frameshell/schema";
import { ENERGY_HOP_S, type EnergyProfile } from "../media/energy.js";
import { MUSIC_TRACK_NAME } from "../sound/music-place.js";
import { SFX_TRACK_NAME } from "../sound/place.js";
import { SOUND_DIR } from "../sound/takes.js";
import { VOICE_TRACK_NAME } from "../voiceover/place.js";
import {
  CHOP_DB,
  CHOP_LISTED,
  CLICK_BURST_S,
  CLICK_CONTEXT_S,
  CLICK_FLOOR_DBFS,
  CLICK_LISTED,
  CLICK_RATIO,
  CLICK_SHARE,
  ENDING_DBFS,
  ENDING_TAIL_S,
  LOUDEST_BEFORE,
  LOUDEST_MARGIN_DB,
  LOUDEST_WINDOW_S,
  MACHINE_GUN_PLAYS,
  SFX_REPEAT_EXEMPT,
  SFX_REPEAT_MAX,
  SOUND_LISTED,
  VOICE_LISTED,
  VOICE_OVER_BED_DB,
  VOICE_WINDOW_S,
} from "./thresholds.js";

// The sound review list of `review` (#457). Pure: clips and envelopes in, `metrics.sound` out. A timeline is never mixed:
// each clip is heard from its asset's 10 ms envelope (`EnergyStore`) with its gain and fades, and the clips are summed in
// power by role (voice, music, effects, the rest). A file is its decoded mix, so only the ending and clicks can be told there.

/** Music takes of `sound.music` are `<SOUND_DIR>/music-<preset>-<key>.wav` (`musicFile` in `sound/takes.ts`). */
const MUSIC_TAKE_PREFIX = `${SOUND_DIR}/music-`;

/** Level (dBFS) of no sound at all: the envelope's floor. */
const SILENCE_DB = -120;

const round = (value: number, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;
const toPower = (db: number) => 10 ** (db / 10);
const toDb = (power: number) => (power > 0 ? Math.max(SILENCE_DB, 10 * Math.log10(power)) : SILENCE_DB);

/** A media clip whose sound plays, laid on the timeline clock. */
export interface HeardClip {
  id: string;
  track: string;
  asset: string;
  role: SoundRole;
  /** Generated effect kind of the take it plays (`sound.place`); null for other sound. */
  kind: SfxKind | null;
  /** Timeline seconds it plays. */
  start: number;
  end: number;
  /** The clip, for its gain keys and clock. */
  clip: Clip;
  /** Seconds of its edge fades (`fadeIn`/`fadeOut`, a dip's halves). */
  fadeIn: number;
  fadeOut: number;
  /** Seconds of its sample-accurate fades (`audio.fadeInMs`/`fadeOutMs`). */
  rampIn: number;
  rampOut: number;
  /** The next clip of its track picks its sound up at its end: the same asset from where it stops, or a dissolve. Its end is no cut-off. */
  continued: boolean;
}

/** What {@link heardClips} needs to sort clips by role. */
export interface RoleHints {
  /** Assets with a transcript: their sound is a voice. */
  transcribed: ReadonlySet<string>;
  /** Effect kind of generated takes by asset path. */
  kinds: ReadonlyMap<string, SfxKind>;
}

/**
 * The clips of `timeline` whose sound plays, with their role. Voice: a `Voiceover` track, a track a duck names in
 * `under`, or an asset with a transcript. Music: a `Music` track, a music take, or a ducked clip. Effects: a generated
 * take or an `SFX` track. Other: the rest of the audio tracks. Footage on video tracks counts only as a voice: a still
 * has no sound and b-roll sound is not told from it.
 */
export function heardClips(timeline: Timeline, fps: number, hints: RoleHints): HeardClip[] {
  const listened = withProgramSound(timeline);
  const voiceTracks = new Set<string>();
  for (const track of timeline.tracks) {
    if (track.kind !== "video" && track.kind !== "audio") continue;
    if (track.name === VOICE_TRACK_NAME) voiceTracks.add(track.id);
    for (const clip of track.clips) for (const id of clip.audio?.duck?.under ?? []) voiceTracks.add(id);
  }
  const heard: HeardClip[] = [];
  for (const track of listened.tracks) {
    if (track.kind !== "video" && track.kind !== "audio") continue;
    // A program track's sound comes back as `<program track>/<sound>`.
    const voiceTrack = voiceTracks.has(track.id) || voiceTracks.has(track.id.split("/")[0]!);
    const sorted = [...track.clips].sort((a, b) => a.start - b.start);
    const edges = edgeTransitions(sorted, { fps });
    sorted.forEach((clip, i) => {
      if (!("asset" in clip) || clip.audio?.muted === true || isSubjectClip(clip)) return;
      const music = track.name === MUSIC_TRACK_NAME || clip.asset.startsWith(MUSIC_TAKE_PREFIX) || clip.audio?.duck !== undefined;
      const kind = hints.kinds.get(clip.asset) ?? null;
      let role: SoundRole;
      if (voiceTrack || hints.transcribed.has(clip.asset)) role = "voice";
      else if (track.kind === "video") return;
      else if (music) role = "music";
      else if (kind !== null || track.name === SFX_TRACK_NAME) role = "sfx";
      else role = "other";
      const speed = clip.speed ?? 1;
      const end = clip.start + (clip.out - clip.in) / speed;
      const next = sorted[i + 1];
      const butted = next !== undefined && Math.abs(next.start - end) <= 0.001;
      const picksUp = butted && "asset" in next && next.asset === clip.asset && Math.abs(next.in - clip.out) <= 0.001;
      const edge = edges.get(clip.id)!;
      heard.push({
        id: clip.id,
        track: track.id,
        asset: clip.asset,
        role,
        kind,
        start: clip.start,
        end,
        clip,
        fadeIn: edge.fadeIn,
        fadeOut: edge.fadeOut,
        rampIn: (clip.audio?.fadeInMs ?? 0) / 1000,
        rampOut: (clip.audio?.fadeOutMs ?? 0) / 1000,
        continued: picksUp || (butted && (edges.get(next.id)?.dissolve ?? 0) > 0),
      });
    });
  }
  return heard;
}

/** Level in dBFS of `clip` at timeline second `t` as heard: its asset's envelope plus its gain, through its fades; null when it is silent there. */
export function levelAt(clip: HeardClip, profile: EnergyProfile, t: number): number | null {
  const source = sourceLevel(clip, profile, t);
  if (source === null) return null;
  let weight = fadeWeight({ fadeIn: clip.fadeIn, fadeOut: clip.fadeOut }, clip.start, clip.end, t, true);
  if (clip.rampIn > 0) weight *= soundCurve((t - clip.start) / clip.rampIn);
  if (clip.rampOut > 0) weight *= soundCurve((clip.end - t) / clip.rampOut);
  if (weight <= 0) return null;
  return source + gainAt(clip.clip, t) + 20 * Math.log10(weight);
}

/** Level in dBFS of the asset `clip` plays at timeline second `t`, before gain and fades; null outside the clip or its material. */
function sourceLevel(clip: HeardClip, profile: EnergyProfile, t: number): number | null {
  if (t < clip.start || t >= clip.end) return null;
  const index = Math.floor(clipTime(clip.clip, t) / ENERGY_HOP_S + 1e-9);
  return index < 0 || index >= profile.db.length ? null : profile.db[index]!;
}

/** What {@link timelineSound} reads. */
export interface TimelineSoundInput {
  clips: readonly HeardClip[];
  /** Envelope of each asset of `clips`; an asset missing here is not heard. */
  profiles: ReadonlyMap<string, EnergyProfile>;
  /** Seconds reviewed. */
  range: { from: number; to: number };
  /** Seconds the film lasts: the ending is measured only when the range reaches it. */
  filmEnd: number;
}

/** Sum in power of the clips of each role, one value per {@link ENERGY_HOP_S} of the range, from `from`. */
interface RoleSeries {
  power: Record<SoundRole, Float64Array>;
  /** The hop holds a clip of the role (a quiet one too). */
  present: Record<SoundRole, Uint8Array>;
  /** The voice speaks at the hop: a voice clip is above its asset's quiet level. */
  speaking: Uint8Array;
}

function roleSeries(input: TimelineSoundInput, hops: number): RoleSeries {
  const roles = ["voice", "music", "sfx", "other"] as const;
  const power = Object.fromEntries(roles.map((role) => [role, new Float64Array(hops)])) as Record<SoundRole, Float64Array>;
  const present = Object.fromEntries(roles.map((role) => [role, new Uint8Array(hops)])) as Record<SoundRole, Uint8Array>;
  const speaking = new Uint8Array(hops);
  const { from } = input.range;
  for (const clip of input.clips) {
    const profile = input.profiles.get(clip.asset);
    if (!profile) continue;
    const first = Math.max(0, Math.floor((clip.start - from) / ENERGY_HOP_S));
    const last = Math.min(hops, Math.ceil((clip.end - from) / ENERGY_HOP_S));
    for (let h = first; h < last; h++) {
      const t = from + (h + 0.5) * ENERGY_HOP_S;
      const level = levelAt(clip, profile, t);
      if (level === null) continue;
      present[clip.role][h] = 1;
      power[clip.role][h]! += toPower(level);
      if (clip.role === "voice" && sourceLevel(clip, profile, t)! >= profile.threshold) speaking[h] = 1;
    }
  }
  return { power, present, speaking };
}

/** Voice against the bed window by window; null without a voice clip. */
function voiceOverBed(series: RoleSeries, hops: number, from: number, hasVoice: boolean): ReviewSound["voice"] {
  if (!hasVoice) return null;
  const per = Math.round(VOICE_WINDOW_S / ENERGY_HOP_S);
  const margins: { from: number; to: number; margin: number | null }[] = [];
  for (let w = 0; w * per < hops; w++) {
    let spoken = 0;
    let voice = 0;
    let bed = 0;
    let bedHeard = false;
    const end = Math.min(hops, (w + 1) * per);
    for (let h = w * per; h < end; h++) {
      if (!series.speaking[h]) continue;
      spoken++;
      voice += series.power.voice[h]!;
      bed += series.power.music[h]! + series.power.sfx[h]! + series.power.other[h]!;
      bedHeard ||= series.present.music[h]! + series.present.sfx[h]! + series.present.other[h]! > 0;
    }
    if (spoken * 2 < end - w * per) continue;
    const margin = bedHeard && bed > 0 ? round(toDb(voice / spoken) - toDb(bed / spoken), 1) : null;
    margins.push({ from: round(from + w * per * ENERGY_HOP_S), to: round(from + end * ENERGY_HOP_S), margin });
  }
  const measured = margins.flatMap((window) => (window.margin === null ? [] : [window.margin]));
  const sorted = [...measured].sort((a, b) => a - b);
  const low: { from: number; to: number; margin: number }[] = [];
  for (const window of margins) {
    if (window.margin === null || window.margin >= VOICE_OVER_BED_DB) continue;
    const last = low.at(-1);
    if (last && Math.abs(last.to - window.from) < 1e-6) {
      last.to = window.to;
      last.margin = Math.min(last.margin, window.margin);
    } else low.push({ ...window, margin: window.margin });
  }
  return {
    window: VOICE_WINDOW_S,
    windows: margins.length,
    withBed: measured.length,
    minMargin: sorted[0] ?? null,
    medianMargin: sorted.length === 0 ? null : sorted[Math.floor((sorted.length - 1) / 2)]!,
    low: low.slice(0, VOICE_LISTED),
  };
}

/** Effect files heard more than once, and runs of one file in a row. */
function repeatsOf(clips: readonly HeardClip[]): Pick<ReviewSound, "repeats" | "machineGun"> {
  const effects = clips.filter((clip) => clip.role === "sfx").sort((a, b) => a.start - b.start);
  const byFile = new Map<string, HeardClip[]>();
  for (const clip of effects) {
    if (clip.kind !== null && SFX_REPEAT_EXEMPT.includes(clip.kind)) continue;
    byFile.set(clip.asset, [...(byFile.get(clip.asset) ?? []), clip]);
  }
  const repeats = [...byFile]
    .filter(([, plays]) => plays.length > 1)
    .map(([file, plays]) => ({ file, plays: plays.length, at: plays.slice(0, 12).map((clip) => round(clip.start)) }))
    .sort((a, b) => b.plays - a.plays || a.at[0]! - b.at[0]!)
    .slice(0, SOUND_LISTED);
  const machineGun: NonNullable<ReviewSound["machineGun"]> = [];
  for (let i = 0; i < effects.length; ) {
    let j = i + 1;
    while (j < effects.length && effects[j]!.asset === effects[i]!.asset) j++;
    if (j - i >= MACHINE_GUN_PLAYS) machineGun.push({ file: effects[i]!.asset, plays: j - i, from: round(effects[i]!.start), to: round(effects[j - 1]!.start) });
    i = j;
  }
  return { repeats, machineGun: machineGun.slice(0, SOUND_LISTED) };
}

/** Clips ending inside the film whose last 10 ms, as heard, are still loud against their loudest. */
function choppedOf(input: TimelineSoundInput): NonNullable<ReviewSound["chopped"]> {
  const chopped: NonNullable<ReviewSound["chopped"]> = [];
  for (const clip of input.clips) {
    const profile = input.profiles.get(clip.asset);
    // The film's end is the ending's to judge; a clip continued by the next is not cut.
    if (!profile || clip.continued || clip.end >= input.filmEnd - ENERGY_HOP_S || clip.end <= input.range.from || clip.end > input.range.to) continue;
    let peak = -Infinity;
    for (let t = clip.start + ENERGY_HOP_S / 2; t < clip.end; t += ENERGY_HOP_S) peak = Math.max(peak, levelAt(clip, profile, t) ?? -Infinity);
    const tail = levelAt(clip, profile, clip.end - ENERGY_HOP_S / 2);
    if (tail === null || !Number.isFinite(peak) || peak <= SILENCE_DB) continue;
    const level = round(tail - peak, 1);
    if (level > CHOP_DB) chopped.push({ clip: clip.id, track: clip.track, role: clip.role, at: round(clip.end), level });
  }
  return chopped.sort((a, b) => a.at - b.at).slice(0, CHOP_LISTED);
}

/** The sound of a timeline; null when no clip in the range plays sound. */
export function timelineSound(input: TimelineSoundInput): ReviewSound | null {
  const { range } = input;
  const inside = input.clips.filter((clip) => clip.end > range.from && clip.start < range.to && input.profiles.has(clip.asset));
  if (inside.length === 0) return null;
  const hops = Math.max(1, Math.round((range.to - range.from) / ENERGY_HOP_S));
  const series = roleSeries({ ...input, clips: inside }, hops);
  const count = (role: SoundRole) => inside.filter((clip) => clip.role === role).length;

  let ending: ReviewSound["ending"] = null;
  if (range.to >= input.filmEnd - ENERGY_HOP_S) {
    const music = inside.filter((clip) => clip.role === "music");
    const loudest = series.power.music.reduce((best, value) => Math.max(best, value), 0);
    const last = series.power.music[hops - 1]!;
    ending = {
      measure: "music",
      level: music.length > 0 && loudest > 0 && series.present.music[hops - 1] ? round(toDb(last) - toDb(loudest), 1) : null,
      musicEndsAt: music.length > 0 ? round(Math.max(...music.map((clip) => clip.end))) : null,
      loudestAt: null,
      loudestShare: null,
    };
  }
  return {
    source: "timeline",
    clips: { voice: count("voice"), music: count("music"), sfx: count("sfx"), other: count("other") },
    voice: voiceOverBed(series, hops, range.from, count("voice") > 0),
    ...repeatsOf(inside),
    chopped: choppedOf({ ...input, clips: inside }),
    ending,
    clicks: null,
  };
}

/**
 * Seconds of the clicks in `samples` (mono, already high-passed to the click band): a sample peaking over
 * {@link CLICK_RATIO} times the RMS of the {@link CLICK_CONTEXT_S} centred on it, with {@link CLICK_SHARE} of that
 * window's energy in the {@link CLICK_BURST_S} centred on it. A hi-hat rings for tens of ms, so its energy is spread;
 * a cut on a loud sample is a single step. Clicks closer than the window are one; none is looked for in the first window.
 */
export function findClicks(samples: Int16Array, rate: number): number[] {
  const burst = Math.max(1, Math.round(CLICK_BURST_S * rate));
  const context = Math.max(burst, Math.round(CLICK_CONTEXT_S * rate));
  const floor = 10 ** (CLICK_FLOOR_DBFS / 20) * 32768;
  const bins = Math.ceil(samples.length / burst);
  const energy = new Float64Array(bins);
  const peakAt = new Int32Array(bins);
  for (let b = 0; b < bins; b++) {
    let best = 0;
    for (let i = b * burst, end = Math.min(samples.length, (b + 1) * burst); i < end; i++) {
      const x = samples[i]!;
      energy[b]! += x * x;
      if (Math.abs(x) > best) {
        best = Math.abs(x);
        peakAt[b] = i;
      }
    }
  }
  /** Energy and sample count of `samples[from, to)`. */
  const sum = (from: number, to: number) => {
    let total = 0;
    const a = Math.max(0, from);
    const b = Math.min(samples.length, to);
    for (let i = a; i < b; i++) total += samples[i]! * samples[i]!;
    return { total, count: Math.max(1, b - a) };
  };
  const perContext = Math.round(context / burst);
  const found: number[] = [];
  // The high-pass starts from rest, so a sound already playing at the first sample reads as a step: the first window is skipped.
  for (let b = perContext; b < bins; b++) {
    const peak = Math.abs(samples[peakAt[b]!]!);
    if (peak < floor) continue;
    // Cheap test on whole bins first; only a sharp burst is measured again centred on its peak.
    let around = 0;
    const first = Math.max(0, b - Math.floor((perContext - 1) / 2));
    const last = Math.min(bins, first + perContext);
    for (let k = first; k < last; k++) around += energy[k]!;
    const near = energy[b]! + Math.max(energy[b - 1] ?? 0, energy[b + 1] ?? 0);
    if (around <= 0 || near < 0.5 * CLICK_SHARE * around || peak * peak < 0.5 * CLICK_RATIO * CLICK_RATIO * (around / ((last - first) * burst))) continue;
    const at = peakAt[b]!;
    const window = sum(at - Math.floor(context / 2), at + Math.ceil(context / 2));
    const inBurst = sum(at - Math.floor(burst / 2), at + Math.ceil(burst / 2)).total;
    if (peak <= CLICK_RATIO * Math.sqrt(window.total / window.count) || inBurst < CLICK_SHARE * window.total) continue;
    const seconds = at / rate;
    if (found.length > 0 && seconds - found.at(-1)! < CLICK_CONTEXT_S) continue;
    found.push(seconds);
  }
  return found;
}

/** What {@link fileSound} reads. */
export interface FileSoundInput {
  /** dBFS per {@link ENERGY_HOP_S} of the file's decoded sound, from 0. */
  envelope: Float32Array;
  /** Seconds of the clicks found ({@link findClicks}). */
  clicks: readonly number[];
  /** Seconds reviewed and the file's length: the ending is measured only when the range reaches the end. */
  range: { from: number; to: number };
  filmEnd: number;
}

/** The sound of a decoded file: its ending and its clicks. */
export function fileSound(input: FileSoundInput): ReviewSound {
  const { envelope, range } = input;
  let ending: ReviewSound["ending"] = null;
  if (envelope.length > 0 && range.to >= input.filmEnd - ENERGY_HOP_S) {
    const tail = Math.max(1, Math.round(ENDING_TAIL_S / ENERGY_HOP_S));
    let sum = 0;
    for (let i = Math.max(0, envelope.length - tail); i < envelope.length; i++) sum += toPower(envelope[i]!);
    const tailDb = toDb(sum / Math.min(tail, envelope.length));
    const window = Math.min(envelope.length, Math.max(1, Math.round(LOUDEST_WINDOW_S / ENERGY_HOP_S)));
    // Power of the window starting at each hop.
    const windows: number[] = [];
    let running = 0;
    for (let i = 0; i < envelope.length; i++) {
      running += toPower(envelope[i]!);
      if (i >= window) running -= toPower(envelope[i - window]!);
      if (i >= window - 1) windows.push(running);
    }
    const best = windows.reduce((most, power) => Math.max(most, power), 0);
    // The first window as loud as the loudest to the ear: a steady sound peaks where it starts, not where it wobbles last.
    const bestAt = windows.findIndex((power) => toDb(best) - toDb(power) < LOUDEST_MARGIN_DB);
    const silent = best <= 0 || toDb(best / window) <= SILENCE_DB;
    const middle = (bestAt + window / 2) * ENERGY_HOP_S;
    ending = {
      measure: "mix",
      level: tailDb <= SILENCE_DB ? null : round(tailDb, 1),
      musicEndsAt: null,
      loudestAt: silent ? null : round(bestAt * ENERGY_HOP_S),
      loudestShare: silent || input.filmEnd <= 0 ? null : round(Math.min(1, middle / input.filmEnd)),
    };
  }
  const clicks = input.clicks.filter((at) => at >= range.from && at < range.to);
  return {
    source: "file",
    clips: null,
    voice: null,
    repeats: null,
    machineGun: null,
    chopped: null,
    ending,
    clicks: { count: clicks.length, at: clicks.slice(0, CLICK_LISTED).map((at) => round(at)) },
  };
}

/** Craft warnings of the sound review list. */
export function soundWarnings(sound: ReviewSound): ReviewFinding[] {
  const found: ReviewFinding[] = [];
  for (const span of sound.voice?.low ?? []) {
    found.push({
      check: "voice-bed",
      from: span.from,
      to: span.to,
      message: `the bed comes within ${span.margin} dB of the voice from ${span.from} to ${span.to} s (keep it ${VOICE_OVER_BED_DB} dB or more under): duck the music (\`duck\`) or lower the effects there.`,
    });
  }
  for (const repeat of sound.repeats ?? []) {
    if (repeat.plays <= SFX_REPEAT_MAX) continue;
    found.push({
      check: "sfx-repeat",
      from: repeat.at[0]!,
      to: repeat.at.at(-1)!,
      message: `${repeat.file} plays ${repeat.plays} times (at ${repeat.at.join(", ")} s); no effect more than ${SFX_REPEAT_MAX} times: vary \`variant\` or \`seed\`, or drop the ones on no physical event.`,
    });
  }
  for (const run of sound.machineGun ?? []) {
    found.push({
      check: "machine-gun",
      from: run.from,
      to: run.to,
      message: `${run.file} plays ${run.plays} times in a row from ${run.from} to ${run.to} s, the same sample at the same pitch: it reads as a machine gun. Alternate variants or seeds.`,
    });
  }
  for (const clip of sound.chopped ?? []) {
    found.push({
      check: "chopped",
      // The last 10 ms, inside the clip, so a waiver naming it covers the warning.
      from: round(clip.at - ENERGY_HOP_S),
      to: clip.at,
      message: `${clip.clip} (${clip.role}) ends at ${clip.at} s with its sound ${clip.level} dB under its loudest, above ${CHOP_DB} dB: the tail is cut, not decayed. Fade it out (\`clip set --audio-fade-out\`) or end it after the sound dies.`,
    });
  }
  const { ending } = sound;
  if (ending?.measure === "music" && ending.level !== null && ending.level > CHOP_DB) {
    found.push({
      check: "ending",
      from: null,
      to: null,
      message: `the music is ${Math.abs(ending.level)} dB under its loudest on the last frame, above ${CHOP_DB} dB: it is cut, not resolved. End the film on the music's final hit (\`music fit\`) or fade it out.`,
    });
  }
  if (ending?.measure === "mix") {
    if (ending.level !== null && ending.level > ENDING_DBFS) {
      found.push({
        check: "ending",
        from: null,
        to: null,
        message: `the last ${ENDING_TAIL_S * 1000} ms of sound are at ${ending.level} dBFS, above ${ENDING_DBFS} dBFS: the film stops mid-sound. Let the sound decay or fade before the last frame.`,
      });
    }
    if (ending.loudestShare !== null && ending.loudestShare > LOUDEST_BEFORE) {
      found.push({
        check: "ending",
        from: ending.loudestAt,
        to: ending.loudestAt === null ? null : round(ending.loudestAt + LOUDEST_WINDOW_S),
        message: `the loudest moment is at ${ending.loudestAt} s, ${Math.round(ending.loudestShare * 100)} % into the film: it peaks at its end instead of resolving (loudest before ${LOUDEST_BEFORE * 100} %).`,
      });
    }
  }
  if (sound.clicks && sound.clicks.count > 0) {
    const listed = sound.clicks.at.slice(0, 6);
    found.push({
      check: "click",
      from: sound.clicks.at[0]!,
      to: sound.clicks.at.at(-1)!,
      message: `${sound.clicks.count} ${sound.clicks.count === 1 ? "click" : "clicks"} in the sound at ${listed.join(", ")}${sound.clicks.count > listed.length ? ", ..." : ""} s: a cut on a loud sample or a jump in a waveform. Add a short fade at the clip edge there (\`clip set --audio-fade-in\`, \`--audio-fade-out\`).`,
    });
  }
  return found;
}
