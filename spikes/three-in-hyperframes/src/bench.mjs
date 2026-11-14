// ms per frame on the live page (same Chrome, same SwiftShader flags as the producer): paint with gl.finish, screenshot, cold start.
// Usage: node src/bench.mjs [variantName ...]   -> out/results/bench.json
import { mkdirSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";
import { launch, makeProject, median, openLive, outRoot, round, serveLive } from "./lib.mjs";

// BENCH_SET=vsm: first run (VSM 2048 px, radius 24, 25 taps; unmarked variants). BENCH_SET=main (default): tuned default scene.
const SET = process.env.BENCH_SET ?? "main";
const PCF_VARIANTS = {
  // Default scene: soft shadows from a variance shadow map (VSM), 1024 px map, radius 8, 8 blur taps.
  "1080p-default": {},
  "1080p-msaa-off": { msaa: false },
  "1080p-shadows-pcf-hard": { shadows: "pcf" },
  "1080p-shadows-off": { shadows: "off" },
  "1080p-vsm-1024-r8-s16": { shadowBlurSamples: 16 },
  "1080p-vsm-512-r4-s8": { shadowMap: 512, shadowRadius: 4 },
  "1080p-vsm-2048-r16-s16": { shadowMap: 2048, shadowRadius: 16, shadowBlurSamples: 16 },
  "1080p-pmrem-128": { pmremSize: 128 },
  "720p-default": { width: 1280, height: 720 },
  "2160p-default": { width: 3840, height: 2160 },
};
const V = { shadows: "vsm", shadowRadius: 24 };
const VSM_VARIANTS = {
  "1080p-default": { ...V },
  "1080p-msaa-off": { ...V, msaa: false },
  "1080p-pcf": { shadows: "pcf" },
  "1080p-shadows-off": { shadows: "off" },
  "1080p-shadowmap-1024": { ...V, shadowMap: 1024 },
  "1080p-shadowmap-4096": { ...V, shadowMap: 4096 },
  "1080p-pmrem-128": { ...V, pmremSize: 128 },
  "1080p-lean": { msaa: false, shadows: "pcf", shadowMap: 1024, pmremSize: 128 },
  "720p-default": { ...V, width: 1280, height: 720 },
  "2160p-default": { ...V, width: 3840, height: 2160 },
};
const VARIANTS = SET === "vsm" ? VSM_VARIANTS : PCF_VARIANTS;

const wanted = process.argv.slice(2);
const names = wanted.length ? wanted : Object.keys(VARIANTS);
const FRAMES = 15;
const results = {};
for (const name of names) {
  const project = makeProject(`bench-${name}`, VARIANTS[name]);
  const served = await serveLive(project);
  const browser = await launch();
  const errors = [];
  try {
    const opened = performance.now();
    const page = await openLive(browser, served, project, errors);
    const readyMs = performance.now() - opened;
    await page.waitForFunction("window.__spike.loadsDone === true", { timeout: 60000 });
    const first = await page.evaluate("window.__spike.paintMs.slice()");
    const info = await page.evaluate("({ pmremMs: window.__spike.pmremMs, loads: window.__spike.loads, memory: null })");
    await page.evaluate("window.__spike.paintMs.length = 0");
    const paint = [];
    const shot = [];
    const seek = [];
    for (let i = 0; i < FRAMES; i++) {
      const t = (i * 0.37 + 0.05) % project.config.duration;
      const s0 = performance.now();
      await page.evaluate(`window.frameshellLive.seek(${t})`);
      seek.push(performance.now() - s0);
      const c0 = performance.now();
      await page.screenshot({ type: "png", omitBackground: true });
      shot.push(performance.now() - c0);
    }
    const paints = await page.evaluate("window.__spike.paintMs.slice()");
    results[name] = {
      config: { width: project.config.width, height: project.config.height, msaa: project.config.msaa, shadows: project.config.shadows, shadowMap: project.config.shadowMap, shadowRadius: project.config.shadowRadius, shadowBlurSamples: project.config.shadowBlurSamples, pmremSize: project.config.pmremSize },
      readyMs: round(readyMs),
      pmremMs: round(info.pmremMs),
      coldFirstPaintMs: round(first[0]),
      paintMinMs: round(Math.min(...paints)),
      paintMedianMs: round(median(paints)),
      loadavgAtEnd: loadavg().map((x) => round(x, 1)),
      paintMaxMs: round(Math.max(...paints)),
      seekMedianMs: round(median(seek)),
      screenshotMedianMs: round(median(shot)),
      perFrameMs: round(median(paints) + median(shot)),
      errors: errors.slice(0, 5),
    };
    console.log(name.padEnd(24), JSON.stringify(results[name]));
  } finally {
    await browser.close();
    served.close();
  }
}
mkdirSync(join(outRoot, "results"), { recursive: true });
writeFileSync(join(outRoot, "results", `bench-${SET}${wanted.length ? "-" + wanted.join("+") : ""}.json`), JSON.stringify(results, null, 2));
