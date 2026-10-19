import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type DaemonConnection, ErrorCode, connectToDaemon } from "@frameshell/protocol";
import { createTimeline } from "@frameshell/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "../src/index.js";
import { MAX_SCRIPT_BYTES } from "../src/scripts/outline.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";

// Seam under test: the `script.outline` registry method and `scriptRef` checks
// of `clip.add`/`clip.set`, through a real in-process daemon and project dir.

const SCRIPT = ["---", "title: Launch", "target_duration: 45", "aspect: '9:16'", "---", "## Intro", "Hola.", "## Demo", "Show it.", "## Outro", "Bye."].join("\n");

/** Hand-written adapter clip: its timing needs no plugin, so none is loaded. */
function titleClip(id: string, start: number, scriptRef?: string) {
  return { id, type: "titles", start, duration: 1, ...(scriptRef ? { scriptRef } : {}) };
}

let daemon: Daemon;
let conn: DaemonConnection;
let root: string;

beforeEach(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), idleTimeoutMs: Number.POSITIVE_INFINITY });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
  root = join(tempDir(), "launch");
  await conn.request("project.init", { dir: root });
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "launch.md"), SCRIPT);
  const main = {
    ...createTimeline("main"),
    tracks: [
      {
        id: "t_v",
        kind: "video",
        clips: [
          titleClip("c_a", 0, "scripts/launch.md#intro"),
          titleClip("c_b", 2, "scripts/launch.md#intro"),
          titleClip("c_gone", 4, "scripts/launch.md#cut-scene"),
          titleClip("c_free", 6),
          titleClip("c_whole", 8, "scripts/launch.md"),
        ],
      },
    ],
  };
  const intro = { ...createTimeline("intro"), tracks: [{ id: "t_x", kind: "video", clips: [titleClip("c_n", 0, "scripts/launch.md#demo")] }] };
  writeFileSync(join(root, "timelines", "main.json"), JSON.stringify(main));
  writeFileSync(join(root, "timelines", "intro.json"), JSON.stringify(intro));
  const filler = { ...createTimeline("filler"), tracks: [{ id: "t_f", kind: "video", clips: [titleClip("c_f", 0)] }] };
  writeFileSync(join(root, "timelines", "filler.json"), JSON.stringify(filler));
});

afterEach(async () => {
  conn.close();
  await daemon.close();
});

describe("script.outline", () => {
  it("returns frontmatter, scenes with refs, and the clips of every timeline linked to each scene", async () => {
    const outline = await conn.request("script.outline", { cwd: join(root, "scripts"), file: "launch.md" });
    expect(outline.path).toBe("scripts/launch.md");
    expect(outline.meta).toEqual({ title: "Launch", targetDuration: 45, aspect: "9:16" });
    expect(outline.scenes.map(({ slug, ref, line, clips }) => ({ slug, ref, line, clips }))).toEqual([
      { slug: "intro", ref: "scripts/launch.md#intro", line: 6, clips: [{ timeline: "main", clip: "c_a" }, { timeline: "main", clip: "c_b" }] },
      { slug: "demo", ref: "scripts/launch.md#demo", line: 8, clips: [{ timeline: "intro", clip: "c_n" }] },
      { slug: "outro", ref: "scripts/launch.md#outro", line: 10, clips: [] },
    ]);
    expect(outline.clips).toEqual([{ timeline: "main", clip: "c_whole" }]);
    expect(outline.unresolved).toEqual([{ timeline: "main", clip: "c_gone", scriptRef: "scripts/launch.md#cut-scene" }]);
    expect(outline.warnings).toEqual([]);
  });

  it("resolves the file from the project root too, and skips unreadable timelines with a warning", async () => {
    writeFileSync(join(root, "timelines", "broken.json"), "{ nope");
    const outline = await conn.request("script.outline", { cwd: join(root, "assets"), file: "scripts/launch.md" });
    expect(outline.path).toBe("scripts/launch.md");
    expect(outline.warnings).toEqual([expect.stringMatching(/timelines\/broken\.json.*skipped/)]);
  });

  it("fails with ScriptNotFound listing the scripts there are", async () => {
    await expect(conn.request("script.outline", { cwd: root, file: "scripts/nope.md" })).rejects.toMatchObject({
      code: ErrorCode.ScriptNotFound,
      data: { path: "scripts/nope.md", available: ["scripts/launch.md"] },
    });
  });

  it("refuses files outside the project", async () => {
    const outside = join(tempDir(), "x.md");
    writeFileSync(outside, "## A\n");
    await expect(conn.request("script.outline", { cwd: root, file: outside })).rejects.toMatchObject({ code: ErrorCode.OutsideProject });
  });
});

describe("scriptRef on clip operations", () => {
  const set = (scriptRef: string | null) => conn.request("clip.set", { cwd: root, clip: "c_free", scriptRef });

  it("stores a ref to an existing scene without warnings", async () => {
    const result = await set("scripts/launch.md#outro");
    expect(result.warnings).toEqual([]);
    const view = await conn.request("timeline.show", { cwd: root });
    expect(view.tracks[0]!.clips.find((clip) => clip.id === "c_free")).toMatchObject({ scriptRef: "scripts/launch.md#outro" });
  });

  it("stores a ref to a missing scene or script but warns with what exists", async () => {
    const missingScene = await set("scripts/launch.md#Outro");
    expect(missingScene.revision).toBeGreaterThan(0);
    expect(missingScene.warnings).toEqual([expect.stringMatching(/no scene "Outro" in scripts\/launch\.md.*intro, demo, outro/)]);

    const missingFile = await set("scripts/later.md#intro");
    expect(missingFile.warnings).toEqual([expect.stringMatching(/scripts\/later\.md does not exist/)]);

    const view = await conn.request("timeline.show", { cwd: root });
    expect(view.tracks[0]!.clips.find((clip) => clip.id === "c_free")).toMatchObject({ scriptRef: "scripts/later.md#intro" });
  });

  it("takes a ref without anchor as the whole script: no warning when the file exists, a warning when it is missing", async () => {
    const whole = await set("./scripts/launch.md");
    expect(whole.warnings).toEqual([]);
    const outline = await conn.request("script.outline", { cwd: root, file: "scripts/launch.md" });
    expect(outline.clips).toEqual([
      { timeline: "main", clip: "c_free" },
      { timeline: "main", clip: "c_whole" },
    ]);
    expect(outline.unresolved.map(({ clip }) => clip)).toEqual(["c_gone"]);

    const missing = await set("scripts/later.md");
    expect(missing.warnings).toEqual([expect.stringMatching(/scripts\/later\.md does not exist/)]);
    const view = await conn.request("timeline.show", { cwd: root });
    expect(view.tracks[0]!.clips.find((clip) => clip.id === "c_free")).toMatchObject({ scriptRef: "scripts/later.md" });
  });

  it("warns on a whole-script ref that is no scripts/**/*.md, and only stats the script", async () => {
    writeFileSync(join(root, "assets", "notes.md"), "## A\n");
    expect((await set("assets/notes.md")).warnings).toEqual([expect.stringMatching(/assets\/notes\.md is not a script \(scripts live at/)]);
    expect((await set("scripts/launch.json")).warnings).toEqual([expect.stringMatching(/is not a script/)]);
    mkdirSync(join(root, "scripts", "folder.md"));
    expect((await set("scripts/folder.md")).warnings).toEqual([expect.stringMatching(/is a directory, not a script/)]);
    // Existence only: a script too big to outline is still a valid whole-script target.
    writeFileSync(join(root, "scripts", "long.md"), Buffer.alloc(MAX_SCRIPT_BYTES + 1, "a"));
    expect((await set("scripts/long.md")).warnings).toEqual([]);
  });

  it("checks refs given to clip.add and never warns when clearing", async () => {
    const added = await conn.request("clip.add", {
      cwd: root,
      track: "t_v",
      type: "timeline",
      source: "timelines/filler.json",
      duration: 1,
      start: 10,
      scriptRef: "scripts/launch.md#nope",
    });
    expect(added.warnings).toHaveLength(1);
    expect((await set(null)).warnings).toEqual([]);
    expect((await conn.request("clip.set", { cwd: root, clip: "c_free", gain: -3 })).warnings).toEqual([]);
  });

  it("refuses refs that leave the project, stores nothing and reads nothing outside", async () => {
    writeFileSync(join(root, "..", "outside.md"), "## Secret heading\n");
    const before = (await conn.request("timeline.show", { cwd: root })).revision;
    for (const ref of ["scripts/../../outside.md#x", "../outside.md#x", "scripts\\..\\..\\outside.md#x", "/etc/hosts#x", "C:/x.md#x"]) {
      const error = await set(ref).then(() => null, (reason: unknown) => reason as Error);
      expect(error, ref).toMatchObject({ code: ErrorCode.InvalidOperation, data: { field: "scriptRef" } });
      expect(error!.message).not.toMatch(/secret/i);
    }
    await expect(
      conn.request("clip.add", { cwd: root, track: "t_v", type: "titles", duration: 1, start: 10, scriptRef: "scripts/../../outside.md#x" }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidOperation });
    const view = await conn.request("timeline.show", { cwd: root });
    expect(view.revision).toBe(before);
    expect(view.tracks[0]!.clips.find((clip) => clip.id === "c_free")).not.toHaveProperty("scriptRef");
  });

  it.skipIf(process.platform === "win32")("warns without reading a script symlinked outside the project", async () => {
    const outside = join(tempDir(), "secret.md");
    writeFileSync(outside, "## Secret heading\n");
    symlinkSync(outside, join(root, "scripts", "link.md"));
    const result = await set("scripts/link.md#x");
    expect(result.warnings).toEqual([expect.stringMatching(/scripts\/link\.md resolves outside the project/)]);
    expect(result.warnings[0]).not.toMatch(/secret/i);
  });

  it("warns, never fails, when the script is a directory or too big", async () => {
    mkdirSync(join(root, "scripts", "dir.md"));
    expect((await set("scripts/dir.md#x")).warnings).toEqual([expect.stringMatching(/scripts\/dir\.md is a directory/)]);
    writeFileSync(join(root, "assets", "big.md"), Buffer.alloc(MAX_SCRIPT_BYTES + 1, "a"));
    const big = await set("assets/big.md#x");
    expect(big.warnings).toEqual([expect.stringMatching(/assets\/big\.md is \d+ bytes; scripts are at most/)]);
    const view = await conn.request("timeline.show", { cwd: root });
    expect(view.tracks[0]!.clips.find((clip) => clip.id === "c_free")).toMatchObject({ scriptRef: "assets/big.md#x" });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "warns, never fails, when the script cannot be read; the committed edit is reported as applied",
    async () => {
      const locked = join(root, "scripts", "locked.md");
      writeFileSync(locked, "## X\n");
      chmodSync(locked, 0o000);
      try {
        const result = await set("scripts/locked.md#x");
        expect(result.warnings).toEqual([expect.stringMatching(/scripts\/locked\.md could not be read \(EACCES\)/)]);
        expect((await conn.request("timeline.show", { cwd: root })).revision).toBe(result.revision);
      } finally {
        chmodSync(locked, 0o644);
      }
    },
  );

  it.skipIf(process.platform === "win32")("never blocks on a FIFO: the ref warns and later edits on the timeline run", async () => {
    execFileSync("mkfifo", [join(root, "scripts", "pipe.md")]);
    const result = await set("scripts/pipe.md#x");
    expect(result.warnings).toEqual([expect.stringMatching(/scripts\/pipe\.md is not a regular file/)]);
    expect((await conn.request("clip.set", { cwd: root, clip: "c_free", gain: -3 })).revision).toBe(result.revision + 1);
    await expect(conn.request("script.outline", { cwd: root, file: "scripts/pipe.md" })).rejects.toMatchObject({
      code: ErrorCode.ScriptNotFound,
      message: expect.stringMatching(/scripts\/pipe\.md is not a regular file/),
    });
  }, 10_000);
});

describe("script.outline word ranges (ADR 0015)", () => {
  const ids = (from: number, to: number) => ({ from: `w_${String(from).padStart(6, "0")}`, to: `w_${String(to).padStart(6, "0")}` });

  /** Ten words, one per second from 0, on `assets/talk.wav`; cut and placed by the timeline below. */
  function writeTalk(): void {
    mkdirSync(join(root, "transcripts"), { recursive: true });
    const words = Array.from({ length: 10 }, (_, i) => ({ id: `w_${String(i + 1).padStart(6, "0")}`, text: `p${i + 1}`, start: i, end: i + 0.8 }));
    const transcript = { schemaVersion: 1, asset: "assets/talk.wav", assetHash: `sha256:${"b".repeat(64)}`, provider: "fake", model: "m", words, edits: {}, nextWordId: 11 };
    writeFileSync(join(root, "transcripts", "talk.words.json"), JSON.stringify(transcript));
  }

  function writeCut(): void {
    // Source 0-4 s on the timeline at 0, a gap, then source 6-10 s at 20 s (words 5 and 6 cut out).
    const talk = {
      ...createTimeline("talk"),
      tracks: [
        {
          id: "a1",
          kind: "audio",
          clips: [
            { id: "c_1", type: "media", asset: "assets/talk.wav", start: 0, in: 0, out: 4 },
            { id: "c_2", type: "media", asset: "assets/talk.wav", start: 20, in: 6, out: 10 },
          ],
        },
      ],
    };
    writeFileSync(join(root, "timelines", "talk.json"), JSON.stringify(talk));
  }

  const scriptWith = (comments: Record<string, string>) =>
    Object.entries(comments).map(([title, comment]) => `## ${title}\n${comment}\nBody.\n`).join("\n");

  const outline = () => conn.request("script.outline", { cwd: root, file: "scripts/words.md" });

  it("resolves a range to the timeline span, through clips cut in the middle of it", async () => {
    writeTalk();
    writeCut();
    writeFileSync(
      join(root, "scripts", "words.md"),
      scriptWith({
        "Whole": `<!-- words: ${ids(1, 10).from}..${ids(1, 10).to} -->`,
        "Start": `<!-- words: ${ids(1, 3).from}..${ids(1, 3).to} -->`,
        "Across the cut": `<!-- words: ${ids(3, 8).from}..${ids(3, 8).to} -->`,
        "Removed": `<!-- words: ${ids(5, 6).from}..${ids(5, 6).to} -->`,
        "Plain": "",
      }),
    );
    const { scenes, warnings } = await outline();
    const bySlug = Object.fromEntries(scenes.map((scene) => [scene.slug, scene]));
    expect(bySlug["whole"]!.wordRange).toEqual(ids(1, 10));
    // Words 1-4 sit at 0-3.8 s; words 7-10 at 20-23.8 s.
    expect(bySlug["whole"]!.span).toEqual([{ timeline: "talk", start: 0, end: 23.8, words: 8 }]);
    expect(bySlug["start"]!.span).toEqual([{ timeline: "talk", start: 0, end: 2.8, words: 3 }]);
    expect(bySlug["across-the-cut"]!.span).toEqual([{ timeline: "talk", start: 2, end: 21.8, words: 4 }]);
    expect(bySlug["removed"]!.span).toEqual([]);
    expect(bySlug["plain"]!.wordRange).toBeNull();
    expect(bySlug["plain"]!.span).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("maps through clip speed and reports every timeline that places the words", async () => {
    writeTalk();
    writeCut();
    const fast = { ...createTimeline("fast"), tracks: [{ id: "a1", kind: "audio", clips: [{ id: "c_f", type: "media", asset: "assets/talk.wav", start: 10, in: 2, out: 6, speed: 2 }] }] };
    writeFileSync(join(root, "timelines", "fast.json"), JSON.stringify(fast));
    writeFileSync(join(root, "scripts", "words.md"), scriptWith({ Mid: `<!-- words: ${ids(3, 5).from}..${ids(3, 5).to} -->` }));
    const { scenes } = await outline();
    // Source 2-6 s at 2x from 10 s: word 3 (2-2.8) at 10-10.4 s, word 5 (4-4.8) at 11-11.4 s.
    expect(scenes[0]!.span).toEqual([
      { timeline: "fast", start: 10, end: 11.4, words: 3 },
      { timeline: "talk", start: 2, end: 3.8, words: 2 },
    ]);
  });

  it("gives an empty span when the words are in no timeline", async () => {
    writeTalk();
    writeFileSync(join(root, "scripts", "words.md"), scriptWith({ Mid: `<!-- words: ${ids(3, 5).from}..${ids(3, 5).to} -->` }));
    const result = await outline();
    expect(result.scenes[0]!.span).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("reports unknown ids, a reversed range, split transcripts and a malformed comment as warnings, never an error", async () => {
    writeTalk();
    const other = { schemaVersion: 1, asset: "assets/other.wav", assetHash: `sha256:${"c".repeat(64)}`, provider: "fake", model: "m", words: [{ id: "w_000050", text: "x", start: 0, end: 1 }], edits: {} };
    writeFileSync(join(root, "transcripts", "other.words.json"), JSON.stringify(other));
    writeFileSync(
      join(root, "scripts", "words.md"),
      scriptWith({
        Unknown: "<!-- words: w_000090..w_000091 -->",
        Reversed: `<!-- words: ${ids(8, 2).from}..${ids(8, 2).to} -->`,
        Split: "<!-- words: w_000002..w_000050 -->",
        Bad: "<!-- words: soon -->",
      }),
    );
    const result = await outline();
    expect(result.scenes.map((scene) => scene.span)).toEqual([[], [], [], []]);
    expect(result.warnings).toEqual([
      expect.stringMatching(/Scene "bad": malformed words comment/),
      expect.stringMatching(/Scene "unknown": .*unknown word ids/),
      expect.stringMatching(/Scene "reversed": .*reversed in transcripts\/talk\.words\.json/),
      expect.stringMatching(/Scene "split": .*the ids are not in one transcript/),
    ]);
  });

  it("warns when the project has no transcript at all", async () => {
    writeFileSync(join(root, "scripts", "words.md"), scriptWith({ A: "<!-- words: w_000001..w_000002 -->" }));
    expect((await outline()).warnings).toEqual([expect.stringMatching(/Scene "a": .*no transcripts/)]);
  });
});
