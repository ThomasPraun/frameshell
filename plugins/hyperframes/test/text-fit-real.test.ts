import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { BinaryManager, TextFitChecker } from "@frameshell/core";
import { createHyperframesAdapter, newComposition } from "../src/index.js";
import { MOTION_RUNTIME, MOTION_RUNTIME_FILE } from "../src/motion-runtime.js";

// Opt-in like render-real (FRAMESHELL_TEST_REAL_HYPERFRAMES=1): `clip.textFit` (#803) on the end-card template in
// managed Chrome. Its own words fit; a name in one long word (another language) grows past the frame.
const made: string[] = [];
const tempDir = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-text-fit-real-")));
  made.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
const binaries = () => {
  const dir = process.env["FRAMESHELL_TEST_BINARIES_DIR"] || fileURLToPath(new URL("../../../.cache/test-binaries", import.meta.url));
  return new BinaryManager({ dataDir: dir, configDir: dir });
};
const SIZE = { width: 640, height: 360 };

/** A fixed-width button whose label does not wrap, and a tight heading (line-height 0.8) that fits. */
const BUTTON = `<!doctype html>
<html>
  <head>
    <style>
      * { margin: 0; padding: 0; }
      html, body { width: 640px; height: 360px; overflow: hidden; font-family: sans-serif; }
      #stage { position: relative; width: 100%; height: 100%; }
      .clip { position: absolute; inset: 0; }
      h1 { position: absolute; left: 20px; top: 20px; width: 600px; font-size: 48px; line-height: 0.8; }
      #button { position: absolute; left: 20px; top: 200px; width: 120px; height: 40px; white-space: nowrap; overflow: hidden; font-size: 20px; background: #036; color: #fff; }
    </style>
    <script src="${MOTION_RUNTIME_FILE}"></script>
  </head>
  <body>
    <div id="stage" data-composition-id="fit" data-width="640" data-height="360" data-duration="2">
      <div class="clip" data-start="0" data-duration="2" data-track-index="0">
        <h1>Tight heading</h1>
        <div id="button">Jetzt kostenlos herunterladen</div>
      </div>
    </div>
    <script>
      var M = window.FrameshellMotion;
      M.bind("fit", function (t) { M.write(document.getElementById("button"), { opacity: M.ease("enter", t / 0.3) }); });
    </script>
  </body>
</html>
`;

describe.runIf(process.env["FRAMESHELL_TEST_REAL_HYPERFRAMES"] === "1")("clip text fit (real HyperFrames)", () => {
  it(
    "passes the end card as scaffolded and names the line whose longer text does not fit",
    async () => {
      const dir = tempDir();
      writeFileSync(join(dir, "frameshell.json"), JSON.stringify({ resolution: SIZE }));
      await newComposition.run({ args: ["end", "--template", "end-card", "--duration", "4"], cwd: dir, project: { dir } });
      const manager = binaries();
      const adapter = createHyperframesAdapter({ projectDir: dir });
      const clip = { id: "c_end", type: "hyperframes", source: "compositions/hyperframes/end/index.html", start: 0, in: 0, duration: 4 };
      const timeline = { id: "main", revision: 1, tracks: [{ id: "v1", kind: "video", clips: [clip] }] };
      const checker = new TextFitChecker({
        timeline: async () => ({ timeline: timeline as never, fps: 30 }),
        live: async (_root, _timeline, id, props) => ({
          ...(await adapter.livePreview!(props ? { ...clip, props } : clip, { projectDir: dir, fps: 30, ...SIZE, ensureBinary: (name) => manager.ensure(name) })),
          clip: id,
          key: "k",
        }),
        resolution: async () => SIZE,
        declaredProps: async () => (await adapter.declaredProps?.(clip)) ?? null,
        chrome: () => manager.ensure("chrome-headless-shell"),
      });

      const own = await checker.check(dir, { timeline: "main", clip: "c_end" });
      expect(own).toMatchObject({ ok: true, problems: [], tried: [], at: [2, 2.8, 3.6] });
      expect(own.lines).toBeGreaterThanOrEqual(3);

      const long = await checker.check(dir, { timeline: "main", clip: "c_end", props: { title: "Donaudampfschifffahrtsgesellschaftskapitänsmütze", nope: 1 } });
      expect(long.ok).toBe(false);
      expect(long.tried).toEqual(["title", "nope"]);
      // The centred line grows past both sides of the frame.
      expect(long.problems[0]).toMatchObject({ kind: "outside", selector: expect.stringContaining("title"), text: "Donaudampfschifffahrtsgesellschaftskapitänsmütze" });
      expect(long.problems[0]!.by).toBeGreaterThan(100);
      expect(long.warnings.join("\n")).toContain("`nope`");
    },
    600_000,
  );

  it(
    "names a label wider than its fixed button, and not a heading with a tight line-height",
    async () => {
      const dir = tempDir();
      const composition = join(dir, "compositions", "hyperframes", "fit");
      mkdirSync(composition, { recursive: true });
      writeFileSync(join(dir, "frameshell.json"), JSON.stringify({ resolution: SIZE }));
      writeFileSync(join(composition, "index.html"), BUTTON);
      writeFileSync(join(composition, MOTION_RUNTIME_FILE), MOTION_RUNTIME);
      const manager = binaries();
      const adapter = createHyperframesAdapter({ projectDir: dir });
      const clip = { id: "c_fit", type: "hyperframes", source: "compositions/hyperframes/fit/index.html", start: 0, in: 0, duration: 2 };
      const checker = new TextFitChecker({
        timeline: async () => ({ timeline: { id: "main", revision: 1, tracks: [{ id: "v1", kind: "video", clips: [clip] }] } as never, fps: 30 }),
        live: async (_root, _timeline, id) => ({
          ...(await adapter.livePreview!(clip, { projectDir: dir, fps: 30, ...SIZE, ensureBinary: (name) => manager.ensure(name) })),
          clip: id,
          key: "k",
        }),
        resolution: async () => SIZE,
        chrome: () => manager.ensure("chrome-headless-shell"),
      });
      const result = await checker.check(dir, { timeline: "main", clip: "c_fit", at: [1.5] });
      expect(result.lines).toBe(2);
      expect(result.problems).toHaveLength(1);
      expect(result.problems[0]).toMatchObject({ kind: "overflows", side: "right", selector: expect.stringContaining("button"), at: 1.5 });
      expect(result.problems[0]!.by).toBeGreaterThan(50);
    },
    600_000,
  );
});
