import type { MatteStateInfo, TimelineView } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";
import { layoutTimeline } from "../src/renderer/src/timeline/layout.js";
import { matteBadge, plateChoices } from "../src/renderer/src/timeline/matte.js";

// Seam under test: the track header's side of subject mattes (ADR 0032), fed `timeline.show` and `matte.status` results.

type Track = TimelineView["tracks"][number];

const TALK = "assets/talk.mp4";
const OTHER = "assets/other.mp4";

function view(tracks: Track[]): TimelineView {
  return { timeline: "main", path: "timelines/main.json", revision: 1, fps: 30, duration: 10, tracks, problems: [] };
}

const media = (id: string, asset: string) => ({ id, type: "media", asset, start: 0, end: 5, in: 0, out: 5 });
const titles = (id: string) => ({ id, type: "titles", start: 0, end: 2, duration: 2 });

const matte = (asset: string, state: MatteStateInfo["state"], progress = 0, error: string | null = null): MatteStateInfo => ({
  asset,
  state,
  matte: state === "ready" ? ".frameshell/cache/mattes/k.mp4" : null,
  progress: state === "ready" ? 1 : progress,
  job: state === "queued" || state === "making" ? "job_1" : null,
  error,
});

// V1 talk, V2 b-roll, V3 titles, V4 word behind V1; display order is V4, V3, V2, V1.
const layout = layoutTimeline(
  view([
    { id: "v1", kind: "video", name: null, follows: null, clips: [media("c1", TALK)] },
    { id: "v2", kind: "video", name: null, follows: null, clips: [media("c2", OTHER)] },
    { id: "v3", kind: "video", name: null, follows: null, clips: [titles("c3")] },
    { id: "v4", kind: "video", name: null, follows: null, behind: "v1", clips: [media("c4", "assets/word.png")] },
    { id: "a1", kind: "audio", name: null, follows: null, clips: [] },
  ]),
);
const row = (id: string) => layout.rows.find((candidate) => candidate.id === id)!;

describe("plateChoices", () => {
  it("offers the lower video tracks that hold a media clip, nearest first", () => {
    expect(plateChoices(layout, row("v4")).map((plate) => plate.id)).toEqual(["v2", "v1"]);
    expect(plateChoices(layout, row("v2")).map((plate) => plate.id)).toEqual(["v1"]);
  });

  it("skips generated plates and offers none to the bottom track or an audio track", () => {
    expect(plateChoices(layout, row("v3")).map((plate) => plate.id)).toEqual(["v2", "v1"]);
    expect(plateChoices(layout, row("v1"))).toEqual([]);
    expect(plateChoices(layout, row("a1"))).toEqual([]);
  });
});

describe("TrackRow.behind", () => {
  it("is the plate id on a video track behind one, null elsewhere", () => {
    expect(row("v4").behind).toBe("v1");
    expect(row("v1").behind).toBeNull();
    expect(row("a1").behind).toBeNull();
  });
});

describe("matteBadge", () => {
  const talk = row("v4");

  it("is null for a track that is not behind a plate", () => {
    expect(matteBadge(layout, row("v2"), [matte(TALK, "ready")])).toBeNull();
  });

  it("is idle, with the plate's label, before the first read or when none of the plate's assets has a matte", () => {
    expect(matteBadge(layout, talk, null)).toEqual({ state: "idle", plate: "V1" });
    expect(matteBadge(layout, talk, [matte(OTHER, "making", 0.5)])).toEqual({ state: "idle", plate: "V1" });
  });

  it("is ready once every matte of the plate is", () => {
    expect(matteBadge(layout, talk, [matte(TALK, "ready")])).toEqual({ state: "ready", plate: "V1" });
  });

  it("is preparing with the job's progress, or without one while it is only queued or waiting for the proxy", () => {
    expect(matteBadge(layout, talk, [matte(TALK, "making", 0.4)])).toEqual({ state: "preparing", plate: "V1", progress: 0.4 });
    expect(matteBadge(layout, talk, [matte(TALK, "queued")])).toEqual({ state: "preparing", plate: "V1", progress: null });
    expect(matteBadge(layout, talk, [matte(TALK, "waiting")])).toEqual({ state: "preparing", plate: "V1", progress: null });
  });

  it("is failed with the daemon's reason, which wins over a matte still being made", () => {
    expect(matteBadge(layout, talk, [matte(TALK, "failed", 0, "model missing")])).toEqual({ state: "failed", plate: "V1", error: "model missing" });
    const two = layoutTimeline(
      view([
        { id: "v1", kind: "video", name: null, follows: null, clips: [media("c1", TALK), media("c2", OTHER)] },
        { id: "v2", kind: "video", name: null, follows: null, behind: "v1", clips: [] },
      ]),
    );
    const badge = matteBadge(two, two.rows.find((candidate) => candidate.id === "v2")!, [matte(TALK, "making", 0.5), matte(OTHER, "failed", 0, "no proxy")]);
    expect(badge).toEqual({ state: "failed", plate: "V1", error: "no proxy" });
  });
});
