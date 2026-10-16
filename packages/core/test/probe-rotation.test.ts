import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { probeMedia } from "../src/media/ffmpeg.js";
import { tempDir } from "./helpers.js";
import { mediaTools, run } from "./media-tools.js";

const MEDIA_TIMEOUT = 120_000;

describe("probeMedia of rotated video (#207)", () => {
  it(
    "reports the size ffmpeg decodes: width and height swapped for a quarter turn, kept for a half turn",
    async () => {
      const { ffmpeg, ffprobe } = await mediaTools();
      const dir = tempDir();
      const flat = join(dir, "flat.mp4");
      await run(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30", "-t", "0.5", "-c:v", "libx264", flat]);
      const sizes: Record<string, [number, number]> = {};
      for (const degrees of [0, 90, 180, 270]) {
        const out = join(dir, `r${degrees}.mp4`);
        await run(ffmpeg, ["-v", "error", "-y", "-display_rotation", String(degrees), "-i", flat, "-c", "copy", out]);
        const { video } = await probeMedia(ffprobe, out);
        sizes[degrees] = [video?.width ?? 0, video?.height ?? 0];
      }
      expect(sizes).toEqual({ 0: [320, 180], 90: [180, 320], 180: [320, 180], 270: [180, 320] });
    },
    MEDIA_TIMEOUT,
  );
});
