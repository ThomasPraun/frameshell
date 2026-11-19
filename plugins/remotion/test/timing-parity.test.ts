import { describe, expect, it } from "vitest";
import { RENDER_TIMING_KINDS, type RenderBeat, type RenderMarker, type RenderTiming, type RenderWord } from "@frameshell/plugin-api";
import { TIMING_HELPER_SOURCE, TIMING_KINDS } from "../src/index.js";

// `src/frameshell-timing.ts` of a Remotion project is a hand copy of the plugin API's timing types (ADR 0029). Each
// table below must name exactly the keys of its plugin API type (`pnpm typecheck` refuses a missing or extra key), and
// the test holds the helper source to the tables, so a field added to `RenderTiming` fails here until the copy has it.
type Shape<T> = { readonly [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? "optional" : "required" };

const TIMING = {
  beats: "optional",
  tempo: "optional",
  beatsProblem: "optional",
  markers: "optional",
  words: "optional",
  wordsProblem: "optional",
} as const satisfies Shape<RenderTiming>;
const TEMPO = { bpm: "required", meter: "required" } as const satisfies Shape<NonNullable<RenderTiming["tempo"]>>;
const BEAT = { at: "required", beat: "required", bar: "optional" } as const satisfies Shape<RenderBeat>;
const MARKER = { at: "required", id: "required", label: "required", color: "optional" } as const satisfies Shape<RenderMarker>;
const WORD = { at: "required", end: "required", text: "required", id: "required" } as const satisfies Shape<RenderWord>;

/** Property names of each `export interface` of the helper source, with `optional` or `required`. */
function interfaces(source: string): Map<string, Record<string, string>> {
  const found = new Map<string, Record<string, string>>();
  for (const [, name, body] of source.matchAll(/export interface (\w+) \{\n([\s\S]*?)\n\}/g)) {
    const keys: Record<string, string> = {};
    for (const [, key, optional] of body!.matchAll(/^ {2}(\w+)(\?)?:/gm)) keys[key!] = optional ? "optional" : "required";
    found.set(name!, keys);
  }
  return found;
}

describe("Remotion timing helper types", () => {
  const helper = interfaces(TIMING_HELPER_SOURCE);

  it("lists exactly the keys of the plugin API's RenderTiming", () => {
    expect(helper.get("FrameshellTiming")).toEqual(TIMING);
    const tempo = /^ {2}tempo\?: \{ ([^}]*) \};$/m.exec(TIMING_HELPER_SOURCE)?.[1] ?? "";
    expect(Object.fromEntries(tempo.split(";").map((part) => [part.split(":")[0]!.trim(), "required"]).filter(([key]) => key))).toEqual(TEMPO);
  });

  it("lists exactly the keys of each beat, marker and word", () => {
    expect(helper.get("FrameshellBeat")).toEqual(BEAT);
    expect(helper.get("FrameshellMarker")).toEqual(MARKER);
    expect(helper.get("FrameshellWord")).toEqual(WORD);
    expect([...helper.keys()].sort()).toEqual(["FrameshellBeat", "FrameshellMarker", "FrameshellTiming", "FrameshellWord"]);
  });
});

describe("timing kinds", () => {
  it("are the plugin API list (the plugin keeps a copy: installed plugins carry no plugin-api)", () => {
    expect([...TIMING_KINDS]).toEqual([...RENDER_TIMING_KINDS]);
  });
});
