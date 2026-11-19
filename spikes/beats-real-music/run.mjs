// Real-music check of the DSP beat detector (#689). Reads a directory of audio plus manifest.json, decodes each file
// with the managed ffmpeg like the product does, runs analysePcm from the built core and prints, per track, the
// detected tempo against the expected one (octave-aware), the confidence and the beat residual against the truth.
//
//   FRAMESHELL_BEATS_MUSIC_DIR=<dir outside the repo> node run.mjs [--json] [--only <substring>]
//   node run.mjs <dir> ...
//
// manifest.json: { "tracks": [{ file, bpm, firstBeat?, beats?, beatsFile?, hint?, decode?, group?, source?, licence?,
//   informational?, note? }] }. `beats` (seconds) or `beatsFile` (a beats file with a `beats` array) is exact truth;
// else `firstBeat` + `bpm` make a straight grid; with neither only the tempo is judged. `informational: true` tracks
// (rubato, no clean BPM) are reported but never counted as failures.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { decode, loadCore, outsideRepo } from "./lib.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const positional = args.filter((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--only");
const dirArg = positional[0] ?? process.env.FRAMESHELL_BEATS_MUSIC_DIR;
if (!dirArg) {
  console.error("usage: FRAMESHELL_BEATS_MUSIC_DIR=<dir> node run.mjs   (a directory outside the repo with manifest.json)");
  process.exit(2);
}
const dir = outsideRepo(dirArg);
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
const { analysePcm } = await loadCore("media/beats.js");

/** Fraction of the expected tempo within which a result counts as that octave. */
const TEMPO_TOLERANCE = 0.03;
/** Synthetic tracks must keep the beat grid this close to the truth (the #458 bar, p95). */
export const GRID_BUDGET_MS = 15;

const tempoClass = (bpm, expected) => {
  const ratio = bpm / expected;
  const near = (target) => Math.abs(ratio / target - 1) <= TEMPO_TOLERANCE;
  if (near(1)) return "exact";
  if (near(2)) return "double";
  if (near(0.5)) return "half";
  return "wrong";
};

/** Signed gap (other - time, seconds) to the member of `sorted` nearest to `time`. */
const nearestSigned = (sorted, time) => {
  let low = 0;
  let high = sorted.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sorted[mid] < time) low = mid + 1;
    else high = mid;
  }
  let best = Infinity;
  for (const index of [low - 1, low]) if (index >= 0 && index < sorted.length && Math.abs(sorted[index] - time) < Math.abs(best)) best = sorted[index] - time;
  return best;
};

const percentile = (values, p) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
};

function truthOf(track, duration) {
  if (track.beats) return track.beats;
  if (track.beatsFile) return JSON.parse(readFileSync(join(dir, track.beatsFile), "utf8")).beats;
  if (track.firstBeat !== undefined && track.bpm) {
    const period = 60 / track.bpm;
    const out = [];
    for (let time = track.firstBeat; time < duration; time += period) out.push(time);
    return out;
  }
  return null;
}

/**
 * Residual in ms of the detected beats against the truth, by the octave the detector landed on: median and p95 of
 * the absolute gap, the signed median (detected minus true, positive = late: a constant bias), and drift = signed median of the last third minus the first
 * third (a tempo that is slightly off walks away from the truth).
 */
function residuals(beats, truth, cls) {
  if (!truth || truth.length < 2 || beats.length < 2) return null;
  const from = beats[0];
  const to = beats[beats.length - 1];
  const sortedTruth = [...truth].sort((a, b) => a - b);
  const sortedBeats = [...beats].sort((a, b) => a - b);
  // Doubled grid: every true beat has a detected beat; otherwise every detected beat should sit on a true one.
  const pairs =
    cls === "double"
      ? sortedTruth.filter((time) => time >= from - 0.05 && time <= to + 0.05).map((time) => ({ time, gap: nearestSigned(sortedBeats, time) }))
      : sortedBeats.map((time) => ({ time, gap: -nearestSigned(sortedTruth, time) }));
  if (pairs.length === 0) return null;
  const ms = pairs.map((pair) => Math.abs(pair.gap) * 1000);
  const third = Math.max(1, Math.floor(pairs.length / 3));
  const signed = (list) => percentile(list.map((pair) => pair.gap * 1000), 0.5);
  return {
    medianMs: percentile(ms, 0.5),
    p95Ms: percentile(ms, 0.95),
    biasMs: signed(pairs),
    driftMs: signed(pairs.slice(-third)) - signed(pairs.slice(0, third)),
    n: ms.length,
  };
}

const decoded = new Map();
async function analyse(file, mode, hint) {
  const key = `${file}|${mode}`;
  if (!decoded.has(key)) decoded.set(key, await decode(join(dir, file), mode));
  const audio = decoded.get(key);
  const started = performance.now();
  const result = analysePcm({ ...audio, hint });
  return { result, audio, seconds: (performance.now() - started) / 1000 };
}

const rows = [];
for (const track of manifest.tracks) {
  if (only && !track.file.includes(only)) continue;
  const mode = track.decode ?? "sidecar";
  const row = { file: track.name ?? track.file, group: track.group ?? "", expectedBpm: track.bpm ?? null, informational: Boolean(track.informational), source: track.source ?? null, licence: track.licence ?? null };
  try {
    const { result, audio, seconds } = await analyse(track.file, mode, track.hint);
    const duration = audio.pcm.byteLength / (2 * audio.channels * audio.rate);
    row.duration = Math.round(duration * 10) / 10;
    row.seconds = Math.round(seconds * 100) / 100;
    if (!result.ok) {
      row.error = result.reason;
      row.outcome = "no-grid";
    } else {
      const a = result.analysis;
      row.bpm = a.bpm;
      row.confidence = a.confidence;
      row.low = a.confidence < 0.5;
      row.alternatives = a.alternatives.map((alt) => `${alt.tempo}:${alt.bpm}`);
      row.downbeat = a.downbeat;
      const cls = track.bpm ? tempoClass(a.bpm, track.bpm) : "n/a";
      row.tempo = cls;
      const truth = truthOf(track, duration);
      const res = residuals(a.beats, truth, cls);
      if (res) Object.assign(row, res);
      const accepted = new Set(["exact", ...(track.acceptOctave ?? [])]);
      // A wrong octave is fixable with `edits.tempo` when the detector's own alternatives list the expected tempo.
      const listed = track.bpm && a.alternatives.some((alt) => tempoClass(alt.bpm, track.bpm) === "exact");
      row.fixableByEdit = cls === "double" || cls === "half" || Boolean(listed);
      if (cls === "exact" && res && res.p95Ms <= GRID_BUDGET_MS) row.outcome = "ok";
      else if (cls === "exact" && res && Math.abs(res.driftMs) > 30) row.outcome = "drift";
      else if (cls === "exact" && res && res.medianMs > 40) row.outcome = "phase";
      else if (cls === "exact") row.outcome = res && track.group?.startsWith("synthetic") ? "grid>15ms" : "ok";
      else if (cls === "n/a") row.outcome = "no-truth";
      else row.outcome = accepted.has(cls) ? "ok" : cls === "wrong" ? "wrong" : `octave-${cls}`;
      if (cls !== "exact" && cls !== "n/a" && track.bpm) {
        const hinted = await analyse(track.file, mode, track.bpm);
        row.withHint = hinted.result.ok ? tempoClass(hinted.result.analysis.bpm, track.bpm) : "no-grid";
      }
    }
  } catch (error) {
    row.error = String(error.message ?? error);
    row.outcome = "error";
  }
  rows.push(row);
  if (!flag("--json")) {
    const f = (v, d = 1) => (v === null || v === undefined ? "-" : typeof v === "number" ? v.toFixed(d) : v);
    console.log(
      [
        row.file.padEnd(44),
        `exp ${f(row.expectedBpm, 1).padStart(6)}`,
        `got ${f(row.bpm, 2).padStart(7)}`,
        (row.tempo ?? "-").padEnd(6),
        `conf ${f(row.confidence, 2)}${row.low ? "*LOW" : "    "}`,
        `res med ${f(row.medianMs).padStart(6)} p95 ${f(row.p95Ms).padStart(6)} bias ${f(row.biasMs).padStart(6)} drift ${f(row.driftMs).padStart(6)} ms`,
        row.outcome + (row.withHint ? ` (hint -> ${row.withHint})` : ""),
        row.alternatives?.length ? `alt ${row.alternatives.join(",")}` : "",
        row.error ? `[${row.error}]` : "",
      ].join("  "),
    );
  }
}

const counted = rows.filter((row) => !row.informational);
const tally = {};
for (const row of counted) tally[row.outcome] = (tally[row.outcome] ?? 0) + 1;
const byGroup = {};
for (const row of counted) {
  const entry = (byGroup[row.group || "-"] ??= { tracks: 0 });
  entry.tracks++;
  entry[row.outcome] = (entry[row.outcome] ?? 0) + 1;
  if (row.low) entry.low = (entry.low ?? 0) + 1;
}
const summary = {
  byGroup,
  tracks: rows.length,
  counted: counted.length,
  informational: rows.length - counted.length,
  outcomes: tally,
  lowRate: counted.length ? counted.filter((row) => row.low).length / counted.length : 0,
};
writeFileSync(join(dir, "results.json"), JSON.stringify({ summary, rows }, null, 2));
if (flag("--json")) console.log(JSON.stringify({ summary, rows }, null, 2));
else console.log("\n" + JSON.stringify(summary));
