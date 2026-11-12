import { describe, expect, it } from "vitest";
import { type MediaClip, parseBatchFile, parseSlotTarget } from "@frameshell/schema";
import { assetSwapProblem, withValueAt } from "../src/batch/variant.js";

const file = (extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  slots: { title: "c_card.props.title", voice: "c_vo.asset" },
  rows: [{ id: "es", title: "Hola", voice: "assets/vo-es.wav" }],
  ...extra,
});

describe("batch file", () => {
  it("defaults the template to main and keeps row values by slot name", () => {
    const parsed = parseBatchFile(file());
    expect(parsed).toMatchObject({ ok: true, value: { template: "main", rows: [{ id: "es", title: "Hola" }] } });
  });

  it.each([
    [{ rows: [{ id: "es" }, { id: "es" }] }, "rows.1.id: row id es is used twice"],
    [{ rows: [{ id: "ES" }] }, "rows.0.id: must be lowercase"],
    [{ rows: [{ id: "es", titel: "x" }] }, "rows.0.titel: unknown slot titel"],
    [{ rows: [{ id: "es", voice: 3 }] }, "rows.0.voice: an asset slot takes a project-relative path"],
    [{ slots: { title: "c_card.title" } }, "slots.title: must be `<clipId>.asset` or `<clipId>.props.<path>`"],
    [{ slots: { id: "c_card.asset" }, rows: [{ id: "es" }] }, "slots.id"],
    [{ slots: {} }, "slots: must name at least one slot"],
    [{ rows: [] }, "rows:"],
  ])("refuses %j", (extra, message) => {
    const parsed = parseBatchFile(file(extra));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(message);
  });

  it("splits a slot into its clip and what it sets", () => {
    expect(parseSlotTarget("c_8f2.props.inputProps.title")).toEqual({ clip: "c_8f2", kind: "props", path: ["inputProps", "title"] });
    expect(parseSlotTarget("c_8f2.asset")).toEqual({ clip: "c_8f2", kind: "asset" });
    expect(parseSlotTarget("c_8f2.props")).toBeNull();
  });
});

describe("withValueAt", () => {
  it("writes a deep copy with the value at the path, creating objects on the way", () => {
    const props = { composition: "Intro", inputProps: { title: "Launch", items: [{ name: "a" }] } };
    expect(withValueAt(props, ["inputProps", "title"], "Lanzamiento")).toEqual({ composition: "Intro", inputProps: { title: "Lanzamiento", items: [{ name: "a" }] } });
    expect(withValueAt(props, ["inputProps", "items", "0", "name"], "b").inputProps).toMatchObject({ items: [{ name: "b" }] });
    expect(withValueAt({}, ["a", "b"], 1)).toEqual({ a: { b: 1 } });
    expect(props.inputProps.title).toBe("Launch");
  });

  it("refuses a path through a value that is not an object", () => {
    expect(() => withValueAt({ title: "x" }, ["title", "size"], 1)).toThrow(/props\.title is "x", not an object/);
    expect(() => withValueAt({ items: [] }, ["items", "first"], 1)).toThrow(/props\.items is a list/);
  });
});

describe("assetSwapProblem", () => {
  const clip: MediaClip = { id: "c_vo", type: "media", asset: "assets/vo-en.wav", start: 0, in: 0.5, out: 2 };

  it("accepts a file at least as long as the clip's out, with the stream its track plays", () => {
    expect(assetSwapProblem(clip, "audio", "assets/vo-es.wav", { duration: 2.0004, video: false, audio: true }, 30)).toBeNull();
    expect(assetSwapProblem(clip, "audio", "assets/vo-es.wav", { duration: 5, video: false, audio: true }, 30)).toBeNull();
    expect(assetSwapProblem(clip, "video", "assets/logo.png", { duration: null, video: true, audio: false }, 30)).toBeNull();
  });

  it("refuses a shorter file or one without the stream, never retiming", () => {
    expect(assetSwapProblem(clip, "audio", "assets/vo-es.wav", { duration: 1.9, video: false, audio: true }, 30)).toMatchObject({ reason: "asset too short" });
    expect(assetSwapProblem(clip, "audio", "assets/b-roll.mp4", { duration: 5, video: true, audio: false }, 30)).toMatchObject({ reason: "no audio stream" });
    expect(assetSwapProblem(clip, "video", "assets/vo-es.wav", { duration: 5, video: false, audio: true }, 30)).toMatchObject({ reason: "no video stream" });
  });
});
