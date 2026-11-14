import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ErrorCode } from "@frameshell/protocol";
import { type Grade, type Timeline, applyGradeTable, gradeOf, gradeTable, parseCube } from "@frameshell/schema";
import { type ExportSource, compileFrame, gradeFiles } from "../src/index.js";
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
async function exported(timeline: Timeline): Promise<Buffer> {
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
    width: W,
    height: H,
    at: 0,
    output: out,
  });
  for (const [name, text] of Object.entries({ ...plan.files, ...grades.contents })) writeFileSync(join(work, name), text);
  await runTool(ffmpeg, plan.args, { cwd: work });
  return runBuffer(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", out, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
}

/** Max channel difference and the channels that differ at all, of `actual` against `source` through `table`. */
function compare(actual: Buffer, grade: Grade): { max: number; differing: number } {
  const lut = parseCube(lookCube());
  const table = gradeTable(gradeOf({ type: "media", grade })!, grade.lut ? lut : null);
  let max = 0;
  let differing = 0;
  for (let i = 0; i < source.length; i += 3) {
    const want = applyGradeTable(table, [source[i]!, source[i + 1]!, source[i + 2]!]);
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
