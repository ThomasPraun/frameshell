import { MAX_AUDIO_EFFECTS, VOICE_CHAIN, normalizeAudioEffects } from "@frameshell/schema/effects";
import { describe, expect, it } from "vitest";
import { EFFECT_PARAMS, bypass, defaultEffect, hasVoice, missingKinds, movedEarlier, paramOf, voiceEffects, withEffect, withParam, withVoice, withoutEffect } from "../src/renderer/src/voice/model.js";

describe("voice chain edits", () => {
  it("withParam changes one number and leaves the rest of the list as it was", () => {
    const next = withParam(VOICE_CHAIN, 2, "ratio", 4)!;
    expect(next[2]).toEqual({ kind: "compressor", threshold: -20, ratio: 4, attack: 8, release: 140, makeup: 2 });
    expect(next[0]).toEqual(VOICE_CHAIN[0]);
    expect(VOICE_CHAIN[2]).toMatchObject({ ratio: 2.5 });
  });

  it("withParam refuses a number outside the effect's range, an unknown parameter and a missing effect", () => {
    expect(withParam(VOICE_CHAIN, 0, "frequency", 5)).toBeNull();
    expect(withParam(VOICE_CHAIN, 0, "frequency", 2000)).toBeNull();
    expect(withParam(VOICE_CHAIN, 0, "frequency", Number.NaN)).toBeNull();
    expect(withParam(VOICE_CHAIN, 0, "ratio", 2)).toBeNull();
    expect(withParam(VOICE_CHAIN, 5, "frequency", 100)).toBeNull();
  });

  it("every parameter an effect shows is one the effect stores", () => {
    for (const [kind, params] of Object.entries(EFFECT_PARAMS)) {
      if (kind === "highpassSweep") continue;
      const effect = defaultEffect(kind as Exclude<keyof typeof EFFECT_PARAMS, "highpassSweep">);
      expect(Object.keys(effect).filter((key) => key !== "kind")).toEqual([...params]);
      for (const param of params) expect(paramOf(effect, param)).toEqual(expect.any(Number));
    }
  });

  it("shows the cutoffs of a build and edits them in range; the build's own times are not shown", () => {
    const build = { kind: "highpassSweep", from: 8, to: 10, startHz: 40, endHz: 300 } as const;
    expect(EFFECT_PARAMS.highpassSweep.map((param) => paramOf(build, param))).toEqual([40, 300]);
    expect(withParam([build], 0, "endHz", 500)).toEqual([{ ...build, endHz: 500 }]);
    expect(withParam([build], 0, "endHz", 5000)).toBeNull();
    expect(withParam([build], 0, "from", 5)).toBeNull();
  });

  it("keeps a build's music mark through the inspector's edits, so music fit and shape still find it", () => {
    const marked = normalizeAudioEffects([{ kind: "highpass" }, { kind: "highpassSweep", from: 8, to: 10, auto: "music" }]);
    expect(marked[1]).toMatchObject({ auto: "music" });
    expect(withParam(marked, 1, "endHz", 500)![1]).toMatchObject({ endHz: 500, auto: "music" });
    expect(withParam(marked, 0, "frequency", 100)![1]).toMatchObject({ auto: "music" });
    expect(movedEarlier(marked, 1)[0]).toMatchObject({ kind: "highpassSweep", auto: "music" });
    expect(withEffect(marked, "denoise")[1]).toMatchObject({ auto: "music" });
    expect(withoutEffect(marked, 0)![0]).toMatchObject({ auto: "music" });
  });

  it("never offers a build to add: music shape writes it", () => {
    expect(missingKinds([])).not.toContain("highpassSweep");
  });

  it("offers the kinds the chain lacks, none once it is full", () => {
    expect(missingKinds([])).toEqual(["highpass", "denoise", "compressor"]);
    expect(missingKinds(VOICE_CHAIN.slice(0, 1))).toEqual(["denoise", "compressor"]);
    expect(missingKinds(VOICE_CHAIN)).toEqual([]);
    expect(missingKinds(Array.from({ length: MAX_AUDIO_EFFECTS }, () => defaultEffect("highpass")))).toEqual([]);
  });

  it("adds a default effect at the end and removes one, null when the list empties", () => {
    expect(withEffect(VOICE_CHAIN.slice(0, 1), "denoise")).toEqual([VOICE_CHAIN[0], VOICE_CHAIN[1]]);
    expect(withoutEffect(VOICE_CHAIN, 1)).toEqual([VOICE_CHAIN[0], VOICE_CHAIN[2]]);
    expect(withoutEffect(VOICE_CHAIN.slice(0, 1), 0)).toBeNull();
  });

  it("moves an effect one place earlier; the first stays", () => {
    expect(movedEarlier(VOICE_CHAIN, 2).map((effect) => effect.kind)).toEqual(["highpass", "compressor", "denoise"]);
    expect(movedEarlier(VOICE_CHAIN, 0)).toEqual(VOICE_CHAIN);
  });

  it("remembers a bypassed chain per clip", () => {
    expect(bypass.recall("c_voice")).toBeNull();
    bypass.keep("c_voice", VOICE_CHAIN);
    expect(bypass.recall("c_voice")).toEqual(VOICE_CHAIN);
    expect(bypass.recall("c_other")).toBeNull();
  });

  describe("music builds", () => {
    const build = normalizeAudioEffects([{ kind: "highpassSweep", from: 8, to: 10, auto: "music" }])[0]!;
    const handSet = normalizeAudioEffects([{ kind: "highpassSweep", from: 1, to: 3 }])[0]!;

    it("reads the Voice switch as on only while there is a voice effect", () => {
      expect(hasVoice([build])).toBe(false);
      expect(hasVoice([handSet])).toBe(true);
      expect(hasVoice([build, VOICE_CHAIN[0]!])).toBe(true);
      expect(voiceEffects([build, VOICE_CHAIN[0]!, handSet])).toEqual([VOICE_CHAIN[0], handSet]);
    });

    it("sets the voice chain beside the builds, and replaces only voice effects", () => {
      expect(withVoice([build], VOICE_CHAIN)).toEqual([...VOICE_CHAIN, build]);
      expect(withVoice([], VOICE_CHAIN)).toEqual([...VOICE_CHAIN]);
      const edited = [build, { ...VOICE_CHAIN[0]!, frequency: 120 } as (typeof VOICE_CHAIN)[number], VOICE_CHAIN[2]!];
      expect(withVoice(edited, VOICE_CHAIN)).toEqual([build, ...VOICE_CHAIN]);
    });

    it("bypasses the voice and keeps the builds; a list that had none left is cleared", () => {
      expect(withVoice([build, ...VOICE_CHAIN], null)).toEqual([build]);
      expect(withVoice([...VOICE_CHAIN, build, build], null)).toEqual([build, build]);
      expect(withVoice(VOICE_CHAIN, null)).toBeNull();
      expect(withVoice([], null)).toBeNull();
    });
  });
});
