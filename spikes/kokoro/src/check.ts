// The misread round trip of the voiceover pipeline over a take set: core's `verifyTakes` with the whisper-cpp
// provider (default model large-v3-turbo-q5_0), so line status is exactly what `voiceover.generate` reports.
// WER = word edits / script words, both sides read by `spokenTokens` (packages/schema/src/spoken.ts: spelled
// numbers, the pipeline's word normalization). whisper.cpp and its model install into WORK_DIR, never the
// user's data dir. Writes results/<tag>.json (numbers only). Usage: node src/check.ts <tag> [<tag> ...]
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SPIKE_ROOT, TEST_BINARIES, WORK_DIR, built } from "./paths.ts";
import { loadSet } from "./takes.ts";

type Progress = { message: string };
const { BinaryManager } = await built<any>("packages/core/dist/binaries/manager.js");
const { verifyTakes } = await built<any>("packages/core/dist/voiceover/verify.js");
const { readPcmWav } = await built<any>("packages/core/dist/transcripts/window.js");
const { spokenTokens } = await built<any>("packages/schema/dist/spoken.js");
const { createWhisperProvider } = await built<any>("plugins/whisper-cpp/dist/index.js");

// ffmpeg from the repo's test cache; whisper.cpp + model into the spike's temp dir (deleted by clean.ts).
const cached = new BinaryManager({ dataDir: TEST_BINARIES, configDir: join(WORK_DIR, "config") });
const spike = new BinaryManager({ dataDir: join(WORK_DIR, "whisper-data"), configDir: join(WORK_DIR, "config") });
let lastLog = 0;
const report = (p: Progress) => {
  if (Date.now() - lastLog > 5000) { console.log(`  ${p.message}`); lastLog = Date.now(); }
};
const tools = {
  ensureBinary: (name: string, onProgress: (p: Progress) => void) =>
    (name === "ffmpeg" || name === "ffprobe" ? cached : spike).ensure(name, undefined, { onProgress }),
  ensureModel: (id: string, onProgress: (p: Progress) => void) => spike.ensureModel(id, { onProgress }),
};

function wordEdits(ref: readonly string[], hyp: readonly string[]): number {
  let row = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const next = [i];
    for (let j = 1; j <= hyp.length; j++) {
      next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[hyp.length]!;
}

for (const tag of process.argv.slice(2)) {
  const set = await loadSet(tag);
  const lang = set.lines[0]!.lang;
  const takes = [];
  for (const line of set.lines) takes.push({ id: line.id, spoken: line.spoken, display: line.display, file: line.file, pcm: await readPcmWav(line.file) });
  const started = performance.now();
  const outcome = await verifyTakes({
    root: join(WORK_DIR, "verify-root"),
    takes,
    language: lang,
    providerId: "whisper-cpp",
    provider: async () => createWhisperProvider(),
    tools,
    progress: report,
    signal: new AbortController().signal,
  });
  const checkS = (performance.now() - started) / 1000;
  if (outcome.verification.status !== "checked") throw new Error(`${tag}: ${outcome.verification.reason}`);
  let edits = 0;
  let words = 0;
  const rows = set.lines.map((line) => {
    const found = outcome.checks.get(line.id);
    const heard = found ? found.words.map((w: { text: string }) => w.text).join(" ") : "";
    // Best of the spoken and display forms, as checkLine does: a respelled name is written as people spell it.
    const forms = [...new Set([line.spoken, line.display])].map((text) => {
      const ref = spokenTokens(text, lang);
      return { ref, edits: wordEdits(ref, spokenTokens(heard, lang)) };
    });
    const best = forms.reduce((a, b) => (b.edits / b.ref.length < a.edits / a.ref.length ? b : a));
    edits += best.edits;
    words += best.ref.length;
    return {
      id: line.id, status: found?.check.status ?? "unchecked", wer: +(best.edits / best.ref.length).toFixed(3), heard,
      misreads: found?.check.misreads.map((m: { kind: string; expected: string; heard: string }) => `${m.kind}: "${m.expected}" -> "${m.heard}"`) ?? [],
      audioS: line.audioS, ms: line.ms, cpuMs: line.cpuMs,
    };
  });
  const result = {
    tag, maker: set.maker, lang, model: outcome.verification.model, wer: +(edits / words).toFixed(4), edits, words,
    clean: rows.filter((r) => r.status === "clean").length, doubtful: outcome.verification.doubtful, misread: outcome.verification.misread,
    checkSeconds: Math.round(checkS), lines: rows,
  };
  await mkdir(join(SPIKE_ROOT, "results"), { recursive: true });
  await writeFile(join(SPIKE_ROOT, "results", `${tag}.json`), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`${tag} (${set.maker}): WER ${(result.wer * 100).toFixed(1)} % (${edits}/${words}), clean ${result.clean}, doubtful ${result.doubtful}, misread ${result.misread}`);
  for (const row of rows) console.log(`  ${row.id} ${row.status.padEnd(8)} wer ${row.wer}  heard: ${row.heard}`);
}
