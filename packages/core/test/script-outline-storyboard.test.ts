import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type DaemonConnection, connectToDaemon } from "@frameshell/protocol";
import { createTimeline } from "@frameshell/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";

// Seam under test: `script.outline` spans of scenes without placed words (ADR 0015): linked clips, then the
// heading's planned range, through a real in-process daemon and project dir.

let daemon: Daemon;
let conn: DaemonConnection;
let root: string;

/** A generated-clip stand-in: its timing needs no plugin. */
const clip = (id: string, start: number, duration: number, scriptRef?: string) => ({ id, type: "titles", start, duration, ...(scriptRef ? { scriptRef } : {}) });

const writeTimeline = (id: string, clips: ReturnType<typeof clip>[]) =>
  writeFileSync(join(root, "timelines", `${id}.json`), JSON.stringify({ ...createTimeline(id), tracks: [{ id: "t_v", kind: "video", clips }] }));

const write = (...headings: string[]) => writeFileSync(join(root, "scripts", "story.md"), headings.map((heading) => `## ${heading}\nShot.\n`).join("\n"));
const outline = () => conn.request("script.outline", { cwd: root, file: "scripts/story.md" });

beforeEach(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), idleTimeoutMs: Number.POSITIVE_INFINITY });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
  root = join(tempDir(), "story");
  await conn.request("project.init", { dir: root });
  mkdirSync(join(root, "scripts"), { recursive: true });
});

afterEach(async () => {
  conn.close();
  await daemon.close();
});

describe("script.outline spans without words", () => {
  it("spans a scene by the first start to the last end of its linked clips, per timeline", async () => {
    writeTimeline("main", [clip("c_1", 2, 3, "scripts/story.md#proof"), clip("c_2", 8, 2, "scripts/story.md#proof"), clip("c_3", 12, 1, "scripts/story.md#payoff")]);
    writeTimeline("alt", [clip("c_4", 1, 1, "scripts/story.md#proof")]);
    write("Proof", "Payoff", "Empty");
    const { scenes, warnings } = await outline();
    const bySlug = Object.fromEntries(scenes.map((scene) => [scene.slug, scene]));
    expect(bySlug["proof"]!.span).toEqual([
      { timeline: "alt", start: 1, end: 2, words: 0, source: "clips" },
      { timeline: "main", start: 2, end: 10, words: 0, source: "clips" },
    ]);
    expect(bySlug["payoff"]!.span).toEqual([{ timeline: "main", start: 12, end: 13, words: 0, source: "clips" }]);
    expect(bySlug["empty"]!.span).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("keeps the words span where a timeline places the words, and fills the other timelines from clips", async () => {
    mkdirSync(join(root, "transcripts"), { recursive: true });
    const words = Array.from({ length: 4 }, (_, i) => ({ id: `w_00000${i + 1}`, text: `p${i + 1}`, start: i, end: i + 0.8 }));
    const transcript = { schemaVersion: 1, asset: "assets/talk.wav", assetHash: `sha256:${"b".repeat(64)}`, provider: "fake", model: "m", words, edits: {}, nextWordId: 5 };
    writeFileSync(join(root, "transcripts", "talk.words.json"), JSON.stringify(transcript));
    const talk = { ...createTimeline("talk"), tracks: [{ id: "a1", kind: "audio", clips: [{ id: "c_t", type: "media", asset: "assets/talk.wav", start: 5, in: 0, out: 4 }] }] };
    writeFileSync(join(root, "timelines", "talk.json"), JSON.stringify(talk));
    writeTimeline("main", [clip("c_1", 20, 2, "scripts/story.md#intro")]);
    writeFileSync(join(root, "scripts", "story.md"), "## Intro\n<!-- words: w_000001..w_000004 -->\nHi.\n");
    const [intro] = (await outline()).scenes;
    expect(intro!.span).toEqual([
      { timeline: "talk", start: 5, end: 8.8, words: 4, source: "words" },
      { timeline: "main", start: 20, end: 22, words: 0, source: "clips" },
    ]);
  });

  it("plans a scene with no clip from its heading's clock range, on main only", async () => {
    writeTimeline("main", []);
    write("Hook (0:00-0:06)", "Proof (bars 4-9, 0:06-0:18)", "Reversed (0:30-0:20)");
    const { scenes, warnings } = await outline();
    expect(scenes.map((scene) => scene.span)).toEqual([
      [{ timeline: "main", start: 0, end: 6, words: 0, source: "planned" }],
      [{ timeline: "main", start: 6, end: 18, words: 0, source: "planned" }],
      [],
    ]);
    expect(warnings).toEqual([expect.stringMatching(/Line 7: heading range ends before it starts/)]);
  });

  it("reads bars through the main timeline's tempo", async () => {
    writeTimeline("main", []);
    await conn.request("tempo.set", { cwd: root, bpm: 120 });
    write("Proof (bars 4-9)", "Single (bar 2)", "Refs (bar:10-bar:12)");
    const { scenes, warnings } = await outline();
    // 120 BPM in 4/4: a bar is 2 s, so bars 4-9 are 6-18 s.
    expect(scenes.map((scene) => scene.span)).toEqual([
      [{ timeline: "main", start: 6, end: 18, words: 0, source: "planned" }],
      [{ timeline: "main", start: 2, end: 4, words: 0, source: "planned" }],
      [{ timeline: "main", start: 18, end: 22, words: 0, source: "planned" }],
    ]);
    expect(warnings).toEqual([]);
  });

  it("warns, and plans nothing, when bars cannot be read: no tempo, or no main timeline", async () => {
    writeTimeline("main", []);
    write("Proof (bars 4-9)");
    const noTempo = await outline();
    expect(noTempo.scenes[0]!.span).toEqual([]);
    expect(noTempo.warnings).toEqual([expect.stringMatching(/Scene "proof-bars-4-9": heading range bar:4\.\.bar:10 cannot be placed on main: /)]);
    rmSync(join(root, "timelines", "main.json"));
    const missing = await outline();
    expect(missing.scenes[0]!.span).toEqual([]);
    expect(missing.warnings).toEqual([expect.stringMatching(/Scene "proof-bars-4-9": heading range bar:4\.\.bar:10 cannot be placed on main/)]);
  });

  it("plans nothing once a clip is linked to the scene on any timeline", async () => {
    writeTimeline("main", []);
    writeTimeline("alt", [clip("c_a", 3, 2, "scripts/story.md#hook-000-006")]);
    write("Hook (0:00-0:06)");
    const [hook] = (await outline()).scenes;
    expect(hook!.slug).toBe("hook-000-006");
    expect(hook!.span).toEqual([{ timeline: "alt", start: 3, end: 5, words: 0, source: "clips" }]);
  });
});
