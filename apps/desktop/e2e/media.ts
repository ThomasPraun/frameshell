// Synthetic media for preview tests (never committed): frames carry a machine-readable barcode of their index,
// audio is a clean sine, so what the preview shows and plays can be checked exactly (ADR 0001 harness).
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BinaryManager } from "@frameshell/core";

const run = promisify(execFile);

/**
 * Managed ffmpeg shared by media tests: downloaded once per machine into
 * `.cache/test-binaries` (CI caches it); `FRAMESHELL_TEST_BINARIES_DIR` overrides.
 */
export function testBinariesDir(): string {
  return process.env["FRAMESHELL_TEST_BINARIES_DIR"] || fileURLToPath(new URL("../../../.cache/test-binaries", import.meta.url));
}

/** Absolute path of the managed ffmpeg, installing it first when missing. */
export async function testFfmpeg(): Promise<string> {
  const dir = testBinariesDir();
  return new BinaryManager({ dataDir: dir, configDir: dir }).ensure("ffmpeg");
}

/** Barcode geometry, relative to the frame: 16 cells of 1/24 width; row 0 = bits of the frame index, row 1 = complement. */
export const BARCODE = { cells: 16, cellWidth: 1 / 24, rowHeight: 1 / 27 } as const;

/** Sine of the synthetic sound: 220 Hz at 0.5, so any splice without a fade is a sample jump above 0.05 (ADR 0001). */
export const TONE = { hz: 220, amplitude: 0.5 } as const;

/**
 * Write a synthetic source: `testsrc2` with the frame barcode at the top left,
 * `seconds` long at `fps`, plus a continuous {@link TONE}. Long GOP, like a
 * camera file: the proxy recipe has to re-encode it.
 */
export async function makeSource(
  ffmpeg: string,
  out: string,
  { seconds, fps = 30, width = 960, height = 540 }: { seconds: number; fps?: number; width?: number; height?: number },
): Promise<void> {
  const cell = Math.round(width * BARCODE.cellWidth);
  const row = Math.round(height * BARCODE.rowHeight);
  const bit = `mod(floor(N/pow(2,floor(X/${cell}))),2)`;
  const barcode =
    `color=c=black:s=${cell * BARCODE.cells}x${row * 2}:r=${fps}:d=${seconds},format=gray,` +
    `geq=lum='if(lt(Y,${row}),255*${bit},255*(1-${bit}))'`;
  await run(
    ffmpeg,
    [
      ...["-hide_banner", "-loglevel", "error", "-y"],
      ...["-f", "lavfi", "-i", `testsrc2=s=${width}x${height}:r=${fps}:d=${seconds}`],
      ...["-f", "lavfi", "-i", barcode],
      ...["-f", "lavfi", "-i", `aevalsrc=${TONE.amplitude}*sin(2*PI*${TONE.hz}*t):s=48000:d=${seconds}`],
      ...["-filter_complex", "[0:v][1:v]overlay=0:0:shortest=1[v]", "-map", "[v]", "-map", "2:a"],
      ...["-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-g", "300", "-pix_fmt", "yuv420p"],
      ...["-c:a", "aac", "-b:a", "192k", out],
    ],
    { maxBuffer: 64 << 20, windowsHide: true },
  );
}

/** Run ffmpeg with `args` to completion; rejects with its stderr. */
export async function ffmpegRun(ffmpeg: string, args: string[]): Promise<void> {
  await run(ffmpeg, args, { maxBuffer: 64 << 20, windowsHide: true });
}
