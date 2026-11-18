import { GRAIN_LIMITS, VIGNETTE_LIMITS, grainOf, grainStrength, vignetteOf } from "@frameshell/schema/finish";
import { describe, expect, it } from "vitest";
import {
  LETTERBOX_PRESETS,
  aspectText,
  letterboxArgs,
  letterboxChoice,
  shownGrain,
  shownVignette,
  storedAspect,
} from "../src/renderer/src/finish/model.js";
import { layoutTimeline } from "../src/renderer/src/timeline/layout.js";

describe("shown vignette and grain (ADR 0043 slice 4b)", () => {
  it("fills the schema defaults into what a clip stores, and is null without it", () => {
    expect(shownVignette(undefined)).toBeNull();
    expect(shownVignette({})).toEqual({
      strength: VIGNETTE_LIMITS.strength.default,
      radius: VIGNETTE_LIMITS.radius.default,
      softness: VIGNETTE_LIMITS.softness.default,
    });
    expect(shownVignette({ strength: 0.6 })).toMatchObject({ strength: 0.6, radius: VIGNETTE_LIMITS.radius.default });
    expect(shownGrain(null)).toBeNull();
    expect(shownGrain({})).toEqual({ amount: GRAIN_LIMITS.amount.default, size: GRAIN_LIMITS.size.default, seed: null });
    expect(shownGrain({ amount: 0.5, seed: 7 })).toEqual({ amount: 0.5, size: GRAIN_LIMITS.size.default, seed: 7 });
  });

  it("keeps a switched-on look the compositor draws nothing for, so its slider can come back up", () => {
    expect(shownVignette({ strength: 0 })).not.toBeNull();
    expect(vignetteOf({ type: "media", vignette: { strength: 0 } })).toBeNull();
    expect(shownGrain({ amount: 0 })).not.toBeNull();
    expect(grainOf({ id: "c", type: "media", grain: { amount: 0 } })).toBeNull();
  });

  it("agrees with the compositor's own defaults wherever it draws something", () => {
    const vignette = vignetteOf({ type: "media", vignette: {} });
    expect(shownVignette({})).toEqual({ strength: vignette!.strength, radius: vignette!.radius, softness: vignette!.softness });
    const grain = grainOf({ id: "c", type: "media", grain: {} });
    expect(shownGrain({})).toMatchObject({ amount: grain!.amount, size: grain!.size });
    expect(grainStrength(shownGrain({})!.amount)).toBe(grain!.strength);
  });
});

describe("clip boxes of the timeline layout", () => {
  const clip = (fields: Record<string, unknown>) => ({ id: "c_a", type: "media", asset: "assets/a.mp4", start: 0, end: 3, in: 0, out: 3, ...fields });
  const boxes = (clips: Record<string, unknown>[]) =>
    layoutTimeline({
      timeline: "main",
      path: "timelines/main.json",
      revision: 1,
      fps: 30,
      duration: 3,
      problems: [],
      tracks: [{ id: "t_v", kind: "video", name: null, follows: null, clips }],
    } as never).rows[0]!.clips;

  it("carries vignette and grain of media and generated clips, null for nested timelines and shots", () => {
    const [media, generated, nested, shot] = boxes([
      clip({ vignette: { strength: 0.5 }, grain: { seed: 3 } }),
      clip({ id: "c_b", type: "hyperframes", asset: undefined, source: "x/index.html", vignette: {} }),
      clip({ id: "c_c", type: "timeline", asset: undefined, source: "timelines/inner.json", vignette: {}, grain: {} }),
      clip({ id: "c_d", type: "shot", asset: undefined, group: "g", layout: "solo", angles: [], vignette: {}, grain: {} }),
    ]);
    expect(media!.vignette).toMatchObject({ strength: 0.5 });
    expect(media!.grain).toMatchObject({ seed: 3 });
    expect(generated!.vignette).not.toBeNull();
    expect(generated!.grain).toBeNull();
    expect(nested!.vignette).toBeNull();
    expect(nested!.grain).toBeNull();
    expect(shot!.vignette).toBeNull();
    expect(shot!.grain).toBeNull();
  });
});

describe("letterbox menu", () => {
  it("matches a stored aspect to its preset within rounding, calls any other custom, none for no bars", () => {
    expect(letterboxChoice(null)).toBe("none");
    expect(letterboxChoice(2.39)).toBe("2.39");
    expect(letterboxChoice(4 / 3)).toBe("4:3");
    expect(letterboxChoice(1.3333)).toBe("4:3");
    expect(letterboxChoice(2.2)).toBe("custom");
    expect(LETTERBOX_PRESETS.map((preset) => letterboxChoice(preset.aspect))).toEqual(LETTERBOX_PRESETS.map((preset) => preset.id));
  });

  it("writes an aspect with at most three decimals", () => {
    expect(aspectText(2.39)).toBe("2.39");
    expect(aspectText(16 / 9)).toBe("1.778");
    expect(aspectText(2)).toBe("2");
  });

  it("sends clear for none and names the format only when it is not the primary", () => {
    expect(letterboxArgs(2.39, null)).toEqual({ aspect: 2.39 });
    expect(letterboxArgs(null, null)).toEqual({ clear: true });
    expect(letterboxArgs(1.85, "9x16")).toEqual({ aspect: 1.85, format: "9x16" });
    expect(letterboxArgs(null, "9x16")).toEqual({ clear: true, format: "9x16" });
  });

  it("reads the primary's bars from the timeline and a format's from its override", () => {
    const view = { letterbox: { aspect: 2.39 }, formats: { "9x16": { letterbox: { aspect: 1 } }, square: {} } };
    expect(storedAspect(view, null)).toBe(2.39);
    expect(storedAspect(view, "9x16")).toBe(1);
    expect(storedAspect(view, "square")).toBeNull();
    expect(storedAspect(view, "missing")).toBeNull();
    expect(storedAspect({}, null)).toBeNull();
    expect(storedAspect(null, null)).toBeNull();
  });
});
