// Loader readiness: does the HyperFrames render wait for a GLB and a texture before frame 0?
// Modes: sync (loadAsync started in the script body, default LoadingManager), late (started 400 ms / 5 s after the script),
// slow-gated (started 5 s after, but the script holds the default manager with itemStart until they finish),
// buildready-sync / buildready-5s (the loads are a promise in window.__hf.buildReady, started at once / after 5 s),
// fetch (fetch + createImageBitmap + GLTFLoader.parse, invisible to the manager), none (nothing loaded: the empty reference).
// Reference = live page with everything loaded. Usage: node src/loaders.mjs  -> out/results/loaders.json
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, makeProject, maxDiff, openLive, outRoot, pixelsOfPng, pixelsOfPngBytes, renderPngSequence, round, serveLive } from "./lib.mjs";

const DURATION = 0.5; // 15 frames: enough to see where a late load lands
const MODES = [
  { name: "sync", loadMode: "sync" },
  { name: "late-400ms", loadMode: "late", lateMs: 400 },
  { name: "late-5s", loadMode: "late", lateMs: 5000 },
  { name: "slow-gated-5s", loadMode: "slow-gated", lateMs: 5000 },
  { name: "buildready-sync", loadMode: "buildready-sync" },
  { name: "buildready-5s", loadMode: "buildready", lateMs: 5000 },
  { name: "fetch", loadMode: "fetch" },
  { name: "none", loadMode: "none" },
];

// Reference frames: live page of the sync project once its loads finished.
const refProject = makeProject("loaders-ref", { duration: DURATION });
const served = await serveLive(refProject);
const browser = await launch();
const page = await openLive(browser, served, refProject);
await page.waitForFunction("window.__spike.loadsDone === true", { timeout: 60000 });
const lastFrame = Math.round(DURATION * 30) - 1;
const ref = {};
for (const f of [0, lastFrame]) {
  await page.evaluate(`window.frameshellLive.seek(${f / 30})`);
  ref[f] = await pixelsOfPngBytes(await page.screenshot({ type: "png", omitBackground: true }));
}
const loadMs = await page.evaluate("window.__spike.loads");
const manager = await page.evaluate("window.__spike.manager");
await browser.close();
served.close();

const result = { duration: DURATION, frames: lastFrame + 1, referenceLoadsMs: loadMs, defaultLoadingManagerPropertyTypes: manager, modes: {} };
for (const mode of MODES) {
  const project = makeProject(`loaders-${mode.name}`, { duration: DURATION, loadMode: mode.loadMode, ...(mode.lateMs ? { lateMs: mode.lateMs } : {}) });
  const seq = await renderPngSequence(project, join(outRoot, "renders", `loaders-${mode.name}`));
  const first = maxDiff(await pixelsOfPng(seq.files[0]), ref[0]);
  const last = maxDiff(await pixelsOfPng(seq.files[lastFrame]), ref[lastFrame]);
  result.modes[mode.name] = {
    renderSeconds: round(seq.seconds, 1),
    frame0VsLoadedReference: first,
    lastFrameVsLoadedReference: last,
    frame0Complete: first.over2 < 200,
  };
  console.log(mode.name, JSON.stringify(result.modes[mode.name]));
}
mkdirSync(join(outRoot, "results"), { recursive: true });
writeFileSync(join(outRoot, "results", "loaders.json"), JSON.stringify(result, null, 2));
