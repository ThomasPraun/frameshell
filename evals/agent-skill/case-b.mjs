#!/usr/bin/env node
// Opt-in eval of the `frameshell` agent skill (not in CI): a fresh `claude -p` session, with nothing but the
// skill that `frameshell init` installs, must complete the SPEC Case B flow on a fixture recording: import,
// transcribe, cut silences with snapping, export, verify. How to run: evals/agent-skill/README.md.
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values: opts } = parseArgs({
  options: {
    model: { type: "string" },
    budget: { type: "string" },
    keep: { type: "boolean", default: false },
    timeout: { type: "string", default: "45" },
  },
});

const repo = fileURLToPath(new URL("../../", import.meta.url));
const cliJs = join(repo, "packages", "cli", "dist", "bin", "frameshell.js");
// Public-domain speech (JFK inaugural address, whisper.cpp's own sample), pinned by hash.
const JFK_URL = "https://raw.githubusercontent.com/ggml-org/whisper.cpp/927cfce34f31707e17f2bff35c349632fb9e2c3a/samples/jfk.wav";
const JFK_SHA256 = "59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e";
// Natural pauses of jfk.wav (after "Americans" and "ask not"); each gets SILENCE_S of silence inserted.
const SPLITS = [2.79, 4.67];
const SILENCE_S = 2.5;

if (process.platform === "win32") fail("The eval runs on macOS and Linux (it writes a POSIX `frameshell` shim).");
if (!existsSync(cliJs)) fail("Build first: pnpm exec tsc -b");
try {
  execFileSync("claude", ["--version"], { stdio: "ignore" });
} catch {
  fail("`claude` (Claude Code) is not on PATH.");
}

// Downloads (ffmpeg, whisper engine and model) are reused across runs; everything else is fresh.
const cache = process.env["FRAMESHELL_EVAL_CACHE"] ?? join(repo, ".cache", "agent-skill-eval");
const work = mkdtempSync(join(tmpdir(), "frameshell-eval-"));
const bin = join(work, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "frameshell"), `#!/bin/sh\nexec "${process.execPath}" "${cliJs}" "$@"\n`);
chmodSync(join(bin, "frameshell"), 0o755);
const env = {
  ...process.env,
  PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}`,
  FRAMESHELL_DATA_DIR: join(cache, "data"),
  FRAMESHELL_CONFIG_DIR: join(work, "config"),
  // Unix socket paths are short; tmpdir() on macOS is not.
  FRAMESHELL_SOCKET: `/tmp/fs-eval-${randomUUID().slice(0, 8)}.sock`,
};
delete env["FRAMESHELL_SESSION"];
delete env["FRAMESHELL_PROJECT"];
delete env["FRAMESHELL_AGENT"];
mkdirSync(env.FRAMESHELL_DATA_DIR, { recursive: true });

/** Run the CLI; parsed stdout with --json. Throws with stderr on a non-zero exit unless `allowFail`. */
function frameshell(args, cwd, { allowFail = false } = {}) {
  try {
    const out = execFileSync(process.execPath, [cliJs, ...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 });
    return args.includes("--json") ? JSON.parse(out) : out;
  } catch (error) {
    if (allowFail && args.includes("--json") && error.stdout) return JSON.parse(error.stdout);
    throw new Error(`frameshell ${args.join(" ")} failed:\n${error.stderr ?? error.message}`, { cause: error });
  }
}

function step(message) {
  console.log(`\n== ${message}`);
}

function fail(message) {
  console.error(`eval: ${message}`);
  process.exit(2);
}

// --- Fixture -------------------------------------------------------------------------------------------------

step(`Setting up in ${work}`);
const doctor = frameshell(["doctor", "--install", "--json"], work);
const ffmpeg = doctor.binaries.find((b) => b.name === "ffmpeg")?.path;
if (!ffmpeg) fail("doctor found no ffmpeg");

const jfk = join(cache, "jfk.wav");
if (!existsSync(jfk)) {
  const bytes = Buffer.from(await (await fetch(JFK_URL)).arrayBuffer());
  writeFileSync(jfk, bytes);
}
if (createHash("sha256").update(readFileSync(jfk)).digest("hex") !== JFK_SHA256) fail(`${jfk} does not match its pinned hash; delete it`);

const footage = join(work, "footage", "talk.mp4");
const footageSeconds = 11 + SPLITS.length * SILENCE_S;
mkdirSync(join(work, "footage"));
const [a, b] = SPLITS;
const graph =
  `[0:a]atrim=0:${a},asetpts=PTS-STARTPTS[p0];[0:a]atrim=${a}:${b},asetpts=PTS-STARTPTS[p1];` +
  `[0:a]atrim=${b},asetpts=PTS-STARTPTS[p2];` +
  `anullsrc=r=16000:cl=mono:d=${SILENCE_S}[s0];anullsrc=r=16000:cl=mono:d=${SILENCE_S}[s1];` +
  `[p0][s0][p1][s1][p2]concat=n=5:v=0:a=1[a]`;
execFileSync(ffmpeg, [
  "-hide_banner", "-loglevel", "error", "-i", jfk, "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30",
  "-filter_complex", graph, "-map", "1:v", "-map", "[a]", "-shortest",
  // Picture exactly as long as the sound: a silent tail would invite an unsnapped cut.
  "-t", String(footageSeconds), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", footage,
]);

// The whisper-cpp plugin from this checkout, installable as a local git repo (npm cannot resolve workspace deps).
const pluginSrc = join(repo, "plugins", "whisper-cpp");
const pluginRepo = join(work, "whisper-cpp");
mkdirSync(pluginRepo);
for (const entry of ["frameshell-plugin.json", "dist", "skills"]) cpSync(join(pluginSrc, entry), join(pluginRepo, entry), { recursive: true });
const { devDependencies: _dev, ...pkg } = JSON.parse(readFileSync(join(pluginSrc, "package.json"), "utf8"));
writeFileSync(join(pluginRepo, "package.json"), JSON.stringify(pkg, null, 2));
const git = (...args) => execFileSync("git", ["-c", "user.name=eval", "-c", "user.email=eval@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: pluginRepo });
git("init", "-q");
git("add", "-A");
git("commit", "-q", "-m", "whisper-cpp");
const pluginSpec = `git+${pathToFileURL(pluginRepo).href}`;

// Warm up in a throwaway project: the first transcription downloads the engine and a 574 MB model.
step("Warming up whisper.cpp (first run downloads ~600 MB into the eval cache)");
const warm = join(work, "warm");
frameshell(["init", warm, "--no-skill"], work);
frameshell(["plugin", "install", pluginSpec], warm);
execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", jfk, "-t", "3", join(warm, "assets", "warm.wav")]);
frameshell(["transcribe", "assets/warm.wav", "--json"], warm);

// The project the agent gets: made by `frameshell init`, so it holds the installed skill and nothing else.
const project = join(work, "project");
frameshell(["init", project, "--name", "Eval talk"], work);
frameshell(["plugin", "install", pluginSpec], project);
if (!existsSync(join(project, ".claude", "skills", "frameshell", "SKILL.md"))) fail("frameshell init did not install the skill");

// --- Session -------------------------------------------------------------------------------------------------

const prompt =
  "This folder is a Frameshell video project. My raw recording is ../footage/talk.mp4 (a short talk in English). " +
  "Edit it: bring it into the project, transcribe it, remove the silences, export it for YouTube at 1080p, " +
  "and check that no words were lost in the cuts. Work on your own until it is done; do not ask me questions.";
const log = join(work, "session.jsonl");
const args = [
  "-p", prompt,
  "--output-format", "stream-json", "--verbose",
  "--permission-mode", "bypassPermissions",
  "--disallowedTools", "WebFetch", "WebSearch",
  "--setting-sources", "project",
  "--strict-mcp-config",
  ...(opts.model ? ["--model", opts.model] : []),
  ...(opts.budget ? ["--max-budget-usd", opts.budget] : []),
];
step(`Running claude -p in ${project} (log: ${log})`);
const code = await new Promise((resolve) => {
  const child = spawn("claude", args, { cwd: project, env, stdio: ["ignore", "pipe", "inherit"] });
  const out = createWriteStream(log);
  child.stdout.pipe(out);
  const timer = setTimeout(() => child.kill("SIGTERM"), Number(opts.timeout) * 60_000);
  child.once("close", (status) => {
    clearTimeout(timer);
    resolve(status);
  });
});
const events = readFileSync(log, "utf8").split("\n").filter(Boolean).flatMap((line) => {
  try {
    return [JSON.parse(line)];
  } catch {
    return [];
  }
});
const toolUses = events.flatMap((event) => (event.type === "assistant" ? event.message?.content ?? [] : [])).filter((part) => part.type === "tool_use");
const commands = toolUses.map((use) => (typeof use.input?.command === "string" ? use.input.command : `${use.name} ${JSON.stringify(use.input)}`));
const result = events.find((event) => event.type === "result");
console.log(`claude exited ${code}; ${toolUses.length} tool calls; ${result?.total_cost_usd !== undefined ? `$${result.total_cost_usd.toFixed(2)}` : "cost unknown"}`);

// --- Checks --------------------------------------------------------------------------------------------------

step("Checking the project");
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

const assets = readdirSync(join(project, "assets")).filter((file) => file.endsWith(".mp4"));
check("footage imported into assets/", assets.length === 1, assets.join(", ") || "none");

const transcripts = existsSync(join(project, "transcripts")) ? readdirSync(join(project, "transcripts")).filter((f) => f.endsWith(".words.json")) : [];
const words = transcripts.length === 1 ? JSON.parse(readFileSync(join(project, "transcripts", transcripts[0]), "utf8")).words.length : 0;
check("transcribed to word level", words >= 15, `${transcripts.join(", ") || "no transcript"}, ${words} words`);

const view = frameshell(["timeline", "show", "--json"], project);
const removed = footageSeconds - (view.duration ?? footageSeconds);
const inserted = SPLITS.length * SILENCE_S;
check(
  "silences removed, speech kept",
  removed >= inserted * 0.7 && removed <= inserted + 1.5,
  `timeline ${view.duration} s from ${footageSeconds} s footage: ${removed.toFixed(2)} s removed, ${inserted} s of silence inserted`,
);

const history = frameshell(["history", "--json"], project);
const cuts = history.transactions.flatMap((tx) => tx.operations.filter((op) => ["cut", "clip.trim", "clip.split", "clip.remove"].includes(op.op)).map((op) => ({ ...op, tx })));
const exact = cuts.filter((op) => op.args.snap === false);
check("cuts snapped to pauses", cuts.length > 0 && exact.length === 0, `${cuts.length} cut operations, ${exact.length} with snapping off`);
const grouped = cuts.length > 0 && cuts.every((op) => op.tx.label !== null);
check("cuts grouped in a labelled transaction", grouped, [...new Set(cuts.map((op) => `${op.tx.tx} ${JSON.stringify(op.tx.label)}`))].join("; "));

const exportsDir = join(project, "exports");
const exported = existsSync(exportsDir) ? readdirSync(exportsDir).filter((file) => file.endsWith(".mp4")) : [];
check("exported for YouTube 1080p", exported.some((file) => file.includes("1080")), exported.join(", ") || "no export");

const ranVerify = commands.some((command) => /transcribe\b.*--verify|transcribe_verify/.test(command));
check("agent ran transcribe --verify", ranVerify, ranVerify ? "yes" : "no verify call in the session");

if (exported.length > 0) {
  const report = frameshell(["transcribe", "--verify", join("exports", exported[0]), "--json"], project, { allowFail: true });
  check("no words lost (independent verify)", report.lost?.length === 0, `lost ${report.lost?.length ?? "?"}, uncertain ${report.uncertain?.length ?? "?"}, agreement ${report.confidence?.toFixed?.(2) ?? "?"}`);
} else {
  check("no words lost (independent verify)", false, "nothing to verify");
}

for (const { name, ok, detail } of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
const passed = checks.every((c) => c.ok);
console.log(`\n${passed ? "Case B completed" : "Case B NOT completed"}. Session log: ${log}`);
if (!opts.keep && passed) rmSync(work, { recursive: true, force: true });
else console.log(`Kept ${work} for inspection.`);
process.exit(passed ? 0 : 1);
