import type { DuckSettings, Timeline } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import { planMusicFit } from "../src/music/run.js";
import { tempoGrid } from "../src/timeline/tempo.js";

// Which duck `music.fit` runs again when the clip it moves carries duck keys (ADR 0037 decision 5): the settings the
// clip kept (`audio.duck`) over the tracks that still exist, else the method's defaults. Pure: the hit is given.
const depsFor = (on: Timeline) => ({
  profile: () => Promise.reject(new Error("not needed")),
  onsets: () => Promise.resolve(null),
  loadGrid: (horizon: number) => tempoGrid({ fps: 30, timeline: on, horizon, beatsOf: async () => null }),
});
const stored: DuckSettings = { under: ["t_voice", "t_gone"], depth: 12, attackMs: 30, releaseMs: 600, threshold: -40, gap: 1 };

function timeline(audio: Record<string, unknown> | undefined): Timeline {
  return {
    version: 1,
    id: "main",
    revision: 3,
    tracks: [
      { id: "t_voice", kind: "video", clips: [] },
      { id: "t_other", kind: "audio", clips: [] },
      {
        id: "t_music",
        kind: "audio",
        clips: [
          {
            id: "c_music",
            type: "media",
            asset: "assets/song.wav",
            start: 0,
            in: 0,
            out: 30,
            ...(audio ? { audio } : {}),
            keys: { gain: [{ at: 0, value: 0, auto: "duck" }, { at: 3, value: -7, auto: "duck" }] },
          },
        ],
      },
    ],
  } as unknown as Timeline;
}

const fit = (source: Timeline) => planMusicFit(source, 30, { clip: "c_music", end: 20, hit: 25, exact: false, dryRun: true }, depsFor(source));

describe("music.fit duck settings", () => {
  it("runs the duck again with the settings the clip kept, over the tracks of them that still exist", async () => {
    const plan = await fit(timeline({ duck: stored }));
    expect(plan.duck).toEqual({ under: ["t_voice"], rerun: true, parameters: "stored" });
    expect(plan.duckAgain).toEqual({ track: "t_music", under: ["t_voice"], settings: stored });
    expect(plan.warnings.join(" ")).toContain("the parameters of its last run");
  });

  it("falls back to the defaults and the other tracks when the clip kept none, or every track it listened to is gone", async () => {
    const none = await fit(timeline(undefined));
    expect(none.duck).toEqual({ under: ["t_voice", "t_other"], rerun: true, parameters: "defaults" });
    expect(none.duckAgain!.settings).toBeNull();
    expect(none.warnings.join(" ")).toContain("its defaults (the clip has none stored)");

    const gone = await fit(timeline({ duck: { ...stored, under: ["t_gone"] } }));
    expect(gone.duck).toMatchObject({ rerun: true, parameters: "defaults" });
    expect(gone.duckAgain!.under).toEqual(["t_voice", "t_other"]);
  });

  it("says so and leaves the keys when skipped", async () => {
    const source = timeline({ duck: stored });
    const plan = await planMusicFit(source, 30, { clip: "c_music", end: 20, hit: 25, exact: false, dryRun: true, skip: ["duck"] }, depsFor(source));
    expect(plan.duck).toEqual({ under: ["t_voice"], rerun: false, parameters: "stored" });
    expect(plan.duckAgain).toBeNull();
    expect(plan.warnings.join(" ")).toContain("skipped");
  });
});
