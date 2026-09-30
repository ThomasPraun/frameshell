import { execFile } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { BinaryManager } from "@frameshell/core";
import type { RenderProgress } from "@frameshell/plugin-api";
import { createHyperframesAdapter, newComposition } from "../src/index.js";

// Opt-in: renders a scaffolded composition for real (in-process producer, managed ffmpeg and headless Chrome,
// ~100 MB Chrome download on first run, kept under .cache/test-binaries). Run with
// FRAMESHELL_TEST_REAL_HYPERFRAMES=1 pnpm test.
const execFileAsync = promisify(execFile);

function tempDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "frameshell-hyperframes-real-")));
}

/** Same store as the core media tests (`FRAMESHELL_TEST_BINARIES_DIR` overrides). */
function binaries(): BinaryManager {
  const dir = process.env["FRAMESHELL_TEST_BINARIES_DIR"] || fileURLToPath(new URL("../../../.cache/test-binaries", import.meta.url));
  return new BinaryManager({ dataDir: dir, configDir: dir });
}

describe.runIf(process.env["FRAMESHELL_TEST_REAL_HYPERFRAMES"] === "1")("real HyperFrames render", () => {
  it(
    "renders the scaffold to VP9 WebM with alpha: transparent around the card, the card fading in on the composition clock",
    async () => {
      const project = tempDir();
      writeFileSync(join(project, "frameshell.json"), JSON.stringify({ resolution: { width: 320, height: 180 } }));
      await newComposition.run({ args: ["card", "--duration", "1"], cwd: project, project: { dir: project } });
      const manager = binaries();
      const ffmpeg = await manager.ensure("ffmpeg");
      const ffprobe = await manager.ensure("ffprobe");
      const adapter = createHyperframesAdapter({ projectDir: project });
      const progress: RenderProgress[] = [];
      const result = await adapter.render(
        { id: "c_card", source: "compositions/hyperframes/card/index.html", props: { title: "Launch" } },
        {
          projectDir: project,
          outDir: tempDir(),
          fps: 30,
          width: 320,
          height: 180,
          signal: new AbortController().signal,
          ensureBinary: (name) => manager.ensure(name),
          progress: (update) => progress.push(update),
        },
      );
      expect(result.hasAlpha).toBe(true);
      expect(progress.at(-1)?.fraction).toBe(1);

      const { stdout } = await execFileAsync(ffprobe, [
        ...["-v", "error", "-select_streams", "v:0", "-count_packets"],
        ...["-show_entries", "stream=codec_name,width,height,nb_read_packets:stream_tags=alpha_mode", "-of", "json", result.file],
      ]);
      const [stream] = (JSON.parse(stdout) as { streams: { codec_name: string; width: number; height: number; nb_read_packets: string; tags?: Record<string, string> }[] }).streams;
      expect(stream).toMatchObject({ codec_name: "vp9", width: 320, height: 180 });
      // The producer writes the tag upper case; ffmpeg lower case: either marks VP9 alpha.
      expect(stream!.tags?.["alpha_mode"] ?? stream!.tags?.["ALPHA_MODE"]).toBe("1");
      expect(Number(stream!.nb_read_packets)).toBe(30);

      /** Alpha 0..255 of pixel (x, y) at `t` seconds, decoded with libvpx (the native vp9 decoder drops alpha). */
      const alpha = async (t: number, x: number, y: number) => {
        const { stdout: raw } = await execFileAsync(
          ffmpeg,
          ["-v", "error", "-c:v", "libvpx-vp9", "-ss", String(t), "-i", result.file, "-frames:v", "1", "-vf", `crop=1:1:${x}:${y},format=rgba`, "-f", "rawvideo", "-"],
          { encoding: "buffer" },
        );
        return raw[3]!;
      };
      // Card: left 6% (19 px), bottom 10% (18 px), 0.72 opaque background, faded in over 0.6 s.
      expect(await alpha(0.8, 4, 4)).toBe(0);
      expect(await alpha(0.8, 30, 150)).toBeGreaterThan(150);
      expect(await alpha(0, 30, 150)).toBeLessThan(await alpha(0.8, 30, 150));
    },
    600_000,
  );
});
