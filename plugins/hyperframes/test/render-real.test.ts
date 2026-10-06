import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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

  it(
    "applies the composition's declared variable defaults, with clip props merged over them (#116)",
    async () => {
      const project = tempDir();
      const dir = join(project, "compositions", "hyperframes", "swatch");
      mkdirSync(dir, { recursive: true });
      const declared = [
        { id: "left", type: "color", label: "Left", default: "#ff0000" },
        { id: "right", type: "color", label: "Right", default: "#ff0000" },
      ];
      writeFileSync(
        join(dir, "index.html"),
        `<!doctype html>
<html data-composition-variables='${JSON.stringify(declared)}'>
  <head>
    <style>
      * { margin: 0; padding: 0; }
      html, body { width: 160px; height: 90px; overflow: hidden; }
      #stage { position: relative; width: 100%; height: 100%; }
      .clip { position: absolute; inset: 0; }
      #left, #right { position: absolute; top: 0; width: 80px; height: 90px; }
      #left { left: 0; } #right { left: 80px; }
    </style>
  </head>
  <body>
    <div id="stage" data-composition-id="swatch" data-width="160" data-height="90" data-duration="0.2">
      <div class="clip" data-start="0" data-duration="0.2" data-track-index="0"><div id="left"></div><div id="right"></div></div>
    </div>
    <script>
      var vars = window.__hyperframes.getVariables();
      document.getElementById("left").style.background = vars.left || "transparent";
      document.getElementById("right").style.background = vars.right || "transparent";
    </script>
  </body>
</html>
`,
      );
      const manager = binaries();
      const ffmpeg = await manager.ensure("ffmpeg");
      const adapter = createHyperframesAdapter({ projectDir: project });
      const render = (props?: Record<string, unknown>) =>
        adapter.render(
          { id: "c_swatch", source: "compositions/hyperframes/swatch/index.html", ...(props ? { props } : {}) },
          {
            projectDir: project,
            outDir: tempDir(),
            fps: 30,
            width: 160,
            height: 90,
            signal: new AbortController().signal,
            ensureBinary: (name) => manager.ensure(name),
            progress: () => {},
          },
        );
      /** Colour of pixel (x, y) in the first frame, decoded with libvpx (keeps alpha); VP9 is lossy, so thresholds. */
      const colour = async (file: string, x: number, y: number) => {
        const { stdout: raw } = await execFileAsync(
          ffmpeg,
          ["-v", "error", "-c:v", "libvpx-vp9", "-i", file, "-frames:v", "1", "-vf", `format=rgba,crop=1:1:${x}:${y}`, "-f", "rawvideo", "-"],
          { encoding: "buffer" },
        );
        const [r, g, b, a] = [raw[0]!, raw[1]!, raw[2]!, raw[3]!];
        if (a < 200) return `transparent (${r},${g},${b},${a})`;
        if (r > 180 && g < 80 && b < 80) return "red";
        if (b > 180 && r < 80 && g < 80) return "blue";
        return `other (${r},${g},${b},${a})`;
      };

      // No props: both halves take the declared default.
      const plain = await render();
      expect([await colour(plain.file, 40, 45), await colour(plain.file, 120, 45)]).toEqual(["red", "red"]);
      // Partial props: the prop wins, the other variable keeps its default.
      const merged = await render({ right: "#0000ff" });
      expect([await colour(merged.file, 40, 45), await colour(merged.file, 120, 45)]).toEqual(["red", "blue"]);
    },
    600_000,
  );

  it(
    "renders the scaffold's default title when the clip has no props (#116)",
    async () => {
      const project = tempDir();
      writeFileSync(join(project, "frameshell.json"), JSON.stringify({ resolution: { width: 320, height: 180 } }));
      await newComposition.run({ args: ["card", "--duration", "1"], cwd: project, project: { dir: project } });
      // The script's fallback object would mask a lost default: drop it, so only the declared default fills the card.
      const entry = join(project, "compositions", "hyperframes", "card", "index.html");
      const html = readFileSync(entry, "utf8");
      expect(html).toContain(' || { title: "Title" }');
      writeFileSync(entry, html.replace(' || { title: "Title" }', ""));
      const manager = binaries();
      const ffmpeg = await manager.ensure("ffmpeg");
      const adapter = createHyperframesAdapter({ projectDir: project });
      const result = await adapter.render(
        { id: "c_card", source: "compositions/hyperframes/card/index.html" },
        {
          projectDir: project,
          outDir: tempDir(),
          fps: 30,
          width: 320,
          height: 180,
          signal: new AbortController().signal,
          ensureBinary: (name) => manager.ensure(name),
          progress: () => {},
        },
      );
      const { stdout: raw } = await execFileAsync(
        ffmpeg,
        ["-v", "error", "-c:v", "libvpx-vp9", "-ss", "0.8", "-i", result.file, "-frames:v", "1", "-vf", "crop=1:1:60:150,format=rgba", "-f", "rawvideo", "-"],
        { encoding: "buffer" },
      );
      // Card starts at x = 19 px with 13 px side padding: only a non-empty title stretches its background past x = 60.
      expect(raw[3]).toBeGreaterThan(150);
    },
    600_000,
  );
});
