// 12 probes, cold (fresh page per probe) vs after reseeking from an unrelated time, on the live page with the producer's software flags;
// then the same on-grid frames against a lossless producer PNG sequence, and render-to-render byte equality.
// Usage: node src/determinism.mjs  -> out/results/determinism.json
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, makeProject, maxDiff, openLive, outRoot, pixelsOfPng, pixelsOfPngBytes, renderPngSequence, round, serveLive } from "./lib.mjs";

const DURATION = 1;
const FPS = 30;
const project = makeProject("determinism", { duration: DURATION });
const served = await serveLive(project);
const errors = [];
// On-grid probe times: the runtime quantizes seeks to the frame grid, and the producer renders only grid frames.
const probeFrames = Array.from({ length: 12 }, (_, i) => Math.round(((i + 0.37) / 12) * DURATION * FPS));
const probes = probeFrames.map((f) => f / FPS);
const result = { probeFrames, probeSeconds: probes.map((t) => round(t, 3)) };

const browser = await launch();
const cold = [];
for (const [i, t] of probes.entries()) {
  const page = await openLive(browser, served, project, errors);
  await page.waitForFunction("window.__spike.loadsDone === true", { timeout: 60000 });
  await page.evaluate(`window.frameshellLive.seek(${t})`);
  cold.push(await pixelsOfPngBytes(await page.screenshot({ type: "png", omitBackground: true })));
  await page.close();
  console.log("cold", i);
}
const page = await openLive(browser, served, project, errors);
await page.waitForFunction("window.__spike.loadsDone === true", { timeout: 60000 });
const reseek = [];
for (const [i, t] of probes.entries()) {
  await page.evaluate(`window.frameshellLive.seek(${probes[(i + 5) % probes.length]})`);
  await page.evaluate(`window.frameshellLive.seek(${t})`);
  reseek.push(await pixelsOfPngBytes(await page.screenshot({ type: "png", omitBackground: true })));
}
await browser.close();
result.coldVsReseek = probes.map((_, i) => maxDiff(cold[i], reseek[i]));
result.coldVsReseekWorst = Math.max(...result.coldVsReseek.map((d) => d.worst));
result.distinctProbeFrames = new Set(cold.map((f) => f.toString("base64"))).size;
console.log("cold vs reseek worst", result.coldVsReseekWorst, "distinct", result.distinctProbeFrames, "errors", errors.slice(0, 3));

// Real render path: lossless PNG sequence from the producer, twice.
const a = await renderPngSequence(project, join(outRoot, "renders", "det-a"));
const b = await renderPngSequence(project, join(outRoot, "renders", "det-b"));
result.sequence = { frames: a.files.length, secondsA: round(a.seconds, 1), secondsB: round(b.seconds, 1), firstFile: a.files[0].split("/").pop() };
const perFrame = [];
for (let i = 0; i < a.files.length; i++) perFrame.push(maxDiff(await pixelsOfPng(a.files[i]), await pixelsOfPng(b.files[i])));
result.renderVsRender = { worst: Math.max(...perFrame.map((d) => d.worst)), identicalFrames: perFrame.filter((d) => d.worst === 0).length };
// Producer frame k (file index k, 0-based) against the cold probe of the same frame.
const filesByIndex = a.files;
result.producerVsCold = [];
for (const [i, f] of probeFrames.entries()) {
  const frame = await pixelsOfPng(filesByIndex[f]);
  result.producerVsCold.push({ frame: f, ...maxDiff(frame, cold[i]) });
}
result.producerVsColdWorst = Math.max(...result.producerVsCold.map((d) => d.worst));
result.errors = errors.slice(0, 5);
console.log(JSON.stringify({ ...result, coldVsReseek: undefined, producerVsCold: undefined }, null, 1));
mkdirSync(join(outRoot, "results"), { recursive: true });
writeFileSync(join(outRoot, "results", "determinism.json"), JSON.stringify(result, null, 2));
served.close();
