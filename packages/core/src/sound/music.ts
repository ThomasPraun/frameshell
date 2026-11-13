// Music synthesized from nothing (ADR 0038 slice 3): a seeded 16-step sequencer writes a score (drums, bass, chords,
// a melody from the minor pentatonic of the key, a build's motif and riser, accents), then each note is rendered into
// a stereo mix with a reverb send, the bass ducked by the kick. The mix is brought to -14 LUFS under a -1 dBFS peak.
// Beats are known, not measured: beat i of the take is at 60 i / bpm seconds, and the last bar ends on a final hit.
import {
  MUSIC_CHORD_QUALITIES,
  MUSIC_LUFS,
  MUSIC_PEAK_DBFS,
  MUSIC_PRESET_DEFAULTS,
  MUSIC_TAIL_SECONDS,
  type MusicPreset,
  type MusicSection,
  SOUND_RISER_END_BEFORE_MS,
} from "@frameshell/schema";
import { fft, nextPowerOfTwo } from "../fft.js";
import { Biquad, type Rng, SR, TAU, noise, rngOf } from "./dsp.js";
import { normaliseLoudness } from "./loudness.js";

/** What makes one music take; its `musicKey` is its cache key. */
export interface MusicSpec {
  preset: MusicPreset;
  bpm: number;
  /** Beats per bar. */
  meter: number;
  /** The parts in order; their bars add up to the track's. */
  sections: readonly { kind: MusicSection; bars: number }[];
  /** Chord names, one per bar, repeating. */
  chords: readonly string[];
  seed: number;
  /** Beats (from 0 at the start of the track) that get a crash and a big kick. */
  accents: readonly number[];
}

/** A rendered music take. */
export interface MusicRender {
  sampleRate: number;
  /** Signed 24-bit samples, left and right. */
  channels: Int32Array[];
  /** Integrated loudness (LUFS) and sample peak (dBFS) of the take. */
  lufs: number;
  peakDb: number;
}

/** Where the beats of a take are: known from the spec, so nothing measures them. */
export interface MusicGrid {
  /** Seconds of each beat, from 0 to the final hit included. */
  beats: number[];
  /** Seconds of the final hit: the downbeat after the last bar. */
  hitAt: number;
  /** Seconds of the strong hits the score places (section accents, given accents, the final hit), increasing. */
  onsets: number[];
  /** Seconds of the whole take, ringing tail included. */
  duration: number;
}

const round6 = (seconds: number) => Math.round(seconds * 1e6) / 1e6;

/** Bars of `spec`. */
export function barsOf(spec: Pick<MusicSpec, "sections">): number {
  return spec.sections.reduce((sum, section) => sum + section.bars, 0);
}

/** Beat `i` of the take is at `60 i / bpm` seconds; the beats run to the final hit after the last bar. */
export function musicGrid(spec: MusicSpec): MusicGrid {
  const beat = 60 / spec.bpm;
  const count = barsOf(spec) * spec.meter;
  const beats = Array.from({ length: count + 1 }, (_, i) => round6(i * beat));
  const hitAt = beats[count]!;
  const strong = new Set<number>([...spec.accents.filter((index) => index <= count), count]);
  let bar = 0;
  for (const section of spec.sections) {
    if (section.kind === "drop" || section.kind === "gap") strong.add(bar * spec.meter);
    bar += section.bars;
  }
  return { beats, hitAt, onsets: [...strong].sort((a, b) => a - b).map((index) => beats[index]!), duration: round6(hitAt + MUSIC_TAIL_SECONDS) };
}

/** The parts of `spec` with the second each starts at in the take. */
export function sectionStarts(spec: MusicSpec): { kind: MusicSection; bars: number; start: number }[] {
  const bar = (60 / spec.bpm) * spec.meter;
  let at = 0;
  return spec.sections.map((section) => {
    const start = round6(at * bar);
    at += section.bars;
    return { kind: section.kind, bars: section.bars, start };
  });
}

/**
 * The parts of a track of `bars` bars when the caller names none: an intro and an outro (one bar each from 3 bars,
 * two from 8), and in between a full part, then from 8 bars a two-bar build into a drop.
 */
export function defaultSections(bars: number): { kind: MusicSection; bars: number }[] {
  if (bars < 3) return [{ kind: "full", bars }];
  const edge = bars >= 8 ? 2 : 1;
  const middle = bars - 2 * edge;
  const inner: { kind: MusicSection; bars: number }[] =
    middle >= 8 ? [{ kind: "full", bars: Math.floor((middle - 2) / 2) }, { kind: "build", bars: 2 }, { kind: "drop", bars: middle - 2 - Math.floor((middle - 2) / 2) }] : [{ kind: "full", bars: middle }];
  return [{ kind: "intro", bars: edge }, ...inner, { kind: "outro", bars: edge }];
}

/** Pitch classes of the note names. */
const PITCH_CLASS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** A chord name as its root pitch class (0 = C) and intervals; null when it is not one the sequencer plays. */
export function parseChord(name: string): { root: number; intervals: readonly number[]; minor: boolean } | null {
  const match = /^([A-G])([#b]?)(.*)$/.exec(name);
  if (!match) return null;
  const intervals = MUSIC_CHORD_QUALITIES[match[3]!];
  if (!intervals) return null;
  const root = (PITCH_CLASS[match[1]!]! + (match[2] === "#" ? 1 : match[2] === "b" ? -1 : 0) + 12) % 12;
  return { root, intervals, minor: intervals[1] === 3 };
}

/** Hz of MIDI note `midi`. */
function hz(midi: number): number {
  return 440 * Math.exp(((midi - 69) / 12) * Math.LN2);
}

/** Minor pentatonic, semitones over the key's root. */
const PENTATONIC = [0, 3, 5, 7, 10];

/** One note of the score; `time` and `length` in seconds. */
type Note =
  | { voice: "kick"; time: number; level: number; big: boolean }
  | { voice: "snare" | "clap" | "crash"; time: number; level: number }
  | { voice: "hat"; time: number; level: number; open: boolean }
  | { voice: "pad"; time: number; length: number; midis: number[]; level: number; bright: number }
  | { voice: "bass"; time: number; length: number; midi: number; level: number; cutoff: number; sub: boolean }
  | { voice: "lead"; time: number; length: number; midi: number; level: number }
  | { voice: "riser"; time: number; length: number; level: number };

/** The score of `spec`: every note in time order of writing (rendering adds them up, so order only fixes the noise draws). */
export function scoreOf(spec: MusicSpec): Note[] {
  const { preset, meter } = spec;
  const beat = 60 / spec.bpm;
  const step = beat / 4;
  const stepsPerBar = meter * 4;
  const swing = MUSIC_PRESET_DEFAULTS[preset].swing;
  const chords = spec.chords.map((name) => {
    const chord = parseChord(name);
    if (!chord) throw new RangeError(`unknown chord ${name}`);
    return chord;
  });
  const first = chords[0]!;
  const key = first.minor ? first.root : (first.root + 9) % 12;
  const leadMidi = (degree: number) => 60 + key + 12 * Math.floor(degree / 5) + PENTATONIC[degree % 5]!;
  const padMidis = (chord: (typeof chords)[number]) => chord.intervals.map((interval) => 48 + chord.root + (interval > 14 ? interval - 12 : interval));
  const notes: Note[] = [];
  const stepTime = (bar: number, index: number) => (bar * stepsPerBar + index) * step + (swing > 0 && index % 2 === 1 ? swing * step : 0);
  const half = Math.floor(meter / 2);

  // A two-bar motif per seed and section kind: a walk on the pentatonic, denser on the beat than off it.
  const motif = (salt: string, density: number) => {
    const rng = rngOf("music", spec.seed, preset, "motif", salt);
    const length = 2 * stepsPerBar;
    const picks: { step: number; degree: number }[] = [];
    let degree = 2 + Math.floor(rng() * 3);
    for (let s = 0; s < length; s++) {
      const k = s % 4;
      const p = (k === 0 ? 0.5 : k === 2 ? 0.32 : 0.12) * density;
      if (s > 0 && rng() >= p) continue;
      const move = [-2, -1, -1, 0, 1, 1, 2][Math.floor(rng() * 7)]!;
      degree = Math.max(0, Math.min(9, degree + move));
      picks.push({ step: s, degree });
    }
    const hold = preset === "synthwave" ? 4 : preset === "lofi" ? 6 : 2;
    return picks.map((pick, i) => ({ ...pick, steps: Math.min(hold, (picks[i + 1]?.step ?? length) - pick.step) }));
  };
  const density = preset === "minimal" ? 1.3 : preset === "lofi" ? 0.8 : 1;
  const motifs = { full: motif("full", density), drop: motif("drop", density * 1.3) };
  const groove = rngOf("music", spec.seed, preset, "groove");

  let bar = 0;
  for (const section of spec.sections) {
    const sectionStart = bar;
    const nextStart = bar + section.bars;
    for (; bar < nextStart; bar++) {
      const chord = chords[bar % chords.length]!;
      const within = bar - sectionStart;
      const barTime = stepTime(bar, 0);
      const barLength = stepsPerBar * step;
      const kind = section.kind;

      if (kind === "gap") {
        // One stop-time hit on the first beat, then silence until the next part's downbeat.
        if (within === 0) {
          notes.push({ voice: "kick", time: barTime, level: 1, big: true }, { voice: "crash", time: barTime, level: 0.7 });
          notes.push({ voice: "pad", time: barTime, length: beat * 0.6, midis: padMidis(chord), level: 0.9, bright: 1.1 });
        }
        continue;
      }

      // Drums.
      for (let j = 0; j < meter; j++) {
        for (let k = 0; k < 4; k++) {
          const time = stepTime(bar, j * 4 + k);
          const onBeat = k === 0;
          if (kind === "outro") {
            if (onBeat && j === 0) notes.push({ voice: "kick", time, level: 0.9, big: false });
            if (onBeat && j === half && half > 0) notes.push({ voice: preset === "minimal" ? "clap" : "snare", time, level: 0.7 });
            continue;
          }
          if (kind === "intro") {
            if (k === 2) notes.push({ voice: "hat", time, level: 0.45, open: false });
            continue;
          }
          if (kind === "dark") {
            if (onBeat && (j === 0 || j === half)) notes.push({ voice: "kick", time, level: 0.5, big: false });
            continue;
          }
          // full, build, drop.
          const kick =
            preset === "lofi" ? (onBeat && j === 0) || (meter >= 4 && j === 2 && k === 2) || (j === meter - 1 && k === 2 && groove() < 0.3) : onBeat;
          if (kick) notes.push({ voice: "kick", time, level: kind === "drop" ? 1 : 0.9, big: false });
          if (onBeat && j % 2 === 1 && kind !== "build") {
            if (preset !== "minimal") notes.push({ voice: "snare", time, level: 0.8 });
            if (preset !== "lofi") notes.push({ voice: "clap", time, level: preset === "minimal" ? 0.7 : 0.5 });
          }
          if (preset === "minimal") {
            const level = (k === 0 ? 0.35 : k === 2 ? 0.7 : 0.25) * (0.85 + 0.3 * groove());
            notes.push({ voice: "hat", time, level, open: k === 2 && j === meter - 1 && groove() < 0.5 });
          } else if (preset === "lofi") {
            if (k % 2 === 0) notes.push({ voice: "hat", time, level: k === 0 ? 0.35 : 0.5, open: false });
            else if (k === 3 && groove() < 0.3) notes.push({ voice: "hat", time, level: 0.25, open: false });
          } else if (k === 2 || (kind === "drop" && k % 2 === 1)) {
            notes.push({ voice: "hat", time, level: k === 2 ? 0.6 : 0.35, open: false });
          }
        }
      }

      // The clap roll of a build: on the beat, then eighths, then sixteenths in its last bar, louder as it goes.
      if (kind === "build") {
        const last = within === section.bars - 1;
        const every = last ? 1 : within >= section.bars / 2 ? 2 : 4;
        for (let s = 0; s < stepsPerBar; s += every) {
          const progress = (within * stepsPerBar + s) / (section.bars * stepsPerBar);
          notes.push({ voice: "clap", time: stepTime(bar, s), level: 0.35 + 0.5 * progress });
        }
      }

      // Bass.
      if (kind === "dark" || kind === "intro") {
        if (kind === "dark") notes.push({ voice: "bass", time: barTime, length: barLength, midi: 36 + chord.root, level: 0.8, cutoff: 300, sub: true });
      } else if (kind === "outro") {
        notes.push({ voice: "bass", time: barTime, length: barLength * 0.9, midi: 36 + chord.root, level: 0.8, cutoff: 500, sub: preset !== "minimal" });
      } else if (preset === "synthwave") {
        for (let s = 0; s < stepsPerBar; s += 2) {
          const octave = s % 8 === 6 ? 12 : 0;
          notes.push({ voice: "bass", time: stepTime(bar, s), length: step * 1.8, midi: 36 + chord.root + octave, level: 0.8, cutoff: 300 + 900 * (s / stepsPerBar), sub: true });
        }
      } else if (preset === "lofi") {
        notes.push({ voice: "bass", time: barTime, length: beat * 1.5, midi: 36 + chord.root, level: 0.9, cutoff: 600, sub: false });
        if (meter >= 3) notes.push({ voice: "bass", time: stepTime(bar, 10), length: beat, midi: 36 + chord.root + 7, level: 0.7, cutoff: 600, sub: false });
      } else {
        const rng = rngOf("music", spec.seed, preset, "bass", bar % 2);
        for (let s = 0; s < stepsPerBar; s++) {
          const p = s % 4 === 2 ? 0.75 : s % 4 === 0 ? 0.15 : 0.2;
          if (rng() >= p) continue;
          const interval = [0, 0, 0, 7, 12][Math.floor(rng() * 5)]!;
          notes.push({ voice: "bass", time: stepTime(bar, s), length: step * 1.5, midi: 36 + chord.root + interval, level: 0.85, cutoff: 0, sub: false });
        }
      }

      // Chords: held pads, or mallet stabs in the minimal preset (no pads).
      if (preset === "minimal") {
        for (const s of [0, Math.min(stepsPerBar - 1, 6)]) {
          for (const midi of padMidis(chord)) notes.push({ voice: "lead", time: stepTime(bar, s), length: step * 2, midi: midi + 12, level: 0.3 });
        }
      } else {
        notes.push({ voice: "pad", time: barTime, length: barLength, midis: padMidis(chord), level: kind === "dark" ? 0.8 : 1, bright: kind === "dark" ? 0.45 : kind === "intro" ? 0.7 : 1 });
      }

      // Melody: the motif of the part over every two bars; a build climbs the pentatonic instead.
      if (kind === "full" || kind === "drop") {
        const offset = (within % 2) * stepsPerBar;
        for (const pick of motifs[kind]) {
          if (pick.step < offset || pick.step >= offset + stepsPerBar) continue;
          notes.push({ voice: "lead", time: stepTime(bar, pick.step - offset), length: pick.steps * step, midi: leadMidi(pick.degree), level: kind === "drop" ? 0.75 : 0.6 });
        }
      } else if (kind === "build") {
        const every = within === section.bars - 1 ? 1 : 2;
        for (let s = 0; s < stepsPerBar; s += every) {
          const n = Math.floor((within * stepsPerBar + s) / 2);
          notes.push({ voice: "lead", time: stepTime(bar, s), length: step * every * 0.9, midi: leadMidi(Math.min(12, n % 13)), level: 0.4 + 0.3 * ((within * stepsPerBar + s) / (section.bars * stepsPerBar)) });
        }
      }
    }

    if (section.kind === "build") {
      // The riser ends 75 ms before the next part (or the final hit) and is cut there, at its peak.
      const from = stepTime(sectionStart, 0);
      const to = nextStart * stepsPerBar * step - SOUND_RISER_END_BEFORE_MS / 1000;
      if (to - from > 0.2) notes.push({ voice: "riser", time: from, length: to - from, level: 0.5 });
    }
    if (section.kind === "drop") notes.push({ voice: "crash", time: stepTime(sectionStart, 0), level: 0.8 }, { voice: "kick", time: stepTime(sectionStart, 0), level: 1, big: true });
  }

  for (const accent of spec.accents) {
    const time = accent * beat;
    if (time >= bar * stepsPerBar * step) continue;
    notes.push({ voice: "crash", time, level: 0.8 }, { voice: "kick", time, level: 1, big: true });
  }

  // The final hit: the first chord on the downbeat after the last bar, ringing.
  const end = bar * stepsPerBar * step;
  notes.push({ voice: "kick", time: end, level: 1, big: true }, { voice: "crash", time: end, level: 0.8 });
  if (preset === "minimal") for (const midi of padMidis(first)) notes.push({ voice: "lead", time: end, length: MUSIC_TAIL_SECONDS, midi: midi + 12, level: 0.35 });
  else notes.push({ voice: "pad", time: end, length: 0.2, midis: padMidis(first), level: 1, bright: 1 });
  notes.push({ voice: "bass", time: end, length: 1.2, midi: 36 + first.root, level: 0.8, cutoff: 500, sub: preset !== "minimal" });
  return notes;
}

/** The stereo mix being written, with its reverb send. */
interface Mix {
  left: Float64Array;
  right: Float64Array;
  send: Float64Array;
}

/** Equal-power gains of pan `p` (-1 left, 1 right). */
function panOf(p: number): [number, number] {
  const angle = ((p + 1) * Math.PI) / 4;
  return [Math.cos(angle), Math.sin(angle)];
}

/** Add `length` seconds from `time` of `sample(t)`, `t` in seconds from `time`, into the mix (a mono source, panned, with a send). */
function add(mix: Mix, time: number, length: number, pan: number, send: number, sample: (t: number) => number): void {
  const [l, r] = panOf(pan);
  const first = Math.max(0, Math.round(time * SR));
  const last = Math.min(mix.left.length, Math.round((time + length) * SR));
  const offset = first - time * SR;
  for (let i = first; i < last; i++) {
    const x = sample((i - first + offset) / SR);
    mix.left[i]! += x * l;
    mix.right[i]! += x * r;
    mix.send[i]! += x * send;
  }
}

/** Band-limited sawtooth of phase `phase` in [0, 1) moving `dt` a sample (PolyBLEP). */
function saw(phase: number, dt: number): number {
  let blep = 0;
  if (phase < dt) {
    const t = phase / dt;
    blep = t + t - t * t - 1;
  } else if (phase > 1 - dt) {
    const t = (phase - 1) / dt;
    blep = t * t + t + t + 1;
  }
  return 2 * phase - 1 - blep;
}

/** Envelope of a held note: `attack` in, held to `length`, then an exponential release with time constant `release`. */
function held(t: number, length: number, attack: number, release: number): number {
  if (t < attack) return t / attack;
  if (t < length) return 1;
  return Math.exp(-(t - length) / release);
}

/** Per-sample factor of an exponential decay with time constant `tau` seconds. */
function perSample(tau: number): number {
  return Math.exp(-1 / (tau * SR));
}

/**
 * An electric piano note of `length` seconds: a sine decaying with `decay`, its second harmonic fading faster
 * (`harmonicDecay`), released with `release`, with a slow tremolo when `tremolo`.
 */
function electricPiano(f: number, length: number, release: number, decay: number, harmonicDecay: number, level: number, tremolo: boolean): (t: number) => number {
  const fade = perSample(decay);
  const fadeHarmonic = perSample(harmonicDecay);
  let phase = 0;
  let wobble = 0;
  let env = level;
  let harmonic = 0.3;
  return (t) => {
    phase = (phase + f / SR) % 1;
    env *= fade;
    harmonic *= fadeHarmonic;
    const body = Math.sin(TAU * phase) + harmonic * Math.sin(2 * TAU * phase);
    let x = body * Math.min(1, t / 0.008) * env * held(t, length, 0.0001, release);
    if (tremolo) {
      wobble = (wobble + 4.5 / SR) % 1;
      x *= 1 + 0.1 * Math.sin(TAU * wobble);
    }
    return x;
  };
}

/** Time constant of a preset's kick decay, seconds (the minimal preset's is a long drum-machine boom). */
const KICK_DECAY: Record<MusicPreset, number> = { synthwave: 0.16, lofi: 0.12, minimal: 0.3 };

/** Render `note` into `mix`; `rng` draws every noise sample, `kicks` are the kick times (sorted) the bass ducks under. */
function render(mix: Mix, note: Note, preset: MusicPreset, rng: Rng, kicks: Float64Array): void {
  switch (note.voice) {
    case "kick": {
      const decay = KICK_DECAY[preset] * (note.big ? 1.6 : 1);
      const top = note.big ? 170 : 140;
      const fall = perSample(0.03);
      const fade = perSample(decay);
      const scale = (note.level * 1.1) / Math.tanh(1.6);
      let phase = 0;
      let sweep = top - 45;
      let env = 1;
      add(mix, note.time, decay * 4.5, 0, 0, (t) => {
        phase = (phase + (TAU * (45 + sweep)) / SR) % TAU;
        sweep *= fall;
        env *= fade;
        return Math.tanh(1.6 * Math.sin(phase) * Math.min(1, t / 0.001) * env) * scale;
      });
      return;
    }
    case "snare": {
      const bp = new Biquad().set("bandpass", 1900, 0.9);
      add(mix, note.time, 0.3, 0.05, 0.2, (t) => (1.4 * bp.process(noise(rng)) * Math.exp(-t / 0.07) + 0.5 * Math.sin(TAU * 185 * t) * Math.exp(-t / 0.04)) * note.level * 0.6);
      return;
    }
    case "clap": {
      const bp = new Biquad().set("bandpass", 1300, 1.2);
      add(mix, note.time, 0.3, -0.05, 0.35, (t) => {
        const burst = [0, 0.01, 0.021].reduce((sum, at) => sum + (t >= at && t < at + 0.01 ? Math.exp(-(t - at) / 0.006) : 0), 0);
        const env = burst + (t >= 0.021 ? 0.6 * Math.exp(-(t - 0.021) / 0.09) : 0);
        return 1.6 * bp.process(noise(rng)) * env * note.level * 0.6;
      });
      return;
    }
    case "hat": {
      const hp = new Biquad().set("highpass", preset === "lofi" ? 6000 : 7000, 0.7);
      const decay = note.open ? 0.12 : 0.025;
      // The minimal preset's hat is metallic: six square waves at the classic drum machine's ratios.
      const freqs = [205.3, 304.4, 369.6, 522.7, 540, 800];
      const phases = new Float64Array(6);
      const fade = perSample(decay);
      let env = note.level * 0.5;
      add(mix, note.time, decay * 6, 0.25, 0.1, () => {
        let source: number;
        if (preset === "minimal") {
          source = 0;
          for (let k = 0; k < 6; k++) {
            phases[k] = (phases[k]! + freqs[k]! / SR) % 1;
            source += phases[k]! < 0.5 ? 0.2 : -0.2;
          }
        } else source = noise(rng);
        env *= fade;
        return hp.process(source) * env;
      });
      return;
    }
    case "crash": {
      const hpLeft = new Biquad().set("highpass", 4500, 0.7);
      const hpRight = new Biquad().set("highpass", 4500, 0.7);
      const first = Math.max(0, Math.round(note.time * SR));
      const last = Math.min(mix.left.length, first + Math.round(2.2 * SR));
      for (let i = first; i < last; i++) {
        const t = (i - first) / SR;
        const env = Math.min(1, t / 0.002) * Math.exp(-t / 0.6) * note.level * 0.45;
        const l = hpLeft.process(noise(rng)) * env;
        const r = hpRight.process(noise(rng)) * env;
        mix.left[i]! += l;
        mix.right[i]! += r;
        mix.send[i]! += 0.3 * (l + r);
      }
      return;
    }
    case "pad": {
      const ring = note.length < 0.5 ? (preset === "lofi" ? 0.9 : 0.6) : 0.12;
      const release = preset === "lofi" ? Math.max(ring, 0.3) : ring;
      const length = note.length + release * 5;
      const freqs = note.midis.map(hz);
      const level = (note.level * 0.5) / freqs.length;
      if (preset === "synthwave") {
        // Two saws per note detuned 0.4 % apart, one per side, through a low-pass.
        const phases = freqs.flatMap((f, n) => [((n * 0.37) % 1), ((n * 0.61 + 0.5) % 1)]);
        const lpLeft = new Biquad().set("lowpass", 1800 * note.bright, 0.8);
        const lpRight = new Biquad().set("lowpass", 1800 * note.bright, 0.8);
        const first = Math.max(0, Math.round(note.time * SR));
        const last = Math.min(mix.left.length, first + Math.round(length * SR));
        for (let i = first; i < last; i++) {
          const t = (i - first) / SR;
          const env = held(t, note.length, 0.06, release) * level;
          let l = 0;
          let r = 0;
          freqs.forEach((f, n) => {
            const dl = (f * 0.998) / SR;
            const dr = (f * 1.002) / SR;
            phases[2 * n] = (phases[2 * n]! + dl) % 1;
            phases[2 * n + 1] = (phases[2 * n + 1]! + dr) % 1;
            l += saw(phases[2 * n]!, dl);
            r += saw(phases[2 * n + 1]!, dr);
          });
          const left = lpLeft.process(l) * env;
          const right = lpRight.process(r) * env;
          mix.left[i]! += left;
          mix.right[i]! += right;
          mix.send[i]! += 0.4 * (left + right);
        }
        return;
      }
      // An electric piano: a sine with a fading second harmonic, a slow tremolo, each note a little apart in the field.
      freqs.forEach((f, n) => {
        add(mix, note.time, length, (n / Math.max(1, freqs.length - 1) - 0.5) * 0.5, 0.45, electricPiano(f, note.length, release, 1.8, 0.3, level * 1.3 * (note.bright < 1 ? 0.8 : 1), true));
      });
      return;
    }
    case "bass": {
      const f = hz(note.midi);
      const dt = f / SR;
      const lp = new Biquad();
      const release = 0.03;
      const pluck = preset === "minimal" && note.cutoff === 0;
      let phase = 0;
      let sub = 0;
      let kick = 0;
      let i = 0;
      add(mix, note.time, note.length + (pluck ? 0.6 : release * 5), 0, 0.05, (t) => {
        const now = note.time + t;
        // Ducked by the kick: 45 % down at each kick, back with a 70 ms time constant.
        while (kick + 1 < kicks.length && kicks[kick + 1]! <= now) kick++;
        const duck = kicks.length > 0 && kicks[kick]! <= now ? 1 - 0.45 * Math.exp(-(now - kicks[kick]!) / 0.07) : 1;
        phase = (phase + dt) % 1;
        const update = i++ % 16 === 0;
        if (pluck) {
          if (update) lp.set("lowpass", 180 + 2200 * Math.exp(-t / 0.04), 1.2);
          return lp.process(saw(phase, dt)) * Math.exp(-t / 0.22) * duck * note.level * 0.7;
        }
        let x: number;
        if (preset === "synthwave") {
          // A saw through a low-pass that opens over the bar, over a sine an octave down.
          if (update) lp.set("lowpass", note.cutoff, 1);
          sub = (sub + dt / 2) % 1;
          x = 0.7 * lp.process(saw(phase, dt)) + (note.sub ? 0.6 * Math.sin(TAU * sub) : 0);
        } else {
          // A round bass: a sine with a little of its triangle.
          x = Math.sin(TAU * phase) + 0.25 * (1 - 4 * Math.abs(phase - 0.5));
        }
        return x * held(t, note.length, 0.004, release) * duck * note.level * 0.55;
      });
      return;
    }
    case "lead": {
      const f = hz(note.midi);
      if (preset === "minimal") {
        // An FM mallet: a modulator four times the pitch, its depth falling fast.
        const depthFall = perSample(0.06);
        const fade = perSample(0.3);
        let carrier = 0;
        let modulator = 0;
        let depth = 2.5;
        let env = note.level * 0.5;
        add(mix, note.time, note.length + 0.6, (note.midi % 5) * 0.15 - 0.3, 0.4, (t) => {
          carrier = (carrier + f / SR) % 1;
          modulator = (modulator + (4 * f) / SR) % 1;
          depth *= depthFall;
          env *= fade;
          return Math.sin(TAU * carrier + depth * Math.sin(TAU * modulator)) * Math.min(1, t / 0.002) * env;
        });
        return;
      }
      if (preset === "lofi") {
        add(mix, note.time, note.length + 1, 0.2, 0.45, electricPiano(f, note.length, 0.15, 0.9, 0.2, note.level * 0.35, false));
        return;
      }
      // A saw and square lead through a low-pass, with vibrato once it holds.
      const lp = new Biquad().set("lowpass", 2600, 1);
      let phase = 0;
      add(mix, note.time, note.length + 0.4, -0.2, 0.35, (t) => {
        const dt = (f * (1 + 0.004 * Math.sin(TAU * 5.5 * t) * Math.min(1, Math.max(0, t - 0.15) / 0.1))) / SR;
        phase = (phase + dt) % 1;
        const square = saw(phase, dt) - saw((phase + 0.5) % 1, dt);
        const env = held(t, note.length, 0.006, 0.08) * (0.7 + 0.3 * Math.exp(-t / 0.15));
        return lp.process(0.5 * saw(phase, dt) + 0.4 * square) * env * note.level * 0.3;
      });
      return;
    }
    case "riser": {
      const bp = new Biquad();
      let i = 0;
      add(mix, note.time, note.length, 0, 0.3, (t) => {
        const u = t / note.length;
        if (i++ % 16 === 0) bp.set("bandpass", 250 * Math.exp(Math.log(6500 / 250) * u), 1);
        const cut = Math.min(1, (note.length - t) / 0.002);
        return bp.process(noise(rng)) * Math.exp(4.5 * (u - 1)) * cut * note.level * 1.5;
      });
      return;
    }
  }
}

/** Reverb length per preset, seconds to -60 dB. */
const REVERB_SECONDS: Record<MusicPreset, number> = { synthwave: 1.6, lofi: 1.2, minimal: 1 };

/**
 * The reverb return of `send`: convolution with a synthetic impulse (decaying noise, a different draw per side,
 * 20 ms pre-delay, darkened to 5 kHz), by FFT overlap-add. A complex FFT carries both sides at once: the send is
 * real, so convolving it with `left + i right` gives the left return in the real part and the right in the imaginary.
 */
function reverb(send: Float64Array, preset: MusicPreset): [Float64Array, Float64Array] {
  const rng = rngOf("music", preset, "impulse");
  const seconds = REVERB_SECONDS[preset];
  const delay = Math.round(0.02 * SR);
  const length = delay + Math.round(seconds * SR);
  const irLeft = new Float64Array(length);
  const irRight = new Float64Array(length);
  const lpLeft = new Biquad().set("lowpass", 5000, 0.7);
  const lpRight = new Biquad().set("lowpass", 5000, 0.7);
  let energy = 0;
  for (let i = delay; i < length; i++) {
    const env = Math.exp((-6.9 * (i - delay)) / (seconds * SR));
    irLeft[i] = lpLeft.process(noise(rng)) * env;
    irRight[i] = lpRight.process(noise(rng)) * env;
    energy += irLeft[i]! * irLeft[i]! + irRight[i]! * irRight[i]!;
  }
  const scale = 1 / Math.sqrt(energy / 2);
  const size = nextPowerOfTwo(2 * length);
  const block = size - length + 1;
  const hRe = new Float64Array(size);
  const hIm = new Float64Array(size);
  for (let i = 0; i < length; i++) {
    hRe[i] = irLeft[i]! * scale;
    hIm[i] = irRight[i]! * scale;
  }
  fft(hRe, hIm, false);
  const left = new Float64Array(send.length);
  const right = new Float64Array(send.length);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let start = 0; start < send.length; start += block) {
    re.fill(0);
    im.fill(0);
    const count = Math.min(block, send.length - start);
    let silent = true;
    for (let i = 0; i < count; i++) {
      re[i] = send[start + i]!;
      if (re[i] !== 0) silent = false;
    }
    if (silent) continue;
    fft(re, im, false);
    for (let k = 0; k < size; k++) {
      const a = re[k]!;
      const b = im[k]!;
      re[k] = a * hRe[k]! - b * hIm[k]!;
      im[k] = a * hIm[k]! + b * hRe[k]!;
    }
    fft(re, im, true);
    const end = Math.min(send.length, start + size);
    for (let i = start; i < end; i++) {
      left[i]! += re[i - start]!;
      right[i]! += im[i - start]!;
    }
  }
  return [left, right];
}

/** Render `spec`: the score, the mix, the reverb, a 30 Hz high-pass (and the lo-fi low-pass), then the loudness. */
export function synthesizeMusic(spec: MusicSpec): MusicRender {
  const grid = musicGrid(spec);
  const n = Math.round(grid.duration * SR);
  const mix: Mix = { left: new Float64Array(n), right: new Float64Array(n), send: new Float64Array(n) };
  const notes = scoreOf(spec);
  const kicks = Float64Array.from(notes.filter((note) => note.voice === "kick").map((note) => note.time)).sort();
  const rng = rngOf("music", spec.seed, spec.preset, "noise");
  for (const note of notes) render(mix, note, spec.preset, rng, kicks);

  if (spec.preset === "lofi") {
    // Vinyl: sparse clicks over a faint hiss.
    const hiss = new Biquad().set("lowpass", 3000, 0.7);
    let click = 0;
    for (let i = 0; i < n; i++) {
      if (rng() < 14 / SR) click = (rng() * 2 - 1) * 0.08;
      const x = click + 0.004 * hiss.process(noise(rng));
      click *= 0.92;
      mix.left[i]! += x;
      mix.right[i]! += x;
    }
  }

  const [wetLeft, wetRight] = reverb(mix.send, spec.preset);
  const master = [mix.left, mix.right].map((channel, side) => {
    const wet = side === 0 ? wetLeft : wetRight;
    const hp = new Biquad().set("highpass", 30, 0.707);
    const lp = spec.preset === "lofi" ? new Biquad().set("lowpass", 3200, 0.707) : null;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const x = hp.process(channel[i]! + 0.5 * wet[i]!);
      out[i] = lp ? lp.process(x) : x;
    }
    // The last 50 ms fade to silence, so the ring never ends on a cut.
    const fade = Math.round(0.05 * SR);
    for (let i = 0; i < fade; i++) out[n - 1 - i]! *= i / fade;
    return out;
  });

  const normalised = normaliseLoudness(master, MUSIC_LUFS, MUSIC_PEAK_DBFS);
  const full = 8_388_607;
  const channels = normalised.channels.map((channel) => {
    const out = new Int32Array(channel.length);
    for (let i = 0; i < channel.length; i++) out[i] = Math.max(-full, Math.min(full, Math.round(channel[i]! * full)));
    return out;
  });
  return { sampleRate: SR, channels, lufs: normalised.lufs, peakDb: normalised.peakDb };
}
