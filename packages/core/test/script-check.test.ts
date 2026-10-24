import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type DaemonConnection, ErrorCode, connectToDaemon } from "@frameshell/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";

// Seam under test: the `script.check` registry method (ADR 0023) through a real in-process daemon and project dir.

const ORIGINAL = "Ana: ¿Cuántas pestañas tenés abiertas?\nJuan: Ninguna la vas a leer.\n";
const hash12 = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);
const shootScript = (sourceHash: string) =>
  [
    "---",
    "title: Launch",
    "shoot: true",
    "source: drafts/guion.txt",
    `source_hash: ${sourceHash}`,
    "---",
    "## Hook (0:00–0:05)",
    "**Ana:** ¿Cuántas pestañas tenés abiertas?",
    "[VISUAL: tabs]",
    "## Problem",
    "**Juan:** Ninguna la vas a leer.",
    "**Pedro:** [FREE: an anecdote]",
  ].join("\n");

let daemon: Daemon;
let conn: DaemonConnection;
let root: string;

beforeEach(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), idleTimeoutMs: Number.POSITIVE_INFINITY });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
  root = join(tempDir(), "launch");
  await conn.request("project.init", { dir: root });
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "drafts"), { recursive: true });
  writeFileSync(join(root, "drafts", "guion.txt"), ORIGINAL);
  writeFileSync(join(root, "scripts", "launch.md"), shootScript(hash12(ORIGINAL)));
});

afterEach(async () => {
  conn.close();
  await daemon.close();
});

describe("script.check", () => {
  it("returns scenes, lines, cues, refs and a fresh source; clean without people.json", async () => {
    const check = await conn.request("script.check", { cwd: join(root, "scripts"), file: "launch.md" });
    expect(check.path).toBe("scripts/launch.md");
    expect(check.shoot).toEqual({ shoot: true, source: "drafts/guion.txt", sourceHash: hash12(ORIGINAL), follow: "words" });
    expect(check.source).toEqual({ path: join(root, "drafts", "guion.txt"), found: true, hash: hash12(ORIGINAL), stale: false });
    expect(check.speakers).toEqual([
      { name: "Ana", person: null, lines: 2 },
      { name: "Juan", person: null, lines: 1 },
      { name: "Pedro", person: null, lines: 1 },
    ]);
    expect(check.scenes.map((scene) => [scene.ref, scene.expected, scene.words])).toEqual([
      ["scripts/launch.md#hook", 5, 4],
      ["scripts/launch.md#problem", null, 5],
    ]);
    expect(check.scenes[1]!.lines[1]!.cues).toEqual([{ label: "FREE", text: "an anecdote", at: 0, free: true }]);
    expect(check.warnings).toEqual([]);
  });

  it("matches speakers to people ignoring case and warns about the unknown ones", async () => {
    const ana = await conn.request("people.add", { cwd: root, name: "ana" });
    await conn.request("people.add", { cwd: root, name: "Juan" });
    const check = await conn.request("script.check", { cwd: root, file: "scripts/launch.md" });
    expect(check.speakers.map((speaker) => [speaker.name, speaker.person !== null])).toEqual([
      ["Ana", true],
      ["Juan", true],
      ["Pedro", false],
    ]);
    expect(check.speakers[0]!.person).toBe(ana.person.id);
    expect(check.warnings).toEqual([expect.stringMatching(/^Speaker "Pedro" matches no person in people\.json \(people: ana, Juan\)/)]);
  });

  it("reports a stale or missing source, never failing", async () => {
    writeFileSync(join(root, "drafts", "guion.txt"), `${ORIGINAL}Pedro: one more line.\n`);
    const stale = await conn.request("script.check", { cwd: root, file: "scripts/launch.md" });
    expect(stale.source).toMatchObject({ found: true, stale: true });
    expect(stale.warnings).toEqual([expect.stringMatching(/^Stale: drafts\/guion\.txt changed/)]);

    writeFileSync(join(root, "scripts", "launch.md"), shootScript(hash12(ORIGINAL)).replace("drafts/guion.txt", "drafts/gone.docx"));
    const missing = await conn.request("script.check", { cwd: root, file: "scripts/launch.md" });
    expect(missing.source).toMatchObject({ found: false, hash: null, stale: null });
    expect(missing.warnings).toEqual([expect.stringMatching(/drafts\/gone\.docx was not found/)]);
  });

  it("checks a script without shoot: true, with a warning, and fails only on a missing file", async () => {
    writeFileSync(join(root, "scripts", "plain.md"), "## Intro\nHola.");
    const plain = await conn.request("script.check", { cwd: root, file: "scripts/plain.md" });
    expect(plain.shoot.shoot).toBe(false);
    expect(plain.source).toBeNull();
    expect(plain.scenes[0]!.lines[0]!.words).toEqual(["Hola"]);
    expect(plain.warnings).toEqual(["Not a shoot script: add `shoot: true` to the frontmatter."]);
    await expect(conn.request("script.check", { cwd: root, file: "scripts/nope.md" })).rejects.toMatchObject({ code: ErrorCode.ScriptNotFound });
  });
});
