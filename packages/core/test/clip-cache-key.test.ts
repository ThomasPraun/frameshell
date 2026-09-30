import { describe, expect, it } from "vitest";
import type { AdapterClip } from "@frameshell/schema";
import { type ClipKeyInput, clipCacheKey } from "../src/index.js";

// SPEC §6.5: key = adapter name + version + clip props + input file contents + project fps/resolution.
const clip: AdapterClip = {
  id: "c_0100",
  type: "hyperframes",
  source: "compositions/hyperframes/intro/index.html",
  start: 0,
  duration: 8,
  props: { title: "Launch", colors: { accent: "#ff4d6d", text: "#fff" } },
};

const base: ClipKeyInput = {
  plugin: { name: "@frameshell/hyperframes", version: "0.1.0" },
  clip,
  inputs: [
    { path: "compositions/hyperframes/intro/index.html", hash: "sha256:aaa" },
    { path: "compositions/hyperframes/intro/logo.svg", hash: "sha256:bbb" },
  ],
  format: { fps: 30, width: 2560, height: 1440 },
};

describe("clip render cache key", () => {
  it("is a stable 32-hex-digit name, the same for the same clip on every call", () => {
    const key = clipCacheKey(base);
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(clipCacheKey(structuredClone(base))).toBe(key);
  });

  it("ignores key order in props and the order inputs are listed in", () => {
    const reordered: ClipKeyInput = {
      ...base,
      clip: { ...clip, props: { colors: { text: "#fff", accent: "#ff4d6d" }, title: "Launch" } },
      inputs: [...base.inputs].reverse(),
    };
    expect(clipCacheKey(reordered)).toBe(clipCacheKey(base));
  });

  it("stays the same when the clip only moves, is trimmed, re-placed or renamed", () => {
    const placed: AdapterClip = {
      ...clip,
      id: "c_other",
      start: 42.5,
      in: 1,
      duration: 3,
      transform: { x: 100, scale: 0.5, opacity: 0.8 },
      scriptRef: "scripts/launch.md#intro",
      audio: { muted: true },
    };
    expect(clipCacheKey({ ...base, clip: placed })).toBe(clipCacheKey(base));
  });

  it("changes with anything that changes the pixels", () => {
    const key = clipCacheKey(base);
    const variants: ClipKeyInput[] = [
      { ...base, clip: { ...clip, props: { ...clip.props, title: "Launch!" } } },
      { ...base, clip: { ...clip, props: undefined } },
      { ...base, clip: { ...clip, source: "compositions/hyperframes/outro/index.html" } },
      { ...base, clip: { ...clip, type: "remotion" } },
      { ...base, inputs: [base.inputs[0]!, { path: "compositions/hyperframes/intro/logo.svg", hash: "sha256:ccc" }] },
      { ...base, inputs: [base.inputs[0]!, { path: "compositions/hyperframes/intro/logo.svg", hash: null }] },
      { ...base, inputs: [base.inputs[0]!] },
      { ...base, plugin: { ...base.plugin, version: "0.1.1" } },
      { ...base, plugin: { ...base.plugin, name: "@acme/hyperframes" } },
      { ...base, format: { ...base.format, fps: 60 } },
      { ...base, format: { ...base.format, width: 1920, height: 1080 } },
    ];
    const keys = variants.map(clipCacheKey);
    for (const other of keys) expect(other).not.toBe(key);
    expect(new Set(keys).size).toBe(variants.length);
  });
});
