import { describe, expect, it } from "vitest";
import { parseSound } from "../src/sound-commands.js";
import { UsageError, parseTimelineCommand } from "../src/timeline-commands.js";

// Seam under test: the CLI turns every timeline time flag into a number (seconds) or the text the daemon resolves as a
// TimeRef (a marker, `beat:N`, `bar:N`, `word:<text>`, ADR 0029 slice 4), and never parses a name itself.

describe("time flags that take a TimeRef", () => {
  it("captions set sends --from and --to as seconds or as text", () => {
    const base = { text: "a | b" };
    expect(parseTimelineCommand(["captions", "set", "t_1"], { ...base, from: "12.5", to: "bar:4-0.2" })!.params).toMatchObject({ from: 12.5, to: "bar:4-0.2" });
    expect(parseTimelineCommand(["captions", "set", "t_1"], { ...base, from: "hook" })!.params).toMatchObject({ from: "hook" });
    expect(() => parseTimelineCommand(["captions", "set", "t_1"], { ...base, to: " " })).toThrow(UsageError);
  });

  it("cut, marker add and captions set send word: references as text for the daemon", () => {
    expect(parseTimelineCommand(["cut"], { from: "word:so", to: "word:this#2+0.2" })!.params).toMatchObject({ from: "word:so", to: "word:this#2+0.2" });
    expect(parseTimelineCommand(["marker", "add"], { at: "word:w_000012", label: "cta" })!.params).toMatchObject({ at: "word:w_000012", label: "cta" });
    expect(parseTimelineCommand(["captions", "set", "t_1"], { text: "*idea*", from: "word:idea", to: "word:20" })!.params).toMatchObject({ from: "word:idea", to: "word:20" });
  });

  it("direct sends --from and --to as seconds or as text", () => {
    expect(parseTimelineCommand(["direct", "g_1"], { from: "beat:17", to: "60" })!.params).toMatchObject({ group: "g_1", from: "beat:17", to: 60 });
    expect(parseTimelineCommand(["direct", "g_1"], {})!.params).toEqual({ group: "g_1" });
  });

  it("multicam reframe sends --time as seconds or as text, and --at stays seconds of the group", () => {
    const key = { x: "0.3" };
    expect(parseTimelineCommand(["multicam", "reframe", "g_1", "ana"], { ...key, time: "hook+0.5" })!.params).toMatchObject({ time: "hook+0.5" });
    expect(parseTimelineCommand(["multicam", "reframe", "g_1", "ana"], { ...key, time: "2" })!.params).toMatchObject({ time: 2 });
    expect(parseTimelineCommand(["multicam", "reframe", "g_1", "ana"], { ...key, at: "4" })!.params).toMatchObject({ at: 4 });
    expect(() => parseTimelineCommand(["multicam", "reframe", "g_1", "ana"], { ...key, at: "hook" })).toThrow(UsageError);
  });
});

describe("sound times", () => {
  it("sound place sends each --at entry and the typing range as seconds or as text", () => {
    const place = parseSound(["place", "click"], { at: "bar:3,hook+0.5,2" });
    expect(place).toMatchObject({ kind: "sound.place", params: { cues: [{ at: "bar:3" }, { at: "hook+0.5" }, { at: 2 }] } });
    const typing = parseSound(["place", "tick"], { typing: true, from: "beat:9", to: "bar:5+0.5" });
    expect(typing).toMatchObject({ kind: "sound.place", params: { typing: { from: "beat:9", to: "bar:5+0.5" } } });
  });

  it("sound music sends --at, the part times and the accents as seconds or as text", () => {
    const music = parseSound(["music", "minimal"], { at: "bar:2", sections: "intro:2,drop@bar:4", accents: "beat:9,3" });
    expect(music).toMatchObject({ kind: "sound.music", params: { at: "bar:2", sections: [{ kind: "intro", bars: 2 }, { kind: "drop", at: "bar:4" }], accents: ["beat:9", 3] } });
  });
});
