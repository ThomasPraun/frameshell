import type { ClipRenderInfo, JobInfo } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";
import { applyClipJob } from "../src/renderer/src/preview/clip-renders.js";

// Seam under test: how `clip` job events (daemon `job.progress`) move the preview's render states between reads.

const info = (clip: string, overrides: Partial<ClipRenderInfo> = {}): ClipRenderInfo => ({
  clip,
  track: "v2",
  type: "hyperframes",
  source: "compositions/hyperframes/intro/index.html",
  state: "queued",
  key: `key${clip}`,
  file: null,
  hasAlpha: null,
  width: null,
  height: null,
  duration: null,
  job: "j_c1",
  progress: 0,
  error: null,
  ...overrides,
});

const job = (overrides: Partial<JobInfo> = {}): JobInfo => ({
  id: "j_c1",
  kind: "clip",
  project: "/p",
  asset: "compositions/hyperframes/intro/index.html",
  output: "/p/.frameshell/cache/clips/keyc1",
  state: "running",
  step: "render",
  progress: 0.25,
  cached: null,
  error: null,
  createdAt: "2026-09-30T00:00:00.000Z",
  startedAt: "2026-09-30T00:00:01.000Z",
  finishedAt: null,
  ...overrides,
});

describe("applyClipJob", () => {
  it("moves a queued render to rendering with its progress, without a re-read", () => {
    const renders = new Map([["c1", info("c1")], ["c2", info("c2", { job: null, state: "ready", file: ".frameshell/cache/clips/keyc2.webm" })]]);
    const { renders: next, refetch } = applyClipJob(renders, job());
    expect(refetch).toBe(false);
    expect(next.get("c1")).toMatchObject({ state: "rendering", progress: 0.25, job: "j_c1" });
    expect(next.get("c2")).toBe(renders.get("c2"));
  });

  it("follows a render by its cache key when the read did not know the job yet (two clips sharing one render)", () => {
    const renders = new Map([["c1", info("c1", { job: null })], ["c3", info("c3", { key: "keyc1", job: null })]]);
    const { renders: next } = applyClipJob(renders, job({ id: "j_c7", progress: 0.5 }));
    expect([...next.values()].map((i) => [i.clip, i.state, i.job])).toEqual([
      ["c1", "rendering", "j_c7"],
      ["c3", "rendering", "j_c7"],
    ]);
  });

  it("re-reads when a render ends, fails, or starts for a key no clip has (the composition was edited)", () => {
    const renders = new Map([["c1", info("c1", { state: "rendering" })]]);
    for (const state of ["done", "failed", "canceled"] as const) expect(applyClipJob(renders, job({ state })).refetch).toBe(true);
    expect(applyClipJob(renders, job({ id: "j_c9", output: "/p/.frameshell/cache/clips/newkey" })).refetch).toBe(true);
  });

  it("keeps the same map when an event changes nothing", () => {
    const renders = new Map([["c1", info("c1", { state: "rendering", progress: 0.25 })]]);
    expect(applyClipJob(renders, job()).renders).toBe(renders);
  });
});
