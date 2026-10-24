import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type DaemonConnection, ErrorCode, connectToDaemon } from "@frameshell/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";

// Seam under test: the `shoot.*` registry methods (ADR 0023) through a real in-process daemon, with hand-written transcripts.

const SCRIPT = ["---", "shoot: true", "---", "## Hook", "**Ana:** Cuántas pestañas tenés abiertas", "## Problem", "**Ana:** Ninguna la vas a leer"].join("\n");

let daemon: Daemon;
let conn: DaemonConnection;
let root: string;

/** A take file plus its transcript: 0.4 s per word. */
function take(name: string, said: string) {
  const bytes = `fake media ${name}`;
  writeFileSync(join(root, "assets", `${name}.wav`), bytes);
  const words = said.split(" ").map((text, index) => ({ id: `w_${String(index + 1).padStart(6, "0")}`, text, start: index * 0.4, end: index * 0.4 + 0.35 }));
  const transcript = {
    schemaVersion: 1,
    asset: `assets/${name}.wav`,
    assetHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    provider: "test",
    model: "test",
    language: "es",
    words,
  };
  writeFileSync(join(root, "transcripts", `${name}.words.json`), JSON.stringify(transcript));
  return `assets/${name}.wav`;
}

const status = () => conn.request("shoot.status", { cwd: root, script: "scripts/launch.md" });

beforeEach(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), idleTimeoutMs: Number.POSITIVE_INFINITY });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
  root = join(tempDir(), "launch");
  await conn.request("project.init", { dir: root });
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "transcripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "launch.md"), SCRIPT);
});

afterEach(async () => {
  conn.close();
  await daemon.close();
});

describe("shoot.*", () => {
  it("adds a take, compares it, and walks a scene from deviations to done by accepting", async () => {
    expect((await status()).scenes.map((scene) => scene.state)).toEqual(["none", "none"]);
    const added = await conn.request("shoot.add", { cwd: root, script: "scripts/launch.md", asset: take("hook1", "cuántas pestañas tenés cerradas") });
    expect(added.file).toBe("shoots/launch.json");
    expect(added.take).toMatchObject({ scene: "hook", state: "analyzed", scenes: ["hook"], transcript: "transcripts/hook1.words.json" });
    expect(added.take.deviations).toMatchObject([{ kind: "changed", expected: "abiertas", heard: "cerradas", accepted: false }]);

    let now = await status();
    expect(now.scenes[0]).toMatchObject({ state: "deviations", chosen: added.take.id, picked: false, pending: 1 });
    expect(now.next).toBe("hook");
    const accepted = await conn.request("shoot.accept", { cwd: root, script: "scripts/launch.md", take: added.take.id });
    expect(accepted.deviations).toEqual([added.take.deviations[0]!.id]);
    now = await status();
    expect(now.scenes[0]).toMatchObject({ state: "done", pending: 0 });
    expect(now.takes[0]!.deviations[0]).toMatchObject({ accepted: true, acceptedBy: expect.any(String) });
    expect(now.next).toBe("problem");

    await conn.request("shoot.accept", { cwd: root, script: "scripts/launch.md", take: added.take.id, undo: true });
    expect((await status()).scenes[0]!.state).toBe("deviations");
    const file = JSON.parse(readFileSync(join(root, "shoots", "launch.json"), "utf8"));
    expect(file).toMatchObject({ schemaVersion: 1, script: "scripts/launch.md", takes: [{ id: added.take.id, asset: "assets/hook1.wav", scene: "hook" }], accepted: [] });
  });

  it("chooses the newest take by default, lets the person pick another, and discards", async () => {
    const first = await conn.request("shoot.add", { cwd: root, script: "scripts/launch.md", asset: take("a", "cuántas pestañas tenés abiertas"), recordedAt: "2026-10-24T10:00:00Z" });
    const second = await conn.request("shoot.add", { cwd: root, script: "scripts/launch.md", asset: take("b", "cuántas pestañas tenés abiertas ninguna la vas a leer"), recordedAt: "2026-10-24T11:00:00Z" });
    let now = await status();
    expect(now.scenes.map((scene) => [scene.chosen, scene.state])).toEqual([
      [second.take.id, "done"],
      [second.take.id, "done"],
    ]);
    expect(now.next).toBeNull();
    const chose = await conn.request("shoot.choose", { cwd: root, script: "scripts/launch.md", scene: "hook", take: first.take.id });
    expect(chose.previous).toBeNull();
    now = await status();
    expect(now.scenes[0]).toMatchObject({ chosen: first.take.id, picked: true, takes: [first.take.id, second.take.id] });
    await expect(conn.request("shoot.choose", { cwd: root, script: "scripts/launch.md", scene: "problem", take: first.take.id })).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      data: { reason: "take does not cover scene" },
    });

    await conn.request("shoot.discard", { cwd: root, script: "scripts/launch.md", take: first.take.id });
    now = await status();
    expect(now.scenes[0]).toMatchObject({ chosen: second.take.id, picked: false, takes: [second.take.id] });
    expect(now.takes[0]!.discarded).toBe(true);
    await conn.request("shoot.discard", { cwd: root, script: "scripts/launch.md", take: first.take.id, restore: true });
    expect((await status()).takes[0]!.discarded).toBe(false);
  });

  it("says what a take needs when its asset has no transcript, and fails on unknown scenes and takes", async () => {
    writeFileSync(join(root, "assets", "raw.wav"), "x");
    const added = await conn.request("shoot.add", { cwd: root, script: "scripts/launch.md", asset: "assets/raw.wav", scene: "problem" });
    expect(added.take).toMatchObject({ state: "no-transcript", problem: expect.stringMatching(/frameshell transcribe assets\/raw\.wav/), deviations: [] });
    await expect(conn.request("shoot.accept", { cwd: root, script: "scripts/launch.md", take: added.take.id })).rejects.toMatchObject({ data: { reason: "not analyzed" } });
    await expect(conn.request("shoot.add", { cwd: root, script: "scripts/launch.md", asset: "assets/raw.wav", scene: "nope" })).rejects.toMatchObject({ data: { reason: "unknown scene" } });
    await expect(conn.request("shoot.discard", { cwd: root, script: "scripts/launch.md", take: "k_000000" })).rejects.toMatchObject({ data: { reason: "unknown take" } });
    await expect(conn.request("shoot.add", { cwd: root, script: "scripts/launch.md", asset: "assets/none.wav" })).rejects.toMatchObject({ code: ErrorCode.AssetNotFound });
  });

  it("keeps an acceptance across re-analysis while the line and heard words stay, caches comparisons and sweeps stale ones", async () => {
    const added = await conn.request("shoot.add", { cwd: root, script: "scripts/launch.md", asset: take("c", "cuántas pestañas tenés cerradas") });
    await conn.request("shoot.accept", { cwd: root, script: "scripts/launch.md", take: added.take.id });
    writeFileSync(join(root, "scripts", "launch.md"), `${SCRIPT}\n**Juan:** Nunca.`);
    expect((await status()).scenes[0]!.state).toBe("done");
    writeFileSync(join(root, "scripts", "launch.md"), SCRIPT.replace("tenés abiertas", "tenés abiertas ahora"));
    expect((await status()).scenes[0]!.state).toBe("deviations");
    const cached = readdirSync(join(root, ".frameshell", "shoot"));
    expect(cached).toHaveLength(3);
    const gc = await conn.request("gc", { cwd: root, dryRun: true });
    expect(gc.removed.filter((entry) => entry.kind === "shoot")).toHaveLength(2);
  });
});
