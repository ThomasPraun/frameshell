// Loads the composition in managed Chrome with the producer's software flags and saves one frame (and a 3x crop of a shadow edge).
// Usage: node src/smoke.mjs [name] ['{"shadows":"vsm","shadowRadius":24}']  -> out/<name>.png, out/<name>-shadow.png
import { writeFileSync } from "node:fs";
import { ensureBinary, execFileAsync, launch, makeProject, openLive, serveLive } from "./lib.mjs";

const name = process.argv[2] ?? "smoke";
const project = makeProject(name, process.argv[3] ? JSON.parse(process.argv[3]) : {});
const served = await serveLive(project);
const browser = await launch();
const errors = [];
const page = await openLive(browser, served, project, errors);
await page.waitForFunction("window.__spike.loadsDone === true", { timeout: 60000 });
await page.evaluate("window.frameshellLive.seek(0.5)");
writeFileSync(`out/${name}.png`, await page.screenshot({ type: "png", omitBackground: true }));
const ffmpeg = await ensureBinary("ffmpeg");
await execFileAsync(ffmpeg, ["-y", "-v", "error", "-i", `out/${name}.png`, "-vf", "crop=360:140:480:590,scale=1080:420:flags=neighbor,format=rgba", `out/${name}-shadow.png`]);
console.log(JSON.stringify(await page.evaluate("({ browser: navigator.userAgent, gl: window.__spike.gl.renderer, pmremMs: window.__spike.pmremMs, loads: window.__spike.loads })")), errors);
await browser.close();
served.close();
