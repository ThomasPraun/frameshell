import { afterEach, describe, expect, it } from "vitest";
import type { ClipAdapter } from "@frameshell/plugin-api";
import { type Timeline } from "@frameshell/schema";
import { ClipRenderer } from "../src/clips/renderer.js";
import { JobQueue } from "../src/jobs/queue.js";
import { tempDir } from "./helpers.js";

// The transcript words a clip that asks for them hears are read once per pass over a timeline (a status, an ensure),
// not once per clip: every read opens each transcript and hashes its footage.
const CLIPS = ["c_a", "c_b", "c_c"];

const timeline: Timeline = {
  schemaVersion: 1,
  id: "main",
  revision: 1,
  tracks: [{ id: "t_v", kind: "video", clips: CLIPS.map((id, index) => ({ id, type: "words-card", source: "compositions/card.json", start: index, duration: 1 })) }],
} as Timeline;

const open: { renderer: ClipRenderer; jobs: JobQueue }[] = [];

afterEach(async () => {
  for (const { renderer, jobs } of open.splice(0)) {
    await renderer.close();
    await jobs.close();
  }
});

function setup(kinds: string[]) {
  const reads: Timeline[] = [];
  const adapter: ClipAdapter = {
    type: "words-card",
    timing: () => kinds as never,
    inputs: async () => [],
    render: async () => {
      throw new Error("not rendered here");
    },
  } as unknown as ClipAdapter;
  const jobs = new JobQueue({ concurrency: 1, idPrefix: "j_c" });
  const renderer = new ClipRenderer({
    jobs,
    adapters: async () => new Map([["words-card", { adapter, plugin: { name: "words-card", version: "1" } }]]),
    timelines: async () => ["main"],
    load: async () => ({ timeline }),
    peek: async () => timeline,
    format: async () => ({ fps: 30, width: 64, height: 36 }),
    probe: async () => ({ width: 64, height: 36, duration: 1 }),
    ensureBinary: async () => "unused",
    wordsOf: async (_root, read) => {
      reads.push(read);
      return { words: [], unchecked: [] };
    },
    watch: false,
  });
  open.push({ renderer, jobs });
  return { renderer, reads, root: tempDir() };
}

describe("words of a pass over a timeline", () => {
  it("reads them once for every clip of a status that asks", async () => {
    const { renderer, reads, root } = setup(["words"]);
    const { clips } = await renderer.status(root, "main");
    expect(clips.map((clip) => clip.clip)).toEqual(CLIPS);
    expect(reads).toHaveLength(1);
    // The next status is a new pass: a transcript edited since is seen.
    await renderer.status(root, "main");
    expect(reads).toHaveLength(2);
  });

  it("reads none when no clip asks", async () => {
    const { renderer, reads, root } = setup(["beats"]);
    await renderer.status(root, "main");
    expect(reads).toHaveLength(0);
  });
});
