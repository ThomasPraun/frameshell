// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { connectToDaemon } from "@frameshell/protocol";
import type { Sandbox } from "./harness.js";
import { ffmpegRun, testFfmpeg } from "./media.js";

// Preview vs export frame comparison (#17): the preview canvas and a `frameshell frame` capture, both as RGB bytes of
// the same size (the project resolution must equal the preview canvas: 540 px short side).

/** Frame size, px. */
export interface FrameSize {
  width: number;
  height: number;
}

/** RGB bytes of what the preview canvas shows, `size` px. */
export async function previewPixels(page: Page, size: FrameSize): Promise<Buffer> {
  const base64 = await page.evaluate(
    ([width, height]) => {
      const canvas = document.querySelector<HTMLCanvasElement>(".preview-canvas")!;
      const copy = document.createElement("canvas");
      copy.width = width!;
      copy.height = height!;
      const context = copy.getContext("2d")!;
      context.drawImage(canvas, 0, 0);
      const rgba = context.getImageData(0, 0, width!, height!).data;
      let binary = "";
      for (let i = 0; i < rgba.length; i += 4) binary += String.fromCharCode(rgba[i]!, rgba[i + 1]!, rgba[i + 2]!);
      return btoa(binary);
    },
    [size.width, size.height],
  );
  return Buffer.from(base64, "base64");
}

/** RGB bytes of the frame `frameshell frame` captures at `at` seconds (daemon `frame`, the export compiler's path). */
export async function exportedPixels(box: Sandbox, at: number): Promise<Buffer> {
  const connection = await connectToDaemon(box.socketPath, { client: "e2e/frames" });
  const out = join(box.dataDir, `frame-${at}.png`);
  try {
    await connection.request("frame", { cwd: box.projectDir, at, out });
  } finally {
    connection.close();
  }
  const raw = join(box.dataDir, `frame-${at}.rgb`);
  await ffmpegRun(await testFfmpeg(), ["-hide_banner", "-loglevel", "error", "-y", "-i", out, "-f", "rawvideo", "-pix_fmt", "rgb24", raw]);
  return readFileSync(raw);
}

/** Mean RGB of a `block` px square of `pixels` (RGB, `size`) at x, y. */
export function blockMean(pixels: Buffer, size: FrameSize, x: number, y: number, block: number): [number, number, number] {
  const sum = [0, 0, 0];
  for (let row = y; row < y + block; row++) {
    for (let col = x; col < x + block; col++) for (let c = 0; c < 3; c++) sum[c]! += pixels[(row * size.width + col) * 3 + c]!;
  }
  return sum.map((total) => total / (block * block)) as [number, number, number];
}

/** Mean and worst per-channel difference of 16 px block means between two frames, and where the worst is. */
export function blockDiff(a: Buffer, b: Buffer, size: FrameSize): { mean: number; worst: number; worstAt: string } {
  let worst = 0;
  let worstAt = "";
  let total = 0;
  let blocks = 0;
  for (let y = 0; y + 16 <= size.height; y += 16) {
    for (let x = 0; x + 16 <= size.width; x += 16) {
      const p = blockMean(a, size, x, y, 16);
      const q = blockMean(b, size, x, y, 16);
      const diff = Math.max(...p.map((value, c) => Math.abs(value - q[c]!)));
      total += diff;
      blocks++;
      if (diff > worst) [worst, worstAt] = [diff, `${x},${y}`];
    }
  }
  return { mean: total / blocks, worst, worstAt };
}
