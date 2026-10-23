import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { BinaryManager } from "@frameshell/core";
import { createHyperframesAdapter } from "../src/index.js";

// Opt-in like render-real: FRAMESHELL_TEST_REAL_HYPERFRAMES=1. Element CSS (what core's `elementStyles` makes)
// moves a markup element with an inline transform and a script-made one in a real render.
const execFileAsync = promisify(execFile);
const tempDir = () => realpathSync(mkdtempSync(join(tmpdir(), "frameshell-elements-real-")));
const binaries = () => {
  const dir = process.env["FRAMESHELL_TEST_BINARIES_DIR"] || fileURLToPath(new URL("../../../.cache/test-binaries", import.meta.url));
  return new BinaryManager({ dataDir: dir, configDir: dir });
};

/** Red #box in the markup with an inline transform (as an animation sets), blue #gen created by a script. */
const COMPOSITION = `<!doctype html>
<html>
  <head>
    <style>
      * { margin: 0; padding: 0; }
      html, body { width: 160px; height: 90px; overflow: hidden; }
      #stage { position: relative; width: 100%; height: 100%; }
      .clip { position: absolute; inset: 0; }
      #box { position: absolute; left: 0; top: 25px; width: 40px; height: 40px; background: #ff0000; }
      #gen { position: absolute; left: 0; top: 0; width: 20px; height: 20px; background: #0000ff; }
    </style>
  </head>
  <body>
    <div id="stage" data-composition-id="els" data-width="160" data-height="90" data-duration="0.2" data-no-timeline>
      <div class="clip" data-start="0" data-duration="0.2" data-track-index="0"><div id="box"></div></div>
    </div>
    <script>
      document.getElementById("box").style.transform = "translateY(0px) rotate(0deg)";
      var gen = document.createElement("div");
      gen.id = "gen";
      document.querySelector(".clip").appendChild(gen);
    </script>
  </body>
</html>
`;

const CSS = "#box { translate: 100px 0px !important; }\n#gen { translate: 130px 60px !important; scale: 0.5 !important; }";

describe.runIf(process.env["FRAMESHELL_TEST_REAL_HYPERFRAMES"] === "1")("element adjustments (real render)", () => {
  it(
    "moves markup and script-made elements by the element CSS",
    async () => {
      const project = tempDir();
      const dir = join(project, "compositions", "hyperframes", "els");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "index.html"), COMPOSITION);
      const manager = binaries();
      const ffmpeg = await manager.ensure("ffmpeg");
      const adapter = createHyperframesAdapter({ projectDir: project });
      const render = (elementCss?: string) =>
        adapter.render(
          { id: "c_els", source: "compositions/hyperframes/els/index.html" },
          {
            projectDir: project,
            outDir: tempDir(),
            fps: 30,
            width: 160,
            height: 90,
            signal: new AbortController().signal,
            ensureBinary: (name) => manager.ensure(name),
            progress: () => {},
            ...(elementCss ? { elementCss } : {}),
          },
        );
      const colour = async (file: string, x: number, y: number) => {
        const { stdout: raw } = await execFileAsync(
          ffmpeg,
          ["-v", "error", "-c:v", "libvpx-vp9", "-i", file, "-frames:v", "1", "-vf", `format=rgba,crop=1:1:${x}:${y}`, "-f", "rawvideo", "-"],
          { encoding: "buffer" },
        );
        const [r, g, b, a] = [raw[0]!, raw[1]!, raw[2]!, raw[3]!];
        if (a < 200) return "clear";
        if (r > 180 && g < 80 && b < 80) return "red";
        if (b > 180 && r < 80 && g < 80) return "blue";
        return `other (${r},${g},${b},${a})`;
      };
      const plain = await render();
      const moved = await render(CSS);
      // Box: 0-40 x 25-65; gen: 0-20 x 0-20.
      expect([await colour(plain.file, 20, 45), await colour(plain.file, 120, 45), await colour(plain.file, 10, 10)]).toEqual(["red", "clear", "blue"]);
      // Moved box: 100-140; gen moved 130,60 and halved about its centre: 135-145 x 65-75.
      expect([await colour(moved.file, 20, 45), await colour(moved.file, 120, 45), await colour(moved.file, 10, 10)]).toEqual(["clear", "red", "clear"]);
      expect(await colour(moved.file, 140, 70)).toBe("blue");
      expect(await colour(moved.file, 133, 70)).toBe("clear");
    },
    600_000,
  );
});
