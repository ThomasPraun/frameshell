import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExportSource, compileFrame, gradeFiles } from "@frameshell/core";
import type { AssetInfo, TimelineView } from "@frameshell/protocol";
import type { Timeline } from "@frameshell/schema";
import type { ClipRenderInfo } from "@frameshell/protocol";
import { type GradeTable, type NormalizedGrade, gradeChainKey, gradeKey, gradeOf, gradeTable, parseCube } from "@frameshell/schema/grade";
import { describe, expect, it } from "vitest";
import { compileProgram, flattenView, programAt, tableKey, withNewTables } from "../src/renderer/src/preview/program.js";
import { gradeChains, tableOf } from "../src/renderer/src/preview/useGradeTables.js";

// Seam under test: a clip's colour grade (ADR 0031) in the preview program, against the table export writes for
// `lut3d` for the same timeline: footage, stills, generated renders and the pictures of graded nested timeline clips.
// The shader that samples it is checked in e2e `grade-preview.spec.ts`.

const FPS = 30;
const HD = { width: 1920, height: 1080 };
const TALK = "assets/talk.mp4";
const LOGO = "assets/logo.png";
const LUT = "luts/swap.cube";
const SWAP = ["LUT_3D_SIZE 2", ...[0, 1].flatMap((b) => [0, 1].flatMap((g) => [0, 1].map((r) => `${b} ${g} ${r}`)))].join("\n");

const asset = (path: string, still: boolean): AssetInfo => ({
  path,
  kind: "media",
  hash: `sha256:${path}`,
  state: "ready",
  error: null,
  media: { duration: still ? 0 : 600, format: still ? "png_pipe" : "mov,mp4", video: { codec: still ? "png" : "h264", width: 1920, height: 1080, fps: 30, vfr: false, still }, audio: null },
  proxy: still ? null : ".frameshell/proxies/talk.mp4",
  sidecar: null,
  waveform: null,
  thumbnails: null,
});
const assets = new Map([
  [TALK, asset(TALK, false)],
  [LOGO, asset(LOGO, true)],
]);

const WARM = { temperature: 0.4, contrast: 1.2 };
const LOOK = { saturation: 0.5, lut: LUT, lutMix: 0.7 };

/** Graded footage on v1, then ungraded footage; a graded still on v2. */
const timeline: Timeline = {
  schemaVersion: 1,
  id: "main",
  revision: 1,
  tracks: [
    {
      id: "v1",
      kind: "video",
      clips: [
        { id: "c_talk", type: "media", asset: TALK, start: 0, in: 0, out: 4, grade: WARM },
        { id: "c_plain", type: "media", asset: TALK, start: 4, in: 10, out: 12 },
      ],
    },
    { id: "v2", kind: "video", clips: [{ id: "c_logo", type: "media", asset: LOGO, start: 1, in: 0, out: 2, grade: LOOK, transform: { scale: 0.5 } }] },
  ],
};

function view(source: Timeline): TimelineView {
  const tracks = source.tracks.map((track) => ({
    ...track,
    name: null,
    follows: null,
    clips: "clips" in track ? track.clips.map((clip) => ({ ...clip, end: clip.start + ("out" in clip ? clip.out - clip.in : 1) })) : [],
  }));
  return { timeline: "main", path: "timelines/main.json", revision: 1, fps: FPS, duration: null, tracks, problems: [] } as unknown as TimelineView;
}

const key = (grade: object) => gradeKey(gradeOf({ type: "media", grade })!);
/** Key a span and `Program.grades` use: the grade's, and which table of it. */
const shown = (grade: object, tables: ReadonlyMap<string, GradeTable>) => tableKey(key(grade), tables.get(key(grade))!);

/** The tables `useGradeTables` makes for `chains`, every LUT being {@link SWAP}. */
const tablesOf = (chains: ReadonlyMap<string, NormalizedGrade[]>) =>
  new Map([...chains].map(([k, chain]) => [k, tableOf(k, chain.map((grade) => ({ grade, lut: grade.lut ? parseCube(SWAP) : null })))]));

describe("colour grade in the preview (ADR 0031)", () => {
  const grades = new Map([...gradeChains(view(timeline))].map(([k, chain]) => [k, chain[0]!]));
  const tables = tablesOf(gradeChains(view(timeline)));

  it("marks graded footage and stills with their grade's key and carries only the tables in use", () => {
    expect([...grades.keys()].sort()).toEqual([key(WARM), key(LOOK)].sort());
    const program = compileProgram(view(timeline), assets, { resolution: HD, grades: tables });
    expect(programAt(program, 15, 0)).toMatchObject({ kind: "media", clip: "c_talk", grade: shown(WARM, tables) });
    expect(programAt(program, 135, 0)).not.toHaveProperty("grade");
    expect(programAt(program, 45, 1)).toMatchObject({ kind: "still", clip: "c_logo", grade: shown(LOOK, tables) });
    expect(Object.keys(program.grades!).sort()).toEqual([shown(WARM, tables), shown(LOOK, tables)].sort());
  });

  it("draws a grade whose table is not ready ungraded, and a timeline without grades as before", () => {
    const partial = compileProgram(view(timeline), assets, { resolution: HD, grades: new Map([[key(WARM), tables.get(key(WARM))!]]) });
    expect(programAt(partial, 45, 1)).not.toHaveProperty("grade");
    expect(Object.keys(partial.grades!)).toEqual([shown(WARM, tables)]);
    const plain: Timeline = { ...timeline, tracks: [{ id: "v1", kind: "video", clips: [{ id: "c_plain", type: "media", asset: TALK, start: 0, in: 0, out: 4 }] }] };
    expect(compileProgram(view(plain), assets, { resolution: HD, grades: tables })).not.toHaveProperty("grades");
  });

  it("gives a grade's new table (its LUT edited) a new key, so the engine uploads it; the same table keeps its key", () => {
    const before = compileProgram(view(timeline), assets, { resolution: HD, grades: tables });
    expect(compileProgram(view(timeline), assets, { resolution: HD, grades: tables }).layers).toEqual(before.layers);
    const edited = new Map(tables).set(key(LOOK), gradeTable(grades.get(key(LOOK))!, parseCube(SWAP.replace("1 1 1", "1 1 0"))));
    const after = compileProgram(view(timeline), assets, { resolution: HD, grades: edited });
    const look = (program: typeof after) => (programAt(program, 45, 1) as { grade?: string }).grade!;
    expect(look(after)).not.toBe(look(before));
    expect(after.grades![look(after)]).toBe(edited.get(key(LOOK)));
    expect(programAt(after, 15, 0)).toMatchObject({ grade: shown(WARM, tables) });
  });

  it("sends the engine only the tables it has not had yet", () => {
    const program = compileProgram(view(timeline), assets, { resolution: HD, grades: tables });
    const all = new Set(Object.keys(program.grades!));
    expect(withNewTables(program, new Set()).grades).toEqual(program.grades);
    expect(withNewTables(program, all)).not.toHaveProperty("grades");
    expect(Object.keys(withNewTables(program, new Set([shown(WARM, tables)])).grades!)).toEqual([shown(LOOK, tables)]);
    expect(withNewTables(program, all).layers).toBe(program.layers);
  });

  it("uploads the very table export writes for lut3d, for the same clips", async () => {
    const root = mkdtempSync(join(tmpdir(), "grade-"));
    mkdirSync(join(root, "luts"));
    writeFileSync(join(root, LUT), SWAP);
    const written = await gradeFiles(root, timeline);
    for (const [k, file] of written.files) expect(parseCube(written.contents[file]!).data).toEqual(tables.get(k)!.data);
    const sources = new Map<string, ExportSource>([
      [TALK, { path: "/p/assets/talk.mp4", video: { codec: "h264", still: false, width: 1920, height: 1080 }, audio: false }],
      [LOGO, { path: "/p/assets/logo.png", video: { codec: "png", still: true, width: 1920, height: 1080 }, audio: false }],
    ]);
    const graph = compileFrame({ timeline, fps: FPS, sources, resolution: HD, grades: written.files, width: 960, height: 540, at: 1.5, output: "/out/f.png" }).args.join(" ");
    expect(graph).toContain(`lut3d=file=${written.files.get(key(WARM))}:interp=trilinear`);
    expect(graph).toContain(`lut3d=file=${written.files.get(key(LOOK))}:interp=trilinear`);
  });
});

describe("colour grade of generated clips and nested timeline clips in the preview (ADR 0031)", () => {
  const CARD = { exposure: 0.5 };
  const HOST = { saturation: 0.3, lut: LUT, lutMix: 0.5 };
  /** The nested scene: graded footage on its v1, a generated card on its v2. */
  const scene: Timeline = {
    schemaVersion: 1,
    id: "scene",
    revision: 1,
    tracks: [
      { id: "v1", kind: "video", clips: [{ id: "c_cam", type: "media", asset: TALK, start: 0, in: 0, out: 2, grade: WARM }] },
      { id: "v2", kind: "video", clips: [{ id: "c_card", type: "hyperframes", source: "c.html", start: 0, duration: 2, grade: CARD }] },
    ],
  };
  /** A graded card on v1, then the graded scene nested at 2 s. */
  const main: Timeline = {
    schemaVersion: 1,
    id: "main",
    revision: 1,
    tracks: [
      {
        id: "v1",
        kind: "video",
        clips: [
          { id: "c_title", type: "hyperframes", source: "t.html", start: 0, duration: 2, grade: CARD },
          { id: "c_scene", type: "timeline", source: "timelines/scene.json", start: 2, duration: 2, grade: HOST },
        ],
      },
    ],
  };
  const withEnds = (source: Timeline): TimelineView => {
    const tracks = source.tracks.map((track) => ({
      ...track,
      name: null,
      follows: null,
      clips: "clips" in track ? track.clips.map((clip) => ({ ...clip, end: clip.start + ("out" in clip ? clip.out - clip.in : (clip as { duration: number }).duration) })) : [],
    }));
    return { timeline: source.id, path: `timelines/${source.id}.json`, revision: 1, fps: FPS, duration: null, tracks, problems: [] } as unknown as TimelineView;
  };
  const nested = new Map([["timelines/scene.json", withEnds(scene)]]);
  const ready = (clip: string): ClipRenderInfo => ({
    clip,
    track: "v1",
    type: "hyperframes",
    source: "c.html",
    state: "ready",
    key: clip,
    file: `.frameshell/cache/clips/${clip}.webm`,
    hasAlpha: true,
    width: 1920,
    height: 1080,
    duration: 2,
    job: null,
    progress: 1,
    error: null,
  });
  const renders = new Map(["c_title", "c_scene/c_card"].map((clip) => [clip, ready(clip)]));
  const chains = gradeChains(withEnds(main), nested);
  const tables = tablesOf(chains);
  const chainKey = (...grades: object[]) => gradeChainKey(grades.map((grade) => gradeOf({ type: "media", grade })!));

  it("grades a generated render, and every picture of a graded nested clip after its own grade", () => {
    expect([...chains.keys()].sort()).toEqual([chainKey(CARD), chainKey(WARM, HOST), chainKey(CARD, HOST)].sort());
    const program = compileProgram(withEnds(main), assets, { resolution: HD, nested, renders, grades: tables });
    const shown = (k: string) => tableKey(k, tables.get(k)!);
    expect(programAt(program, 15, 0)).toMatchObject({ kind: "generated", clip: "c_title", grade: shown(chainKey(CARD)) });
    expect(programAt(program, 75, 0)).toMatchObject({ kind: "media", clip: "c_scene/c_cam", grade: shown(chainKey(WARM, HOST)) });
    expect(programAt(program, 75, 1)).toMatchObject({ kind: "generated", clip: "c_scene/c_card", grade: shown(chainKey(CARD, HOST)) });
    expect(Object.keys(program.grades!)).toHaveLength(3);
  });

  it("uploads the tables export writes for the same flattened timeline", async () => {
    const root = mkdtempSync(join(tmpdir(), "grade-nested-"));
    mkdirSync(join(root, "luts"));
    writeFileSync(join(root, LUT), SWAP);
    try {
      const written = await gradeFiles(root, flattenView(withEnds(main), nested));
      expect([...written.files.keys()].sort()).toEqual([...chains.keys()].sort());
      for (const [k, file] of written.files) expect(parseCube(written.contents[file]!).data).toEqual(tables.get(k)!.data);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
