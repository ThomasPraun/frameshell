import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { beforeEach, describe, expect, it } from "vitest";
import { RENDER_TIMING_KINDS, type LiveContext, type RenderContext, type RenderTiming } from "@frameshell/plugin-api";
import { type Producer, createHyperframesAdapter } from "../src/index.js";
import { MOTION_RUNTIME } from "../src/motion-runtime.js";
import { timingKinds } from "../src/timing.js";

// Timing for generated clips (ADR 0029 decision 8): a composition asks with a meta tag and reads `window.frameshellTiming`.
const SOURCE = "compositions/hyperframes/drop/index.html";
const ASKING = '<!doctype html><html><head><meta name="frameshell-timing" content="beats markers"><title>drop</title></head><body></body></html>';
const TIMING: RenderTiming = {
  beats: [
    { at: 0.5, beat: 3, bar: 1 },
    { at: 1, beat: 4 },
  ],
  tempo: { bpm: 120, meter: 4 },
  markers: [{ at: 0.75, id: "m_1", label: "</script><b>hook", color: "red" }],
};

let project: string;

beforeEach(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-hyperframes-timing-")));
  mkdirSync(join(project, "compositions", "hyperframes", "drop"), { recursive: true });
  writeFileSync(join(project, SOURCE), ASKING);
  writeFileSync(join(project, "frameshell.json"), JSON.stringify({ resolution: { width: 1920, height: 1080 } }));
});

/** Renders SOURCE with `timing` and returns the entry as the producer saw it. */
async function renderedEntry(timing?: RenderTiming): Promise<string> {
  let seen = "";
  const producer: Producer = {
    createRenderJob: (config) => ({ config }),
    async executeRenderJob(_job, dir, output) {
      seen = readFileSync(join(dir, "index.html"), "utf8");
      writeFileSync(output, "webm");
    },
  };
  const ctx: RenderContext = {
    projectDir: project,
    outDir: realpathSync(mkdtempSync(join(tmpdir(), "frameshell-hyperframes-timing-out-"))),
    fps: 30,
    width: 1920,
    height: 1080,
    signal: new AbortController().signal,
    ensureBinary: async (name) => `/managed/${name}`,
    progress: () => {},
    ...(timing ? { timing } : {}),
  };
  await createHyperframesAdapter({ projectDir: project, producer: async () => producer }).render({ id: "c_1", source: SOURCE }, ctx);
  return seen;
}

/** Runs every inline script of `html` (or a head script) in one fresh context and returns its window. */
function run(scripts: string[]): Record<string, unknown> {
  const window: Record<string, unknown> = {};
  window["window"] = window;
  for (const script of scripts) runInNewContext(script, { window });
  return window;
}

describe("timing kinds a composition asks for", () => {
  it("knows every kind the plugin API lists (the plugin keeps a copy: installed plugins carry no plugin-api)", () => {
    const meta = `<meta name="frameshell-timing" content="${RENDER_TIMING_KINDS.join(" ")}">`;
    expect(timingKinds(meta)).toEqual([...RENDER_TIMING_KINDS].sort());
  });

  it("reads the meta tag in any quoting, case and separator, ignoring unknown words", () => {
    expect(timingKinds(ASKING)).toEqual(["beats", "markers"]);
    expect(timingKinds("<META content='Markers' NAME='frameshell-timing'>")).toEqual(["markers"]);
    expect(timingKinds('<meta name=frameshell-timing content="beats,  bars">')).toEqual(["beats"]);
    expect(timingKinds('<meta name="frameshell-timing" content="Words markers">')).toEqual(["markers", "words"]);
  });

  it("asks for beats when the clip's props set onBeats to true, and only then", () => {
    expect(timingKinds("<html></html>", { onBeats: true })).toEqual(["beats"]);
    expect(timingKinds('<meta name="frameshell-timing" content="words">', { onBeats: true })).toEqual(["beats", "words"]);
    expect(timingKinds(ASKING, { onBeats: true })).toEqual(["beats", "markers"]);
    for (const props of [undefined, {}, { onBeats: false }, { onBeats: "true" }, { onBeats: 1 }]) {
      expect(timingKinds("<html></html>", props)).toEqual([]);
    }
  });

  it("asks for nothing without the tag, or with another meta tag", () => {
    expect(timingKinds("<html><head><title>x</title></head></html>")).toEqual([]);
    expect(timingKinds('<meta name="description" content="beats markers"><meta data-name="frameshell-timing" content="beats">')).toEqual([]);
  });

  it("is what the adapter's timing() says for a clip, and nothing for a clip without an HTML entry", async () => {
    const adapter = createHyperframesAdapter({ projectDir: project });
    expect(await adapter.timing!({ id: "c_1", source: SOURCE })).toEqual(["beats", "markers"]);
    writeFileSync(join(project, SOURCE), "<html></html>");
    expect(await adapter.timing!({ id: "c_1", source: SOURCE })).toEqual([]);
    expect(await adapter.timing!({ id: "c_1", source: SOURCE, props: { onBeats: false } })).toEqual([]);
    expect(await adapter.timing!({ id: "c_1", source: SOURCE, props: { onBeats: true } })).toEqual(["beats"]);
    expect(await adapter.timing!({ id: "c_1" })).toEqual([]);
    expect(await adapter.timing!({ id: "c_1", source: "compositions/hyperframes/gone/index.html" })).toEqual([]);
  });
});

describe("timing in renders and live pages", () => {
  it("sets window.frameshellTiming first in the copied entry's head, escaped so a label cannot close the script", async () => {
    const seen = await renderedEntry(TIMING);
    expect(seen.startsWith('<!doctype html><html><head><script data-frameshell-timing>window.frameshellTiming = {"beats":')).toBe(true);
    const scripts = [...seen.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]!);
    expect(scripts).toHaveLength(1);
    expect(run(scripts)["frameshellTiming"]).toEqual(TIMING);
    expect(readFileSync(join(project, SOURCE), "utf8")).toBe(ASKING);
  });

  it("leaves the copy byte-identical without timing", async () => {
    expect(await renderedEntry()).toBe(ASKING);
  });

  it("gives the live page the same timing before the variables and the runtime", async () => {
    const live: LiveContext = { projectDir: project, fps: 30, width: 1920, height: 1080, ensureBinary: async (name) => `/managed/${name}` };
    const adapter = createHyperframesAdapter({ projectDir: project, runtime: async () => "window.runtime = true;" });
    const { head } = await adapter.livePreview!({ id: "c_1", source: SOURCE, props: { title: "Drop" } }, { ...live, timing: TIMING });
    expect(head.indexOf("window.frameshellTiming = ")).toBe(0);
    expect(head.indexOf("window.__hfVariables")).toBeGreaterThan(0);
    expect(head).not.toContain("</script>");
    const timing = run([head.slice(0, head.indexOf("\n"))])["frameshellTiming"];
    expect(timing).toEqual(TIMING);
    expect((await adapter.livePreview!({ id: "c_1", source: SOURCE }, live)).head).not.toContain("frameshellTiming");
  });
});

describe("the motion runtime reads window.frameshellTiming (runtime 0.5.0)", () => {
  /** The shipped runtime in one page, after the given scripts (a render copy's head script, or none). */
  function motion(...before: string[]): Record<string, (...args: unknown[]) => unknown> {
    const page: Record<string, unknown> = {};
    page["window"] = page;
    for (const script of [...before, `${MOTION_RUNTIME}\nwindow.M = FrameshellMotion;`]) runInNewContext(script, page);
    return page["M"] as Record<string, (...args: unknown[]) => unknown>;
  }
  const nominal = { bpm: 120, offset: 0.25 };

  it("follows the beats and markers the host wrote into the render copy", async () => {
    const copy = await renderedEntry(TIMING);
    const M = motion(...[...copy.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]!));
    expect(M["hasBeats"]!()).toBe(true);
    expect(M["beats"]!()).toEqual([
      { at: 0.5, index: 0, beat: 3, bar: 1 },
      { at: 1, index: 1, beat: 4 },
    ]);
    expect(M["sinceBeat"]!(1.25, 1, nominal)).toBeCloseTo(0.25, 9);
    expect(M["beatAt"]!(0.75)).toMatchObject({ index: 0, beat: 3, bar: 1 });
    expect(M["markers"]!("</script><b>hook")).toHaveLength(1);
  });

  it("uses the nominal grid, or the clip's own seconds, when the page has no timing or the grid has a problem", () => {
    for (const before of [[], ['window.frameshellTiming = { beats: [], beatsProblem: "no-music-clip" };']]) {
      const M = motion(...before);
      expect(M["hasBeats"]!()).toBe(false);
      expect(M["beatTime"]!(2, nominal)).toBeCloseTo(1.25, 9);
      expect(M["sinceBeat"]!(2.5, 1)).toBe(1.5);
      expect(M["beats"]!({ ...nominal, duration: 1.5 })).toHaveLength(3);
      expect(M["markers"]!()).toEqual([]);
    }
  });
});
