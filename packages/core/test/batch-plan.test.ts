import { describe, expect, it } from "vitest";
import { type MediaClip, parseBatchFile, parseSlotTarget, voiceoverOf, withRows } from "@frameshell/schema";
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
    [{ slots: { title: "c_card.title" } }, "slots.title: must be `<clipId>.asset`, `<clipId>.props.<path>`, `<clipId>.props` or `voiceover`"],
    [{ slots: { id: "c_card.asset" }, rows: [{ id: "es" }] }, "slots.id"],
    [{ slots: {} }, "slots: must name at least one slot"],
    [{ slots: { title: "c_card.props.__proto__.polluted" }, rows: [{ id: "es" }] }, "slots.title: a props path may not use `__proto__`"],
    [{ slots: { title: "c_card.props.constructor.prototype.x" }, rows: [{ id: "es" }] }, "slots.title: a props path may not use"],
    [{ slots: { constructor: "c_card.props.title" }, rows: [{ id: "es" }] }, "slots.constructor"],
    [{ rows: [] }, "rows:"],
  ])("refuses %j", (extra, message) => {
    const parsed = parseBatchFile(file(extra));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(message);
  });

  it("splits a slot into its clip and what it sets", () => {
    expect(parseSlotTarget("c_8f2.props.inputProps.title", "headline")).toEqual({ clip: "c_8f2", kind: "props", path: ["inputProps", "title"] });
    expect(parseSlotTarget("c_8f2.asset", "voice")).toEqual({ clip: "c_8f2", kind: "asset" });
    expect(parseSlotTarget("c_8f2.title", "title")).toBeNull();
  });

  it("takes the slot's own name as the prop when the slot names no path (`<clipId>.props`)", () => {
    expect(parseSlotTarget("c_8f2.props", "title")).toEqual({ clip: "c_8f2", kind: "props", path: ["title"] });
    const parsed = parseBatchFile(file({ slots: { title: "c_card.props", accent: "c_card.props" }, rows: [{ id: "es", title: "Hola", accent: "#ff0000" }] }));
    expect(parsed).toMatchObject({ ok: true, value: { slots: { title: "c_card.props" } } });
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

  it("never reaches a prototype: refuses its keys and creates own objects over inherited names", () => {
    expect(() => withValueAt({}, ["__proto__", "polluted"], "yes")).toThrow(/uses __proto__/);
    expect(() => withValueAt({}, ["constructor", "prototype", "polluted"], "yes")).toThrow(/uses constructor/);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(withValueAt({}, ["toString", "label"], "x")).toEqual({ toString: { label: "x" } });
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

describe("voiceover slot and CSV rows", () => {
  const voiced = (extra: Record<string, unknown> = {}) => file({ slots: { title: "c_card.props.title", vo: "voiceover" }, rows: [{ id: "es", vo: "scripts/vo-es.md" }], ...extra });

  it("reads `voiceover` as a slot target that names no clip, holding a script path or the object form", () => {
    expect(parseSlotTarget("voiceover", "vo")).toEqual({ kind: "voiceover" });
    expect(parseBatchFile(voiced())).toMatchObject({ ok: true });
    const object = { script: "scripts/vo-es.md", lines: ["hook-1"], at: { "hook-1": "hook+0.5" }, tempo: { "hook-1.2": 1.1 }, gap: 0.2 };
    expect(parseBatchFile(voiced({ rows: [{ id: "es", vo: object }] }))).toMatchObject({ ok: true });
    expect(voiceoverOf("scripts/vo-es.md")).toEqual({ script: "scripts/vo-es.md" });
    expect(voiceoverOf({ script: "scripts/vo-es.md", gap: 1 })).toEqual({ script: "scripts/vo-es.md", gap: 1 });
  });

  it.each([
    [{ rows: [{ id: "es", vo: 3 }] }, "rows.0.vo: a voiceover slot takes a voiceover script path"],
    [{ rows: [{ id: "es", vo: "" }] }, "rows.0.vo: a voiceover slot takes a voiceover script path"],
    [{ rows: [{ id: "es", vo: { script: "a.md", tempo: { "hook-1": 3 } } }] }, "rows.0.vo: a voiceover slot takes"],
    [{ rows: [{ id: "es", vo: { script: "a.md", dryRun: true } }] }, "rows.0.vo: a voiceover slot takes"],
    [{ slots: { a: "voiceover", b: "voiceover" }, rows: [{ id: "es" }] }, "slots: at most one slot may be `voiceover`"],
  ])("refuses %j", (extra, message) => {
    const parsed = parseBatchFile(voiced(extra));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(message);
  });

  it("takes `csv` instead of `rows`, never both and never neither", () => {
    const base = { schemaVersion: 1, slots: { title: "c_card.props.title" } };
    expect(parseBatchFile({ ...base, csv: "launch.csv" })).toMatchObject({ ok: true, value: { csv: "launch.csv" } });
    for (const extra of [{}, { csv: "launch.csv", rows: [{ id: "es" }] }]) {
      const parsed = parseBatchFile({ ...base, ...extra });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain("give `rows`");
    }
  });

  it("checks rows read from a CSV file like rows written in the file, and drops the csv name", () => {
    const parsed = parseBatchFile({ schemaVersion: 1, slots: { title: "c_card.props.title" }, csv: "launch.csv" });
    if (!parsed.ok) throw new Error(parsed.error);
    expect(withRows(parsed.value, [{ id: "es", title: "Hola" }])).toEqual({
      ok: true,
      value: { schemaVersion: 1, template: "main", slots: { title: "c_card.props.title" }, rows: [{ id: "es", title: "Hola" }] },
    });
    expect(withRows(parsed.value, [{ id: "es" }, { id: "es" }])).toMatchObject({ ok: false, error: "rows.1.id: row id es is used twice; ids name output files" });
    expect(withRows(parsed.value, [])).toMatchObject({ ok: false, error: "rows: has no rows" });
  });
});
