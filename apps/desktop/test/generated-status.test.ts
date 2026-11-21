import type { ClipRenderInfo } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";
import { generatedStatus } from "../src/renderer/src/generated-status.js";

const info = (fields: Partial<ClipRenderInfo>): ClipRenderInfo => ({
  clip: "c_1",
  track: "v1",
  type: "hyperframes",
  source: "compositions/quick.html",
  state: "ready",
  key: "k",
  file: null,
  hasAlpha: null,
  width: null,
  height: null,
  duration: null,
  job: null,
  progress: 0,
  error: null,
  ...fields,
});

describe("generatedStatus", () => {
  it("is unknown before clip.renders answers", () => {
    expect(generatedStatus(undefined).state).toBe("unknown");
  });

  it("gives the running percent and keeps the whole error of a failed render", () => {
    expect(generatedStatus(info({ state: "rendering", progress: 0.426 }))).toMatchObject({ state: "rendering", percent: 43, error: null });
    const long = "Error: page crashed while seeking to 1.2 s in compositions/quick.html at line 40, column 12";
    expect(generatedStatus(info({ state: "failed", error: long }))).toMatchObject({ state: "failed", error: long, untrusted: false });
  });

  it("points an untrusted project to the Plugins view", () => {
    const error = "The project's plugins (@frameshell/hyperframes) are not trusted, run `frameshell trust`";
    expect(generatedStatus(info({ state: "unavailable", error })).untrusted).toBe(true);
  });

  it("reports the blurred render, and a plugin's refusal apart from a failure", () => {
    const final = { state: "rendering" as const, key: "f", file: null, hasAlpha: null, width: null, height: null, duration: null, job: "j", progress: 0.5, error: null, refused: false };
    expect(generatedStatus(info({ final })).blur).toEqual({ state: "rendering", percent: 50, error: null });
    expect(generatedStatus(info({ final: { ...final, state: "failed", error: "HDR", refused: true } })).blur?.state).toBe("refused");
    expect(generatedStatus(info({ final: { ...final, onDemand: true } })).blur).toBeNull();
  });
});
