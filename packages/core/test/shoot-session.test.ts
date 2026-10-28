import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type DaemonConnection, type ShootStatusResult, connectToDaemon } from "@frameshell/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "../src/index.js";
import { TAKE_WORDS_DIR } from "../src/shoot/session.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { mediaTools, run } from "./media-tools.js";

// Seam under test: takes recorded in the app (ADR 0024) through a real daemon and the managed ffmpeg, with the
// stand-in transcriber (`shootStandIn`): Cut on growing `.part` files, the take's words on the session clock and its
// comparison, then the session's end (transcripts, group on the shoot timeline, takes as shots).

const SCRIPT = [
  ...["---", "shoot: true", "---"],
  ...["## Hook", "Hola a todos y bienvenidos al canal de hoy", "Hoy hablamos de cámaras"],
  ...["## Problem", "Nadie lee el manual de su cámara nueva"],
].join("\n");
const SCRIPT_PATH = "scripts/launch.md";
const SESSION = "20261024-153012";
const FOLDER = `assets/shoot/${SESSION}`;
const SOUNDS = [{ asset: `${FOLDER}/mic.m4a`, offset: 0.002 }];

let daemon: Daemon;
let conn: DaemonConnection;
let root: string;

/** A fragmented MP4 like MediaRecorder writes, as a session file still recording (`.part`). */
async function recording(file: string, video: boolean): Promise<void> {
  const { ffmpeg } = await mediaTools();
  const input = video ? ["-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=12", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"] : ["-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=12", "-c:a", "aac"];
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...input, "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", join(root, `${file}.part`)]);
}

async function analyzed(take: string): Promise<ShootStatusResult["takes"][number]> {
  for (let i = 0; i < 300; i++) {
    const status = await conn.request("shoot.status", { cwd: root, script: SCRIPT_PATH });
    const info = status.takes.find((candidate) => candidate.id === take)!;
    if (info.state !== "transcribing") return info;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`take ${take} never analyzed`);
}

beforeEach(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), binaries: (await import("./media-tools.js")).testBinaryManager(), idleTimeoutMs: Number.POSITIVE_INFINITY, shootStandIn: true });
  conn = await connectToDaemon(daemon.socketPath, { client: "desktop/test" });
  root = join(tempDir(), "launch");
  await conn.request("project.init", { dir: root });
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, FOLDER), { recursive: true });
  writeFileSync(join(root, SCRIPT_PATH), SCRIPT);
  await recording(`${FOLDER}/mic.m4a`, false);
  await recording(`${FOLDER}/camera.mp4`, true);
}, 120_000);

afterEach(async () => {
  conn.close();
  await daemon.close();
});

describe("takes recorded in the app", () => {
  it("transcribes a Cut take from the growing file and compares it, then the session end makes transcripts and shots", async () => {
    const cut = await conn.request("shoot.session.cut", { cwd: root, script: SCRIPT_PATH, scene: "hook", session: SESSION, start: 1, end: 4, sounds: SOUNDS });
    expect(cut.job).toMatchObject({ kind: "shoot", asset: `${FOLDER}/mic.m4a` });
    expect(cut.take.session).toEqual({ id: SESSION, start: 1, end: 4, group: null });
    const hook = await analyzed(cut.take.id);
    expect(hook).toMatchObject({ state: "analyzed", transcript: `${TAKE_WORDS_DIR}/${cut.take.id}.json`, scenes: ["hook"] });
    // The stand-in hears the scene without the middle word of its longest line.
    expect(hook.deviations.map((d) => [d.kind, d.expected])).toEqual([["missing", "bienvenidos"]]);
    // Words on the session clock, inside the take's range.
    const words = JSON.parse(readFileSync(join(root, TAKE_WORDS_DIR, `${cut.take.id}.json`), "utf8")).sounds[0].words;
    expect(words.map((w: { text: string }) => w.text)).toEqual(["Hola", "a", "todos", "y", "al", "canal", "de", "hoy", "Hoy", "hablamos", "de", "cámaras"]);
    for (const word of words) expect(word.start).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(root, TAKE_WORDS_DIR, `${cut.take.id}-1.wav`))).toBe(true);

    const second = await conn.request("shoot.session.cut", { cwd: root, script: SCRIPT_PATH, scene: "problem", session: SESSION, start: 5, end: 10, sounds: SOUNDS });
    const problem = await analyzed(second.take.id);
    expect(problem.deviations.map((d) => [d.kind, d.expected])).toEqual([["missing", "de"]]);
    await conn.request("shoot.accept", { cwd: root, script: SCRIPT_PATH, take: cut.take.id });

    // While the session records, its takes wait.
    const waiting = await conn.request("shoot.assemble", { cwd: root, script: SCRIPT_PATH, snap: false });
    expect(waiting.scenes.map((scene) => scene.action)).toEqual(["waiting", "waiting"]);

    renameSync(join(root, `${FOLDER}/mic.m4a.part`), join(root, `${FOLDER}/mic.m4a`));
    renameSync(join(root, `${FOLDER}/camera.mp4.part`), join(root, `${FOLDER}/camera.mp4`));
    const ended = await conn.request("shoot.session.end", {
      cwd: root,
      script: SCRIPT_PATH,
      session: SESSION,
      assets: [`${FOLDER}/camera.mp4`],
      names: ["Camera"],
      mics: [`${FOLDER}/mic.m4a`],
      micNames: ["Mic"],
      soundOf: ["1"],
      offsets: [0, 0.002],
      name: `Shoot ${SESSION}`,
    });
    expect(ended).toMatchObject({ timeline: "launch", group: expect.stringMatching(/^g_/), transcripts: [`transcripts/shoot/${SESSION}/mic.words.json`] });
    const transcript = JSON.parse(readFileSync(join(root, "transcripts", "shoot", SESSION, "mic.words.json"), "utf8"));
    expect(transcript.words.map((w: { text: string }) => w.text)).toEqual(["Hola", "a", "todos", "y", "al", "canal", "de", "hoy", "Hoy", "hablamos", "de", "cámaras", "Nadie", "lee", "el", "manual", "su", "cámara", "nueva"]);
    // On the file's own clock: the session clock minus the mic's offset.
    expect(transcript.words[0].start).toBeCloseTo(words[0].start - 0.002, 3);

    const shown = await conn.request("timeline.show", { cwd: root, timeline: "launch" });
    const program = shown.tracks.find((track) => track.kind === "program")!;
    expect(program.clips.map((clip) => [(clip as { take?: string }).take, (clip as { scriptRef?: string }).scriptRef, (clip as unknown as { shot: string }).shot])).toEqual([
      [cut.take.id, `${SCRIPT_PATH}#hook`, "solo"],
      [second.take.id, `${SCRIPT_PATH}#problem`, "solo"],
    ]);
    const first = program.clips[0] as unknown as { start: number; in: number; out: number };
    expect(first.start).toBe(0);
    expect(first.in).toBeGreaterThan(1);
    expect(first.out).toBeLessThan(4.2);

    const after = await conn.request("shoot.status", { cwd: root, script: SCRIPT_PATH });
    const hookAfter = after.takes.find((take) => take.id === cut.take.id)!;
    expect(hookAfter.session?.group).toBe(ended.group);
    expect(hookAfter.transcript).toBe(`transcripts/shoot/${SESSION}/mic.words.json`);
    expect(hookAfter.deviations).toEqual([expect.objectContaining({ kind: "missing", accepted: true })]);
    expect(after.scenes.map((scene) => scene.state)).toEqual(["done", "deviations"]);
    expect((await conn.request("shoot.assemble", { cwd: root, script: SCRIPT_PATH, snap: false })).scenes.map((scene) => scene.action)).toEqual(["unchanged", "unchanged"]);
  }, 180_000);

  it("analyzes a take cut as the session ends, also one whose run failed, and writes it into the transcripts", async () => {
    const endParams = { cwd: root, script: SCRIPT_PATH, session: SESSION, assets: [`${FOLDER}/camera.mp4`], mics: [`${FOLDER}/mic.m4a`], soundOf: ["1"], offsets: [0, 0.002] };
    // A take whose run failed: its sound file was not there when the job ran.
    renameSync(join(root, `${FOLDER}/mic.m4a.part`), join(root, `${FOLDER}/mic.m4a.aside`));
    const lost = await conn.request("shoot.session.cut", { cwd: root, script: SCRIPT_PATH, scene: "hook", session: SESSION, start: 1, end: 4, sounds: SOUNDS });
    // The status says why, from the failed job.
    expect(await analyzed(lost.take.id)).toMatchObject({ state: "no-transcript", problem: expect.stringContaining("ffmpeg could not cut") });
    renameSync(join(root, `${FOLDER}/mic.m4a.aside`), join(root, `${FOLDER}/mic.m4a.part`));

    // C then End at once: the session's files are finished while the take's job starts.
    const last = await conn.request("shoot.session.cut", { cwd: root, script: SCRIPT_PATH, scene: "problem", session: SESSION, start: 5, end: 10, sounds: SOUNDS });
    renameSync(join(root, `${FOLDER}/mic.m4a.part`), join(root, `${FOLDER}/mic.m4a`));
    renameSync(join(root, `${FOLDER}/camera.mp4.part`), join(root, `${FOLDER}/camera.mp4`));
    const ended = await conn.request("shoot.session.end", endParams);

    expect(ended.transcripts).toEqual([`transcripts/shoot/${SESSION}/mic.words.json`]);
    const transcript = JSON.parse(readFileSync(join(root, "transcripts", "shoot", SESSION, "mic.words.json"), "utf8"));
    expect(transcript.words.map((w: { text: string }) => w.text)).toEqual(["Hola", "a", "todos", "y", "al", "canal", "de", "hoy", "Hoy", "hablamos", "de", "cámaras", "Nadie", "lee", "el", "manual", "su", "cámara", "nueva"]);
    const after = await conn.request("shoot.status", { cwd: root, script: SCRIPT_PATH });
    expect(after.takes.map((take) => [take.id, take.state])).toEqual([
      [lost.take.id, "analyzed"],
      [last.take.id, "analyzed"],
    ]);
  }, 180_000);

  it("refuses a sound file outside assets/ and an unknown scene", async () => {
    await expect(
      conn.request("shoot.session.cut", { cwd: root, script: SCRIPT_PATH, scene: "hook", session: SESSION, start: 0, end: 1, sounds: [{ asset: "../x.m4a", offset: 0 }] }),
    ).rejects.toMatchObject({ message: expect.stringContaining("not a file under assets/") });
    await expect(
      conn.request("shoot.session.cut", { cwd: root, script: SCRIPT_PATH, scene: "nope", session: SESSION, start: 0, end: 1, sounds: SOUNDS }),
    ).rejects.toMatchObject({ message: expect.stringContaining('No scene "nope"') });
  });
});
