// Builds the synthetic corpus of the real-music check (#689) into a directory OUTSIDE the repo, with manifest.json.
//
//   FRAMESHELL_BEATS_MUSIC_DIR=<dir outside the repo> node make-corpus.mjs
//
// Groups (the `group` field of each manifest entry):
//   synthetic-music   `sound.music` takes (synthesizeMusic): 3 presets x 7 tempi 70-170 BPM; truth = its exact beats.
//   synthetic-variant ffmpeg variants of three of them: low-pass, high-pass, mp3 128k, compressed, noise bed, 16 kHz fallback decode.
//   synthetic-pattern script-built drum patterns (4-on-floor, backbeat, tresillo, swing, off-beat, tempi out of 70-170).
//   synthetic-rubato  tempo ramps: no straight grid fits, so informational.
//   synthetic-stress  soft-attack pad and plucks without drums.
// No audio is ever written inside the repo.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ffmpeg, loadCore, outsideRepo } from "./lib.mjs";

const dirArg = process.argv[2] ?? process.env.FRAMESHELL_BEATS_MUSIC_DIR;
if (!dirArg) {
  console.error("usage: FRAMESHELL_BEATS_MUSIC_DIR=<dir> node make-corpus.mjs   (a directory outside the repo)");
  process.exit(2);
}
const dir = outsideRepo(dirArg);
mkdirSync(dir, { recursive: true });

const { synthesizeMusic, musicGrid, defaultSections } = await loadCore("sound/music.js");
const { wavBytes } = await loadCore("transcripts/window.js");
const schema = await import(new URL("../../packages/schema/dist/index.js", import.meta.url).href);
const defaults = schema.MUSIC_PRESET_DEFAULTS;

const tracks = [];
const save = (name, buffer) => writeFileSync(join(dir, name), buffer);
const saveBeats = (name, beats) => writeFileSync(join(dir, name), JSON.stringify({ beats }));

// ---- synthetic-music ----
const TEMPI = [70, 85, 100, 118, 130, 150, 170];
const bases = new Map();
for (const preset of Object.keys(defaults)) {
  for (const bpm of TEMPI) {
    const spec = { preset, bpm, meter: 4, sections: defaultSections(16), chords: defaults[preset].chords, seed: 7, accents: [] };
    const grid = musicGrid(spec);
    const render = synthesizeMusic(spec);
    const file = `music-${preset}-${bpm}.wav`;
    save(file, wavBytes({ sampleRate: render.sampleRate, bits: 24, channels: render.channels }));
    saveBeats(`music-${preset}-${bpm}.beats.json`, grid.beats);
    tracks.push({ file, group: "synthetic-music", bpm, beatsFile: `music-${preset}-${bpm}.beats.json`, source: "sound.music (synthesizeMusic)", licence: "generated" });
    bases.set(file, { preset, bpm });
    console.log("music", file);
  }
}

// ---- synthetic-variant ----
const VARIANTS = [
  { id: "lp1500", out: "wav", filter: "lowpass=f=1500" },
  { id: "hp1200", out: "wav", filter: "highpass=f=1200" },
  { id: "compressed", out: "wav", filter: "acompressor=threshold=0.03:ratio=12:attack=2:release=60:makeup=8,alimiter=limit=0.9" },
  { id: "mp3-128k", out: "mp3", codec: ["-c:a", "libmp3lame", "-b:a", "128k"] },
  { id: "noisebed", out: "wav", noise: true },
];
const variantBases = ["music-synthwave-118.wav", "music-lofi-85.wav", "music-minimal-150.wav"];
for (const base of variantBases) {
  const { bpm } = bases.get(base);
  const beatsFile = base.replace(".wav", ".beats.json");
  for (const variant of VARIANTS) {
    const file = base.replace(".wav", `.${variant.id}.${variant.out}`);
    if (variant.noise) {
      await ffmpeg([
        ...["-y", "-i", join(dir, base)],
        ...["-f", "lavfi", "-i", "anoisesrc=color=pink:r=48000:amplitude=0.25"],
        ...["-f", "lavfi", "-i", "sine=f=196:r=48000"],
        ...["-f", "lavfi", "-i", "sine=f=247:r=48000"],
        ...["-filter_complex", "[1]volume=0.35[n];[2]volume=0.08[a];[3]volume=0.08[b];[0][n][a][b]amix=inputs=4:normalize=0:duration=first"],
        join(dir, file),
      ]);
    } else {
      await ffmpeg(["-y", "-i", join(dir, base), ...(variant.filter ? ["-af", variant.filter] : []), ...(variant.codec ?? []), join(dir, file)]);
    }
    tracks.push({ file, group: "synthetic-variant", bpm, beatsFile, source: `${base} + ${variant.id}`, licence: "generated" });
    console.log("variant", file);
  }
  tracks.push({ file: base, group: "synthetic-variant", bpm, beatsFile, decode: "fallback", source: `${base} decoded at 16 kHz mono (no-sidecar path)`, licence: "generated", name: `${base} [16k]` });
}

// ---- script-built patterns ----
const RATE = 44_100;
const noiseOf = (seed) => {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 31 - 1;
  };
};

/** Mono audio of `events` ({time, voice, amp}); voices are plain click-like drum synths. */
function render(events, seconds) {
  const out = new Float32Array(Math.ceil(seconds * RATE));
  const rand = noiseOf(11);
  for (const { time, voice, amp } of events) {
    const start = Math.round(time * RATE);
    const length = { kick: 0.3, snare: 0.18, hat: 0.05, pluck: 0.6, pad: 0 }[voice] * RATE;
    let prev = 0;
    for (let i = 0; i < length && start + i < out.length; i++) {
      const t = i / RATE;
      let x = 0;
      if (voice === "kick") x = Math.sin(2 * Math.PI * (45 * t + (75 * (1 - Math.exp(-30 * t))) / 30)) * Math.exp(-t * 14);
      else if (voice === "snare") x = (rand() * 0.8 + Math.sin(2 * Math.PI * 190 * t) * 0.5) * Math.exp(-t * 26);
      else if (voice === "hat") {
        const n = rand();
        x = (n - prev) * Math.exp(-t * 90);
        prev = n;
      } else if (voice === "pluck") {
        const attack = Math.min(1, t / 0.03);
        x = attack * Math.exp(-t * 5) * (Math.sin(2 * Math.PI * 330 * t) + 0.4 * Math.sin(2 * Math.PI * 660 * t));
      }
      out[start + i] += x * amp;
    }
  }
  return out;
}

/** 16-step bars: which 16th steps carry which voice. */
const PATTERNS = {
  fourfloor: { kick: [0, 4, 8, 12], snare: [4, 12], hat: [2, 6, 10, 14] },
  backbeat: { kick: [0, 10], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14] },
  tresillo: { kick: [0, 3, 6, 8, 11, 14], snare: [4, 12], hat: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] },
  // Every hit sits an 8th after the beat: the downbeat has no energy, the grid phase is ambiguous by design.
  offbeat: { kick: [2, 6, 10, 14], snare: [6, 14], hat: [2, 6, 10, 14] },
};
const AMPS = { kick: 1, snare: 0.7, hat: 0.22 };

/**
 * Beat times from a tempo function (BPM at time t), then 16th-step events between them. `swing` (in beats)
 * delays the odd 8ths (steps 2, 6, 10, 14 plus the 16ths between them follow their 8th).
 */
function pattern({ style, tempoAt, seconds, swing = 0 }) {
  const beats = [0];
  while (beats[beats.length - 1] < seconds) beats.push(beats[beats.length - 1] + 60 / tempoAt(beats[beats.length - 1]));
  const events = [];
  const steps = PATTERNS[style];
  for (let beat = 0; beat < beats.length - 1; beat++) {
    const length = beats[beat + 1] - beats[beat];
    for (let sub = 0; sub < 4; sub++) {
      const step = (beat % 4) * 4 + sub;
      let position = sub / 4;
      if (sub === 2 && swing) position += swing;
      else if (sub === 3 && swing) position += swing;
      const time = beats[beat] + position * length;
      if (time >= seconds) continue;
      for (const voice of ["kick", "snare", "hat"]) if (steps[voice].includes(step)) events.push({ time, voice, amp: AMPS[voice] });
    }
  }
  const audio = render(events, seconds + 0.5);
  let peak = 0;
  for (const v of audio) peak = Math.max(peak, Math.abs(v));
  const int = new Int16Array(audio.length);
  for (let i = 0; i < audio.length; i++) int[i] = Math.round((audio[i] / peak) * 0.8 * 32767);
  return { int, beats: beats.filter((time) => time < seconds) };
}

const constant = (bpm) => () => bpm;
const PATTERN_CASES = [
  { id: "fourfloor-128", style: "fourfloor", bpm: 128 },
  { id: "fourfloor-100-swing-light", style: "fourfloor", bpm: 100, swing: 0.08 },
  { id: "backbeat-90-swing", style: "backbeat", bpm: 90, swing: 0.12 },
  { id: "backbeat-140-triplet-swing", style: "backbeat", bpm: 140, swing: 1 / 6 },
  { id: "tresillo-110", style: "tresillo", bpm: 110 },
  { id: "tresillo-150", style: "tresillo", bpm: 150 },
  { id: "backbeat-65-slow", style: "backbeat", bpm: 65, note: "below the 70-170 fold: expected one octave off, fixable by edits.tempo" },
  { id: "backbeat-175-fast", style: "backbeat", bpm: 175, note: "above the 70-170 fold: expected one octave off, fixable by edits.tempo" },
  { id: "offbeat-120", style: "offbeat", bpm: 120, informational: true, note: "every hit is an 8th after the beat: the phase is ambiguous, informational" },
];
for (const c of PATTERN_CASES) {
  const seconds = 32;
  const { int, beats } = pattern({ style: c.style, tempoAt: constant(c.bpm), seconds, swing: c.swing ?? 0 });
  const file = `pat-${c.id}.wav`;
  save(file, wavBytes({ sampleRate: RATE, bits: 16, channels: [int] }));
  saveBeats(`pat-${c.id}.beats.json`, beats);
  tracks.push({ file, group: "synthetic-pattern", bpm: c.bpm, beatsFile: `pat-${c.id}.beats.json`, informational: c.informational ?? false, note: c.note, source: "script-built pattern", licence: "generated" });
  console.log("pattern", file);
}

// ---- synthetic-rubato (informational) ----
const RUBATO = [
  { id: "ramp-100-120", tempoAt: (t) => 100 + (20 * t) / 40, mean: 110 },
  { id: "wave-110-pm8pct", tempoAt: (t) => 110 * (1 + 0.08 * Math.sin((2 * Math.PI * t) / 20)), mean: 110 },
];
for (const c of RUBATO) {
  const { int, beats } = pattern({ style: "backbeat", tempoAt: c.tempoAt, seconds: 40 });
  const file = `rub-${c.id}.wav`;
  save(file, wavBytes({ sampleRate: RATE, bits: 16, channels: [int] }));
  saveBeats(`rub-${c.id}.beats.json`, beats);
  tracks.push({ file, group: "synthetic-rubato", bpm: c.mean, beatsFile: `rub-${c.id}.beats.json`, informational: true, note: "tempo moves: no straight grid fits", source: "script-built pattern", licence: "generated" });
  console.log("rubato", file);
}

// ---- synthetic-stress: soft attacks, no drums ----
{
  const bpm = 90;
  const beat = 60 / bpm;
  const events = [];
  const beats = [];
  for (let b = 0; b * beat < 40; b++) {
    beats.push(b * beat);
    events.push({ time: b * beat, voice: "pluck", amp: b % 4 === 0 ? 1 : 0.7 });
    events.push({ time: b * beat + beat / 2, voice: "pluck", amp: 0.45 });
  }
  const audio = render(events, 40.7);
  let peak = 0;
  for (const v of audio) peak = Math.max(peak, Math.abs(v));
  const int = new Int16Array(audio.length);
  for (let i = 0; i < audio.length; i++) int[i] = Math.round((audio[i] / peak) * 0.8 * 32767);
  save("stress-soft-pluck-90.wav", wavBytes({ sampleRate: RATE, bits: 16, channels: [int] }));
  saveBeats("stress-soft-pluck-90.beats.json", beats);
  tracks.push({ file: "stress-soft-pluck-90.wav", group: "synthetic-stress", bpm, beatsFile: "stress-soft-pluck-90.beats.json", note: "30 ms attacks, no drums, 8th-note plucks", source: "script-built plucks", licence: "generated" });
  console.log("stress soft pluck");
}

writeFileSync(join(dir, "manifest.json"), JSON.stringify({ tracks }, null, 2));
console.log(`wrote ${tracks.length} tracks to ${dir}`);
