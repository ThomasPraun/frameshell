import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExportSource, compileFrame, gradeFiles } from "@frameshell/core";
import type { AssetInfo, TimelineView } from "@frameshell/protocol";
import type { Timeline } from "@frameshell/schema";
import { gradeKey, gradeOf, parseCube } from "@frameshell/schema/grade";
import { describe, expect, it } from "vitest";
import { compileProgram, programAt } from "../src/renderer/src/preview/program.js";
import { gradesOf, tableOf } from "../src/renderer/src/preview/useGradeTables.js";

// Seam under test: a media clip's colour grade (ADR 0031) in the preview program, against the table export writes
// for `lut3d` for the same timeline. The shader that samples it is checked in e2e `grade-preview.spec.ts`.

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

describe("colour grade in the preview (ADR 0031)", () => {
  const grades = gradesOf([view(timeline)]);
  const tables = new Map([...grades].map(([k, grade]) => [k, tableOf(k, grade, grade.lut ? parseCube(SWAP) : null)]));

  it("marks graded footage and stills with their grade's key and carries only the tables in use", () => {
    expect([...grades.keys()].sort()).toEqual([key(WARM), key(LOOK)].sort());
    const program = compileProgram(view(timeline), assets, { resolution: HD, grades: tables });
    expect(programAt(program, 15, 0)).toMatchObject({ kind: "media", clip: "c_talk", grade: key(WARM) });
    expect(programAt(program, 135, 0)).not.toHaveProperty("grade");
    expect(programAt(program, 45, 1)).toMatchObject({ kind: "still", clip: "c_logo", grade: key(LOOK) });
    expect(Object.keys(program.grades!).sort()).toEqual([key(WARM), key(LOOK)].sort());
  });

  it("draws a grade whose table is not ready ungraded, and a timeline without grades as before", () => {
    const partial = compileProgram(view(timeline), assets, { resolution: HD, grades: new Map([[key(WARM), tables.get(key(WARM))!]]) });
    expect(programAt(partial, 45, 1)).not.toHaveProperty("grade");
    expect(Object.keys(partial.grades!)).toEqual([key(WARM)]);
    const plain: Timeline = { ...timeline, tracks: [{ id: "v1", kind: "video", clips: [{ id: "c_plain", type: "media", asset: TALK, start: 0, in: 0, out: 4 }] }] };
    expect(compileProgram(view(plain), assets, { resolution: HD, grades: tables })).not.toHaveProperty("grades");
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
