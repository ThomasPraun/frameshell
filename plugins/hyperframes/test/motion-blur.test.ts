import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { RenderContext } from "@frameshell/plugin-api";
import { type Producer, createHyperframesAdapter } from "../src/index.js";
import { MOTION_RUNTIME } from "../src/motion-runtime.js";

// Motion blur (ADR 0041): the clip's resolved blur becomes the producer's sub-frame accumulation.
const tempDir = () => realpathSync(mkdtempSync(join(tmpdir(), "frameshell-hyperframes-blur-")));
const SOURCE = "compositions/hyperframes/intro/index.html";
const HTML = '<!doctype html><html><head><script src="frameshell-motion.js"></script></head><body></body></html>';

let project: string;
beforeEach(() => {
  project = tempDir();
  mkdirSync(join(project, "compositions", "hyperframes", "intro"), { recursive: true });
  writeFileSync(join(project, SOURCE), HTML);
  writeFileSync(join(project, "frameshell.json"), JSON.stringify({ resolution: { width: 160, height: 90 } }));
});

/** Records each job's config and the entry the producer saw; `fail` makes it throw that. */
function producer(fail?: Error) {
  const jobs: { config: Record<string, unknown>; entry: string }[] = [];
  const fake: Producer = {
    createRenderJob: (config) => ({ config }),
    async executeRenderJob(job, dir, output) {
      jobs.push({ config: (job as { config: Record<string, unknown> }).config, entry: readFileSync(join(dir, "index.html"), "utf8") });
      if (fail) throw fail;
      writeFileSync(output, "webm");
    },
  };
  return { fake, jobs };
}

function context(extra: Partial<RenderContext> = {}): RenderContext {
  return {
    projectDir: project,
    outDir: tempDir(),
    fps: 30,
    width: 160,
    height: 90,
    signal: new AbortController().signal,
    ensureBinary: async (name) => `/managed/${name}`,
    progress: () => {},
    ...extra,
  };
}

describe("hyperframes motion blur", () => {
  it("declares support, and maps the blur to a fixed sample count with the window centred on the frame", async () => {
    const { fake, jobs } = producer();
    const adapter = createHyperframesAdapter({ projectDir: project, producer: async () => fake });
    expect(adapter.motionBlur).toBe(true);
    await adapter.render({ id: "c_1", source: SOURCE }, context({ motionBlur: { shutter: 180, samples: 8, blend: "linear" } }));
    await adapter.render({ id: "c_1", source: SOURCE }, context({ motionBlur: { shutter: 90, samples: 16, blend: "srgb" } }));
    expect(jobs[0]!.config).toMatchObject({
      motionBlur: { samplesPerFrame: 8, shutterAngle: 180, shutterPhase: -90, blend: "linear" },
      pageMotionBlur: "off",
    });
    expect(jobs[1]!.config["motionBlur"]).toEqual({ samplesPerFrame: 16, shutterAngle: 90, shutterPhase: -45, blend: "srgb" });
    // The cuts() guard of the motion runtime reads the frame rate from this tag.
    expect(jobs[0]!.entry).toBe(
      '<!doctype html><html><head><meta name="frameshell-fps" content="30"><script src="frameshell-motion.js"></script></head><body></body></html>',
    );
    expect(MOTION_RUNTIME).toContain("frameshell-fps");
    expect(readFileSync(join(project, SOURCE), "utf8")).toBe(HTML);
  });

  it("renders a clip without blur as before: no blur options, the entry as written", async () => {
    const { fake, jobs } = producer();
    await createHyperframesAdapter({ projectDir: project, producer: async () => fake }).render({ id: "c_1", source: SOURCE }, context());
    expect(jobs[0]!.config).not.toHaveProperty("motionBlur");
    expect(jobs[0]!.config).not.toHaveProperty("pageMotionBlur");
    expect(jobs[0]!.entry).toBe(HTML);
  });

  it("says in the clip's terms when the producer refuses to blur, and passes other errors through", async () => {
    const blur = { motionBlur: { shutter: 180, samples: 8, blend: "linear" as const } };
    const refusal = new Error('[MotionBlur] sub-frame motion blur is not supported on the "hdr_layered" capture route.');
    const refused = createHyperframesAdapter({ projectDir: project, producer: async () => producer(refusal).fake });
    await expect(refused.render({ id: "c_1", source: SOURCE }, context(blur))).rejects.toThrow(
      /^hyperframes clip c_1 cannot be motion-blurred: sub-frame motion blur is not supported on the "hdr_layered" capture route\. .*--clear-motion-blur/,
    );
    const other = createHyperframesAdapter({ projectDir: project, producer: async () => producer(new Error("Chrome crashed")).fake });
    await expect(other.render({ id: "c_1", source: SOURCE }, context(blur))).rejects.toThrow(/^Chrome crashed$/);
  });
});
