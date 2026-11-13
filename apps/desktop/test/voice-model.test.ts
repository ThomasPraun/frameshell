import { MAX_AUDIO_EFFECTS, VOICE_CHAIN } from "@frameshell/schema/effects";
import { describe, expect, it } from "vitest";
import { EFFECT_PARAMS, bypass, defaultEffect, missingKinds, movedEarlier, paramOf, withEffect, withParam, withoutEffect } from "../src/renderer/src/voice/model.js";

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
      const effect = defaultEffect(kind as keyof typeof EFFECT_PARAMS);
      expect(Object.keys(effect).filter((key) => key !== "kind")).toEqual([...params]);
      for (const param of params) expect(paramOf(effect, param)).toEqual(expect.any(Number));
    }
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
});
