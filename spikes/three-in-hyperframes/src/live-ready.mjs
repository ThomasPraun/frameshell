// Does the live preview (frameshellLive.ready) wait for window.__hf.buildReady, and for a held DefaultLoadingManager?
// Usage: node src/live-ready.mjs  -> prints ms until frameshellLive.ready resolves per mode
import { launch, makeProject, openLive, round, serveLive } from "./lib.mjs";

const browser = await launch();
for (const [name, cfg] of [
  ["sync", { loadMode: "sync" }],
  ["buildready-5s", { loadMode: "buildready", lateMs: 5000 }],
  ["slow-gated-5s (DefaultLoadingManager hold)", { loadMode: "slow-gated", lateMs: 5000 }],
]) {
  const project = makeProject(`live-ready-${name.split(" ")[0]}`, cfg);
  const served = await serveLive(project);
  const t0 = performance.now();
  const page = await openLive(browser, served, project);
  const readyMs = performance.now() - t0;
  const loadsDone = await page.evaluate("window.__spike.loadsDone === true");
  console.log(name.padEnd(46), `ready after ${round(readyMs)} ms; loads finished at that point: ${loadsDone}`);
  await page.close();
  served.close();
}
await browser.close();
