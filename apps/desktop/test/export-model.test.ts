import type { JobInfo } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";
import { exportView, heardJob } from "../src/renderer/src/export/model.js";

// Seam under test: what Export video (#738) shows of the daemon's `render` job.

const job = (fields: Partial<JobInfo> = {}): JobInfo =>
  ({ id: "j_1", kind: "render", state: "running", progress: 0, error: null, warnings: [], ...fields }) as JobInfo;
const started = (fields: Partial<JobInfo> = {}) => ({ output: "/p/exports/launch.mp4", warnings: ["subtitles"], job: job(fields) });

describe("exportView", () => {
  it("is idle with no export, starting while asking, and the start's error when it was refused", () => {
    expect(exportView(null, false, null)).toEqual({ kind: "idle" });
    expect(exportView(started(), true, null)).toEqual({ kind: "starting" });
    expect(exportView(null, false, "empty timeline")).toEqual({ kind: "failed", message: "empty timeline" });
  });

  it("shows whole percent while running, waiting while queued", () => {
    expect(exportView(started({ progress: 0.426 }), false, null)).toEqual({ kind: "running", percent: 42, waiting: false });
    expect(exportView(started({ state: "queued" }), false, null)).toMatchObject({ kind: "running", waiting: true });
  });

  it("names the file and everything left out once done, and the job's error when it failed", () => {
    expect(exportView(started({ state: "done", progress: 1, warnings: ["loop seam"] }), false, null)).toEqual({
      kind: "done",
      file: "launch.mp4",
      output: "/p/exports/launch.mp4",
      warnings: ["subtitles", "loop seam"],
    });
    expect(exportView(started({ state: "failed", error: "ffmpeg exited 1" }), false, null)).toEqual({ kind: "failed", message: "ffmpeg exited 1" });
  });
});

describe("heardJob", () => {
  it("follows only its own job; other jobs and a reconnect change nothing", () => {
    const mine = started();
    expect(heardJob(mine, job({ progress: 0.5 }))?.job.progress).toBe(0.5);
    expect(heardJob(mine, job({ id: "j_2", progress: 0.9 }))).toBe(mine);
    expect(heardJob(mine, null)).toBe(mine);
    expect(heardJob(null, job())).toBeNull();
  });
});
