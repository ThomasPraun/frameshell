import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MediaProbe } from "@frameshell/protocol";
import { createProjectConfig, createTimeline } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import { TimelineService, type TimelineRejection } from "../src/timeline/service.js";
import { tempDir } from "./helpers.js";

// Program tracks through the daemon's timeline service: `timeline.show`, direct file edits of groups and shots
// (SPEC §6.4), and revert of a group change.

const PROBE: MediaProbe = {
  duration: 10,
  format: "mov,mp4",
  video: { codec: "h264", width: 1920, height: 1080, fps: 30, vfr: false, still: false },
  audio: { codec: "aac", channels: 1, sampleRate: 48_000 },
};

const GROUP = {
  id: "g_talk",
  angles: [
    { id: "ana", name: "Ana", asset: "assets/ana.mp4", offset: 0 },
    { id: "ben", name: "Ben", asset: "assets/ben.mp4", offset: 1 },
  ],
};

function setup() {
  const root = tempDir();
  mkdirSync(join(root, "timelines"));
  writeFileSync(join(root, "frameshell.json"), JSON.stringify(createProjectConfig("Test")));
  const timeline = {
    ...createTimeline("main"),
    tracks: [
      {
        id: "t_p",
        kind: "program",
        group: "g_talk",
        clips: [
          { id: "c_1", type: "shot", start: 0, in: 0, out: 3, shot: "solo", angles: ["ana"] },
          { id: "c_2", type: "shot", start: 3, in: 3, out: 6, shot: "two-up", angles: ["ana", "ben"] },
        ],
      },
    ],
    groups: [GROUP],
  };
  const path = join(root, "timelines", "main.json");
  writeFileSync(path, JSON.stringify(timeline, null, 2));
  const rejected: TimelineRejection[] = [];
  const timelines = new TimelineService({
    probe: async () => PROBE,
    clipTypes: async () => new Map(),
    onRejected: (rejection) => rejected.push(rejection),
  });
  const read = () => JSON.parse(readFileSync(path, "utf8"));
  const edit = (change: (timeline: ReturnType<typeof read>) => void) => {
    const current = read();
    change(current);
    writeFileSync(path, JSON.stringify(current, null, 2));
  };
  return { root, timelines, read, edit, rejected };
}

describe("program tracks in the timeline service", () => {
  it("shows a program track with its group, and the groups as stored", async () => {
    const { root, timelines } = setup();
    const view = await timelines.show(root, "main");
    expect(view.duration).toBe(6);
    expect(view.groups).toEqual([GROUP]);
    expect(view.tracks[0]).toMatchObject({ id: "t_p", kind: "program", group: "g_talk", follows: null });
    expect(view.tracks[0]!.clips.map((clip) => [clip.id, clip.end])).toEqual([
      ["c_1", 3],
      ["c_2", 6],
    ]);
    const { tracks } = await timelines.tracks(root, "main");
    expect(tracks).toEqual([{ id: "t_p", kind: "program", name: null, follows: null, group: "g_talk", clips: 2, end: 6 }]);
  });

  it("journals a direct edit that only changes a group, and reverts it", async () => {
    const { root, timelines, read, edit } = setup();
    await timelines.reconcile(root, "main");
    edit((timeline) => {
      timeline.groups[0].angles[1].offset = 1.5;
    });
    await timelines.reconcile(root, "main");
    expect(read()).toMatchObject({ revision: 1, groups: [{ angles: [{ offset: 0 }, { offset: 1.5 }] }] });
    const history = await timelines.history(root, "main", {});
    const operation = history.transactions[0]!.operations[0]!;
    expect(operation).toMatchObject({ op: "timeline.patch", author: "file", touched: ["g_talk"] });

    await timelines.revert({ root, cwd: root, timeline: "main", author: "ui", tx: { id: "tx_0000aaaa", label: null }, target: operation.id });
    expect(read()).toMatchObject({ revision: 2, groups: [GROUP] });
  });

  it("rejects a direct edit with overlapping shots, keeping it under .frameshell/rejected/", async () => {
    const { root, timelines, read, edit, rejected } = setup();
    await timelines.reconcile(root, "main");
    edit((timeline) => {
      timeline.tracks[0].clips[1].start = 2;
    });
    await timelines.reconcile(root, "main");
    expect(read().tracks[0].clips[1].start).toBe(3);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reason: "invalid" });
    expect(rejected[0]!.message).toMatch(/c_2 .*would overlap on track t_p|shots on a program track cannot overlap/);
    expect(readdirSync(join(root, ".frameshell", "rejected"))).toHaveLength(1);
  });

  it("rejects a direct edit naming an angle the group lacks", async () => {
    const { root, timelines, edit, rejected } = setup();
    await timelines.reconcile(root, "main");
    edit((timeline) => {
      timeline.tracks[0].clips[0].angles = ["zoe"];
    });
    await timelines.reconcile(root, "main");
    expect(rejected[0]!.message).toMatch(/angle "zoe" is not in group "g_talk" \(angles: ana, ben\)/);
  });
});
