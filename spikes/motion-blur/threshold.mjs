// PROTOTYPE, throwaway (#501): does Chrome repaint a small transform change? See docs/research/motion-blur.md.
// fresh(pose): a new page paints the pose once. warm(poses): one page paints each pose in turn (captured each time).
// When warm ends on a pose but its capture differs from fresh(that pose), the page shows raster of an older pose.
import { createServer } from "node:http";
import { readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const root = fileURLToPath(new URL("../../", import.meta.url));
const engineDir = realpathSync(join(realpathSync(join(root, "plugins/hyperframes/node_modules/@hyperframes/producer")), "../engine"));
const browserManager = await import(pathToFileURL(join(engineDir, "dist/services/browserManager.js")).href);
const puppeteer = (await import(pathToFileURL(createRequire(join(engineDir, "package.json")).resolve("puppeteer")).href)).default;
const binDir = process.env.FRAMESHELL_TEST_BINARIES_DIR || join(root, ".cache/test-binaries");
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const chrome = walk(join(binDir, "binaries")).find((f) => f.endsWith("/chrome-headless-shell"));

const [W, H] = [160, 90];
// PARENT: scale of a container around both elements (local units in the table stay those of the element).
const PARENT = Number(process.env.PARENT ?? 1);
// TOGGLE: what the page does next to each transform write, to force a repaint.
const TOGGLES = {
  none: "",
  outline: "el.style.outlineColor = el.style.outlineColor === 'rgba(0, 0, 0, 0)' ? 'rgba(1, 1, 1, 0)' : 'rgba(0, 0, 0, 0)';",
  custom: "el.style.setProperty('--fs-tick', String(Math.random()));",
};
const toggle = TOGGLES[process.env.TOGGLE ?? "none"];
const html = `<!doctype html><html><head><style>
* { margin: 0; padding: 0; } html, body { width: ${W}px; height: ${H}px; overflow: hidden; }
#box { position: absolute; left: 30px; top: 20px; width: 40px; height: 40px; background: #ff0000; }
.dot { position: absolute; left: 100px; top: 30px; width: 8px; height: 8px; border-radius: 50%; background: #0000ff; }
#parent { position: absolute; left: 0; top: 0; width: ${W}px; height: ${H}px; transform-origin: 0 0; transform: scale(${PARENT}); }
</style></head><body><div id="parent"><div id="box"></div><div class="dot"></div></div><script>
window.pose = function (p) {
  var el = document.getElementById("box");
  el.style.transform = "translate(" + p.x + "px, 0px) rotate(" + p.r + "deg) scale(" + p.s + ")"; el.style.opacity = String(p.o);
  ${toggle}
  el = document.querySelector(".dot");
  el.style.transform = "translate(" + p.x + "px, " + p.y + "px)";
  ${toggle}
};
</script></body></html>`;
const server = createServer((_, response) => response.writeHead(200, { "content-type": "text/html" }).end(html));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const extra = JSON.parse(process.env.EXTRA_ARGS ?? "[]");
const args = browserManager.buildChromeArgs({ width: W, height: H, captureMode: "screenshot" }, { browserGpuMode: process.env.GPU ?? "software" });
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: [...args, ...extra] });

async function capture(poses) {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H });
  await page.goto(url);
  const cdp = await page.createCDPSession();
  await cdp.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
  let data;
  for (const p of poses) {
    await page.evaluate((q) => window.pose(q), p);
    ({ data } = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, clip: { x: 0, y: 0, width: W, height: H, scale: 1 } }));
  }
  await page.close();
  return data;
}

const base = { x: 0.3, y: 0.37, r: 11.9, s: 1.1, o: 0.5 };
const out = [];
// One step of `d` on one field: is the step painted?
for (const [field, deltas] of [
  ["x", [0.001, 0.005, 0.01, 0.015, 0.02, 0.03, 0.05]],
  ["r", [0.001, 0.003, 0.005, 0.0075, 0.01, 0.02]],
  ["s", [0.00001, 0.00003, 0.0001, 0.0003, 0.001]],
  ["o", [0.001, 0.002, 0.004, 0.01]],
]) {
  for (const d of deltas) {
    const target = { ...base, [field]: +(base[field] + d).toFixed(6) };
    const [fresh, freshBase, warm] = [await capture([target]), await capture([base]), await capture([base, target])];
    out.push({ test: "step", field, delta: d, picturesDiffer: fresh !== freshBase, warmShowsTarget: warm === fresh, warmShowsBase: warm === freshBase });
  }
}
// Slow drift: 20 steps of `d` px in x. Does the page follow, or keep the raster of where it started?
for (const d of [0.002, 0.005]) {
  const poses = Array.from({ length: 21 }, (_, i) => ({ ...base, x: +(base.x + i * d).toFixed(6) }));
  const [fresh, freshStart, warm] = [await capture([poses.at(-1)]), await capture([poses[0]]), await capture(poses)];
  out.push({ test: "drift", stepPx: d, totalPx: +(20 * d).toFixed(3), picturesDiffer: fresh !== freshStart, warmShowsEnd: warm === fresh, warmShowsStart: warm === freshStart });
}
console.log(JSON.stringify({ parent: PARENT, gpu: process.env.GPU ?? "software", extra, toggle: process.env.TOGGLE ?? "none", rows: out }));
await browser.close();
server.close();
