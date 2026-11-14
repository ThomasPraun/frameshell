// Real render through the plugin adapter (producer in-process, VP9 alpha WebM): wall time per frame vs a 2D control at the same size,
// (interleaved repeats, min and median, because the machine is shared) and alpha of the decoded WebM at a corner, the panel, the subject and a shadow. Usage: node src/render.mjs  -> out/results/render.json
import { statSync, mkdirSync, writeFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { join } from "node:path";
import { alphaAt, launch, makeProject, median, openLive, outRoot, pixelsOfPngBytes, pixelsOfWebm, rgbaAt, renderClip, round, serveLive } from "./lib.mjs";

const DURATION = 2;
const FPS = 30;
const REPEATS = 3;
const frames = DURATION * FPS;
const result = { cpus: cpus().length, loadavgAtStart: loadavg().map((x) => round(x, 1)), frames, size: "1920x1080", repeats: REPEATS };

const control = makeProject("render-control", { template: "baseline.html", duration: DURATION });
const scene = makeProject("render-scene", { duration: DURATION });
// Same scene without the 1x1 readback the spike uses to time paints (a template would not have it).
const bare = makeProject("render-scene-nosync", { duration: DURATION, finish: false });
const runs = { control: [], scene: [], sceneNoReadback: [] };
let c, s;
for (let i = 0; i < REPEATS; i++) {
  c = await renderClip(control, join(outRoot, "renders", "control"));
  s = await renderClip(scene, join(outRoot, "renders", "scene"));
  const n = await renderClip(bare, join(outRoot, "renders", "scene-nosync"));
  runs.control.push(c.seconds);
  runs.scene.push(s.seconds);
  runs.sceneNoReadback.push(n.seconds);
  console.log(`run ${i}`, round(c.seconds, 1), round(s.seconds, 1), round(n.seconds, 1), "loadavg", loadavg().map((x) => round(x, 1)));
}
const summary = (xs) => ({ secondsMin: round(Math.min(...xs), 2), secondsMedian: round(median(xs), 2), msPerFrameMin: round((Math.min(...xs) * 1000) / frames), msPerFrameMedian: round((median(xs) * 1000) / frames) });
for (const [name, xs] of Object.entries(runs)) result[name] = summary(xs);
result.control.megabytes = round(statSync(c.file).size / 1048576, 2);
result.scene.megabytes = round(statSync(s.file).size / 1048576, 2);
result.sceneOverControlMsPerFrame = { min: round(result.scene.msPerFrameMin - result.control.msPerFrameMin), median: round(result.scene.msPerFrameMedian - result.control.msPerFrameMedian) };
result.runsSeconds = runs;
console.log(JSON.stringify(result, null, 1));

// Alpha at fixed points of the 1080p frame (see out/smoke.png): corner, panel, subject body, shadow on the ground.
// The shadow point is on the ground at t=1; at t=0 the same pixel is already panel (the subject turns).
const POINTS = { corner: [6, 6], panel: [700, 250], subject: [850, 380], shadowGround: [420, 640] };
const served = await serveLive(scene);
const browser = await launch();
const page = await openLive(browser, served, scene);
await page.waitForFunction("window.__spike.loadsDone === true", { timeout: 60000 });
result.alpha = {};
for (const t of [0, 1]) {
  await page.evaluate(`window.frameshellLive.seek(${t})`);
  const live = await pixelsOfPngBytes(await page.screenshot({ type: "png", omitBackground: true }));
  const webm = await pixelsOfWebm(s.file, t);
  result.alpha[`t=${t}`] = Object.fromEntries(
    Object.entries(POINTS).map(([name, [x, y]]) => [name, { liveScreenshotRGBA: rgbaAt(live, 1920, x, y), webmRGBA: rgbaAt(webm, 1920, x, y) }]),
  );
  // Histogram: share of fully transparent, partial and opaque pixels in the decoded WebM.
  let zero = 0, partial = 0, opaque = 0;
  for (let i = 3; i < webm.length; i += 4) webm[i] === 0 ? zero++ : webm[i] === 255 ? opaque++ : partial++;
  result.alpha[`t=${t}`].histogramPct = { transparent: round((zero / (webm.length / 4)) * 100), partial: round((partial / (webm.length / 4)) * 100), opaque: round((opaque / (webm.length / 4)) * 100) };
  result.alpha[`t=${t}`].cornerAlpha = alphaAt(webm, 1920, 6, 6);
}
await browser.close();
served.close();
console.log(JSON.stringify(result.alpha, null, 1));
mkdirSync(join(outRoot, "results"), { recursive: true });
writeFileSync(join(outRoot, "results", "render.json"), JSON.stringify(result, null, 2));
