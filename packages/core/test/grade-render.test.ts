import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ErrorCode } from "@frameshell/protocol";
import {
  type Grade,
  type GradeTable,
  type Timeline,
  applyGradeTable,
  flattenTimeline,
  gradeChainTable,
  gradeOf,
  gradeTable,
  normalizeGrade,
  parseCube,
} from "@frameshell/schema";
import { type ExportSource, type GeneratedSource, compileFrame, gradeFiles } from "../src/index.js";
import { runTool } from "../src/media/ffmpeg.js";
import { tempDir } from "./helpers.js";
import { mediaTools, run, runBuffer } from "./media-tools.js";

// Export side of the grade parity (ADR 0031, #384): the managed ffmpeg's `lut3d` on the compiled frame graph against
// `applyGradeTable`, the steps the preview's shader runs. A still in RGB keeps YUV out of the comparison.
const MEDIA_TIMEOUT = 180_000;
const W = 96;
const H = 64;

let root: string;
let ffmpeg: string;
let source: Buffer;

/** A 17-point look with a cross-channel twist and an S-curve, so lattice interpolation shows. */
function lookCube(): string {
  const size = 17;
  const lines = ["TITLE \"test look\"", `LUT_3D_SIZE ${size}`];
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const [x, y, z] = [r / (size - 1), g / (size - 1), b / (size - 1)];
        const curve = (v: number) => v * v * (3 - 2 * v);
        lines.push([curve(0.8 * x + 0.2 * z), curve(0.9 * y + 0.1 * x), 0.7 * z + 0.3 * y * y].map((v) => v.toFixed(6)).join(" "));
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

const LOOK: Grade = { exposure: 0.4, temperature: 0.35, tint: -0.2, contrast: 1.3, saturation: 1.4, lut: "luts/look.cube", lutMix: 0.8 };

beforeAll(async () => {
  root = tempDir();
  ({ ffmpeg } = await mediaTools());
  // Every pixel random (fixed seed), plus a grey ramp in the first row: the whole table gets sampled.
  source = Buffer.alloc(W * H * 3);
  let seed = 384;
  const next = () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed >>> 24;
  };
  for (let i = 0; i < source.length; i++) source[i] = next();
  for (let x = 0; x < W; x++) source.fill(Math.round((x / (W - 1)) * 255), x * 3, x * 3 + 3);
  mkdirSync(join(root, "assets"), { recursive: true });
  mkdirSync(join(root, "luts"), { recursive: true });
  writeFileSync(join(root, "noise.rgb"), source);
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${W}x${H}`, "-i", join(root, "noise.rgb"), join(root, "assets", "noise.png")]);
  writeFileSync(join(root, "luts", "look.cube"), lookCube());
}, MEDIA_TIMEOUT);

const stillSource = (): ExportSource => ({ path: join(root, "assets", "noise.png"), video: { codec: "png", still: true, width: W, height: H }, audio: false });

const graded = (grade: Grade, upper = false): Timeline => {
  const clip = { id: "c_still", type: "media" as const, asset: "assets/noise.png", start: 0, in: 0, out: 1, grade };
  const base = { id: "c_base", type: "media" as const, asset: "assets/noise.png", start: 0, in: 0, out: 1 };
  return {
    schemaVersion: 1,
    id: "main",
    revision: 1,
    tracks: upper
      ? [
          { id: "v1", kind: "video", clips: [base] },
          { id: "v2", kind: "video", clips: [clip] },
        ]
      : [{ id: "v1", kind: "video", clips: [clip] }],
  };
};

/** RGB bytes of the frame export captures of `timeline`, through the same steps as `ExportService` (tables in the work dir). */
async function exported(timeline: Timeline, generated?: ReadonlyMap<string, GeneratedSource>): Promise<Buffer> {
  const grades = await gradeFiles(root, timeline);
  const work = join(root, "work", String(Math.random()).slice(2));
  mkdirSync(work, { recursive: true });
  const out = join(work, "frame.png");
  const plan = compileFrame({
    timeline,
    fps: 30,
    sources: new Map([["assets/noise.png", stillSource()]]),
    resolution: { width: W, height: H },
    grades: grades.files,
    ...(generated ? { generated } : {}),
    width: W,
    height: H,
    at: 0,
    output: out,
  });
  for (const [name, text] of Object.entries({ ...plan.files, ...grades.contents })) writeFileSync(join(work, name), text);
  await runTool(ffmpeg, plan.args, { cwd: work });
  return runBuffer(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", out, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
}

/** Max channel difference and the channels that differ at all, of `actual` against `source` through `grade`'s table. */
function compare(actual: Buffer, grade: Grade): { max: number; differing: number } {
  const lut = parseCube(lookCube());
  return compareTable(actual, gradeTable(gradeOf({ type: "media", grade })!, grade.lut ? lut : null));
}

/** Max channel difference and the channels that differ at all, of `actual` against `expected` (default `source`) through `table`. */
function compareTable(actual: Buffer, table: GradeTable, expected: Buffer = source): { max: number; differing: number } {
  let max = 0;
  let differing = 0;
  for (let i = 0; i < expected.length; i += 3) {
    const want = applyGradeTable(table, [expected[i]!, expected[i + 1]!, expected[i + 2]!]);
    for (let c = 0; c < 3; c++) {
      const diff = Math.abs(actual[i + c]! - want[c]!);
      max = Math.max(max, diff);
      if (diff > 0) differing++;
    }
  }
  return { max, differing };
}

describe("colour grade export (real ffmpeg, ADR 0031)", () => {
  it(
    "lut3d of the compiled frame matches applyGradeTable: at most 1 level off, on almost no channel",
    async () => {
      for (const upper of [false, true]) {
        const { max, differing } = compare(await exported(graded(LOOK, upper)), LOOK);
        expect(max, upper ? "upper track" : "bottom track").toBeLessThanOrEqual(1);
        expect(differing / source.length).toBeLessThan(0.001);
      }
      // Correction only: a 33-point table of its own.
      const correction: Grade = { exposure: -0.5, contrast: 0.8, saturation: 0.3 };
      const { max } = compare(await exported(graded(correction)), correction);
      expect(max).toBeLessThanOrEqual(1);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "grades the pictures of a graded nested timeline clip through one table of both grades, as applyGradeTable does",
    async () => {
      const HOST: Grade = { exposure: -0.3, temperature: -0.25, saturation: 0.8, lut: "luts/look.cube", lutMix: 0.4 };
      const scene = { ...graded(LOOK), id: "scene" };
      const main: Timeline = {
        schemaVersion: 1,
        id: "main",
        revision: 1,
        tracks: [{ id: "v1", kind: "video", clips: [{ id: "c_scene", type: "timeline", source: "timelines/scene.json", start: 0, duration: 1, grade: HOST }] }],
      };
      const flat = flattenTimeline(main, (path) => (path === "timelines/scene.json" ? scene : null), 30);
      const lut = parseCube(lookCube());
      const table = gradeChainTable([LOOK, HOST].map((grade) => ({ grade: normalizeGrade(grade), lut })));
      const { max, differing } = compareTable(await exported(flat), table);
      expect(max).toBeLessThanOrEqual(1);
      expect(differing / source.length).toBeLessThan(0.001);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "grades a generated render's colour and keeps its alpha: transparent pixels stay what is below",
    async () => {
      // A VP9 render of the noise, opaque on its left half and transparent on its right, as HyperFrames writes them.
      const rgba = Buffer.alloc(W * H * 4);
      for (let p = 0; p < W * H; p++) {
        source.copy(rgba, p * 4, p * 3, p * 3 + 3);
        rgba[p * 4 + 3] = p % W < W / 2 ? 255 : 0;
      }
      writeFileSync(join(root, "card.rgba"), rgba);
      const render = join(root, "card.webm");
      await run(ffmpeg, [
        ...["-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${W}x${H}`, "-r", "30", "-i", join(root, "card.rgba")],
        ...["-frames:v", "2", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", "-lossless", "1", render],
      ]);
      const generated = new Map<string, GeneratedSource>([["c_card", { path: render, hasAlpha: true, width: W, height: H }]]);
      // On an upper track over the ungraded noise: alpha shows on upper tracks (the bottom track is drawn opaque).
      const card = (grade?: Grade): Timeline => ({
        schemaVersion: 1,
        id: "main",
        revision: 1,
        tracks: [
          { id: "v1", kind: "video", clips: [{ id: "c_base", type: "media", asset: "assets/noise.png", start: 0, in: 0, out: 1 }] },
          { id: "v2", kind: "video", clips: [{ id: "c_card", type: "hyperframes", source: "c.html", start: 0, duration: 1, ...(grade ? { grade } : {}) }] },
        ],
      });
      const correction: Grade = { exposure: 0.4, temperature: 0.3, contrast: 1.2 };
      const plain = await exported(card(), generated);
      const look = await exported(card(correction), generated);
      const table = gradeTable(normalizeGrade(correction), null);
      let max = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 3;
          const pixel: [number, number, number] = [plain[i]!, plain[i + 1]!, plain[i + 2]!];
          if (x >= W / 2) {
            // Transparent: the picture below, untouched by the card's grade.
            expect([look[i], look[i + 1], look[i + 2]]).toEqual(pixel);
            continue;
          }
          const want = applyGradeTable(table, pixel);
          for (let c = 0; c < 3; c++) max = Math.max(max, Math.abs(look[i + c]! - want[c]!));
        }
      }
      // The decoded colour reaches lut3d as RGBA, and reaches the ungraded frame through the same conversion.
      expect(max).toBeLessThanOrEqual(1);
    },
    MEDIA_TIMEOUT,
  );

  it("refuses a LUT that is missing, outside the project or not a 3D .cube, naming the clip", async () => {
    for (const [lut, reason] of [
      ["luts/none.cube", "no such file"],
      ["../outside.cube", "outside the project"],
      ["luts/flat.cube", "1D LUTs are not supported"],
    ] as const) {
      writeFileSync(join(root, "luts", "flat.cube"), "LUT_1D_SIZE 2\n0 0 0\n1 1 1\n");
      const error = await gradeFiles(root, graded({ lut })).then(
        () => null,
        (thrown: unknown) => thrown as { code: number; message: string },
      );
      expect(error?.code).toBe(ErrorCode.ExportUnsupported);
      expect(error?.message).toContain(`Clip c_still grades with LUT ${lut}`);
      expect(error?.message).toContain(reason);
    }
  });
});
