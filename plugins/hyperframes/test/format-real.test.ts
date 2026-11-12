import { execFile } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { BinaryManager } from "@frameshell/core";
import { createHyperframesAdapter, newComposition } from "../src/index.js";

// Opt-in like render-real (FRAMESHELL_TEST_REAL_HYPERFRAMES=1): renders at a format size (ADR 0027 decision 8) with the
// producer in use. A composition scaffolded at 16:9 and rendered at 9:16 must give the frames of one scaffolded at 9:16.
const execFileAsync = promisify(execFile);
const tempDir = () => realpathSync(mkdtempSync(join(tmpdir(), "frameshell-format-real-")));
const binaries = () => {
  const dir = process.env["FRAMESHELL_TEST_BINARIES_DIR"] || fileURLToPath(new URL("../../../.cache/test-binaries", import.meta.url));
  return new BinaryManager({ dataDir: dir, configDir: dir });
};
const clip = { id: "c_spot", source: "compositions/hyperframes/spot/index.html" };

async function scaffold(width: number, height: number, template?: string): Promise<string> {
  const dir = tempDir();
  writeFileSync(join(dir, "frameshell.json"), JSON.stringify({ resolution: { width, height } }));
  await newComposition.run({ args: ["spot", ...(template ? ["--template", template] : []), "--duration", "2"], cwd: dir, project: { dir } });
  return dir;
}

describe.runIf(process.env["FRAMESHELL_TEST_REAL_HYPERFRAMES"] === "1")("HyperFrames render at a format size", () => {
  const manager = binaries();

  async function render(project: string, width: number, height: number): Promise<string> {
    const adapter = createHyperframesAdapter({ projectDir: project });
    const result = await adapter.render(clip, {
      projectDir: project,
      outDir: tempDir(),
      fps: 30,
      width,
      height,
      signal: new AbortController().signal,
      ensureBinary: (name) => manager.ensure(name),
      progress: () => {},
    });
    return result.file;
  }

  async function size(file: string): Promise<{ width: number; height: number }> {
    const { stdout } = await execFileAsync(await manager.ensure("ffprobe"), [
      ...["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", file],
    ]);
    return (JSON.parse(stdout) as { streams: { width: number; height: number }[] }).streams[0]!;
  }

  /** RGBA bytes of the frame at `t`, decoded with libvpx (keeps alpha). */
  async function frame(file: string, t: number): Promise<Buffer> {
    const { stdout } = await execFileAsync(
      await manager.ensure("ffmpeg"),
      ["-v", "error", "-c:v", "libvpx-vp9", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", "format=rgba", "-f", "rawvideo", "-"],
      { encoding: "buffer", maxBuffer: 1 << 26 },
    );
    return stdout;
  }

  it(
    "renders the plain scaffold at the format size, the card inside the tall frame",
    async () => {
      const file = await render(await scaffold(320, 180), 180, 320);
      expect(await size(file)).toEqual({ width: 180, height: 320 });
      const rgba = await frame(file, 1.5);
      const alpha = (x: number, y: number) => rgba[(y * 180 + x) * 4 + 3]!;
      // Card: left 6%, bottom 10% of the 320 px tall frame.
      expect(alpha(4, 4)).toBe(0);
      expect(alpha(20, 280)).toBeGreaterThan(150);
    },
    600_000,
  );

  it.each([
    ["lower-third", 270, 480],
    ["end-card", 270, 480],
    ["end-card", 360, 360],
  ])(
    "renders %s scaffolded at 16:9 at %ix%i as the same template scaffolded there (pick() sees the format)",
    async (template, width, height) => {
      const resized = await render(await scaffold(480, 270, template), width, height);
      const native = await render(await scaffold(width, height, template), width, height);
      expect(await size(resized)).toEqual({ width, height });
      let worst = 0;
      let drawn = 0;
      for (const t of [0.3, 0.8, 1.5]) {
        const [a, b] = [await frame(resized, t), await frame(native, t)];
        expect(a.length).toBe(b.length);
        for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i]! - b[i]!));
        for (let i = 3; i < a.length; i += 4) if (a[i]! > 200) drawn++;
      }
      expect(drawn).toBeGreaterThan(width * height * 0.002);
      expect(worst).toBeLessThanOrEqual(2);
    },
    600_000,
  );
});
