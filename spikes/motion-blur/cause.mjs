// PROTOTYPE, throwaway (#501): why are fixed-8 motion-blurred renders not repeatable? See docs/research/motion-blur.md.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const producerDir = realpathSync(join(root, "plugins/hyperframes/node_modules/@hyperframes/producer"));
const engineDir = realpathSync(join(producerDir, "../engine"));
const producer = await import(pathToFileURL(join(producerDir, "dist/index.js")).href);
const blur = await import(pathToFileURL(join(engineDir, "dist/services/motionBlur.js")).href);
const png = await import(pathToFileURL(join(engineDir, "dist/utils/alphaBlit.js")).href);
const browserManager = await import(pathToFileURL(join(engineDir, "dist/services/browserManager.js")).href);
const engineRequire = createRequire(join(engineDir, "package.json"));
const realPuppeteer = (await import(pathToFileURL(engineRequire.resolve("puppeteer")).href)).default;

// EXTRA_ARGS='["--flag"]' appends Chrome flags to every launch the producer makes; the page's console
// lines starting "SEEK" are collected per render, in order.
const extraArgs = JSON.parse(process.env.EXTRA_ARGS ?? "[]");
let seekLog = null;
browserManager._setPuppeteerForTests({
  defaultArgs: (o) => realPuppeteer.defaultArgs(o),
  async launch(options) {
    const browser = await realPuppeteer.launch({ ...options, args: [...(options.args ?? []), ...extraArgs] });
    browser.on("targetcreated", async (target) => {
      const page = await target.page().catch(() => null);
      page?.on("console", (message) => {
        const text = message.text();
        if (text.startsWith("SEEK")) seekLog?.push(text.slice(5));
      });
    });
    return browser;
  },
});

const binDir = process.env.FRAMESHELL_TEST_BINARIES_DIR || join(root, ".cache/test-binaries");
const find = (name) => {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name === name ? [join(dir, e.name)] : []));
  return walk(join(binDir, "binaries"))[0];
};
process.env.HYPERFRAMES_FFMPEG_PATH = find("ffmpeg");
process.env.HYPERFRAMES_FFPROBE_PATH = find("ffprobe");
process.env.PRODUCER_HEADLESS_SHELL_PATH = find("chrome-headless-shell");

const runtimeSource = readFileSync(join(root, "plugins/hyperframes/src/motion-runtime.ts"), "utf8");
const RUNTIME_FILE = JSON.parse(/MOTION_RUNTIME_FILE = ("[^"]*")/.exec(runtimeSource)[1]);
const RUNTIME = JSON.parse(/export const MOTION_RUNTIME = ("(?:[^"\\]|\\.)*");/.exec(runtimeSource)[1]);
const out = (record) => console.log(JSON.stringify(record));
const tmp = (prefix) => realpathSync(mkdtempSync(join(tmpdir(), `fs-blur-cause-${prefix}-`)));
const sha = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 12);

// PAGE_FIX: page-side code run after every seek, to make the next raster independent of the ones before it.
const PAGE_FIXES = {
  none: "",
  // A background that paints (alpha 0.001 rounds to no change) and changes colour on every seek.
  faint: "var st = document.getElementById('stage'); st.__flip = !st.__flip; st.style.backgroundColor = st.__flip ? 'rgba(255,255,255,0.001)' : 'rgba(0,0,0,0.001)';",
  // Property-tree changes on the stage: every descendant chunk changes properties, so all of them are invalidated.
  isolate: "var st = document.getElementById('stage'); st.style.isolation = st.style.isolation === 'isolate' ? 'auto' : 'isolate';",
  filter: "var st = document.getElementById('stage'); st.style.filter = st.style.filter === 'opacity(1)' ? 'none' : 'opacity(1)';",
  htmlfilter: "var de = document.documentElement; de.style.filter = de.style.filter === 'opacity(1)' ? 'none' : 'opacity(1)';",
  htmlfilter2: "var de = document.documentElement; de.style.filter = de.style.filter === 'opacity(1)' ? 'brightness(1)' : 'opacity(1)';",
  // Undoes runtime 0.3.0's filter change after every seek (a render with and without it).
  untoggle: "document.documentElement.style.filter = '';",
  canvas: "if (window.__fsCanvas) window.__fsCanvas.clearRect(0, 0, 1, 1);",
  // A transparent background that changes value invalidates the whole stage.
  bg: "var st = document.getElementById('stage'); st.__flip = !st.__flip; st.style.backgroundColor = st.__flip ? 'rgba(255,255,255,0)' : 'rgba(0,0,0,0)';",
};

// PAGE_SETUP: page-side code run once after bind.
const PAGE_SETUPS = {
  none: "",
  // The runtime's hf-seek event lets a page hold the capture: wait two animation frames after every seek.
  raf2: "addEventListener('hf-seek', function (e) { window.__hfSeeks = (window.__hfSeeks || 0) + 1; if (e.detail && e.detail.waitUntil) e.detail.waitUntil(new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); })); });",
  raf1: "addEventListener('hf-seek', function (e) { window.__hfSeeks = (window.__hfSeeks || 0) + 1; if (e.detail && e.detail.waitUntil) e.detail.waitUntil(new Promise(function (r) { requestAnimationFrame(r); })); });",
  count: "addEventListener('hf-seek', function () { window.__hfSeeks = (window.__hfSeeks || 0) + 1; });",
  // A transparent 1x1 canvas stretched over the stage: redrawing it invalidates the whole stage.
  canvas: "var cv = document.createElement('canvas'); cv.width = 1; cv.height = 1; cv.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none'; document.getElementById('stage').appendChild(cv); window.__fsCanvas = cv.getContext('2d');",
};

/** The motion-real composition of measure.mjs (`fixture`), with an optional seek log kept on the page. */
function composition({ scale = 1, duration = 1 } = {}) {
  const [w, h] = [160 * scale, 90 * scale];
  return `<!doctype html>
<html>
  <head>
    <style>
      * { margin: 0; padding: 0; }
      html, body { width: ${w}px; height: ${h}px; overflow: hidden; }
      #stage { position: relative; width: 100%; height: 100%; }
      .clip { position: absolute; inset: 0; }
      #world { position: absolute; left: 0; top: 0; width: 160px; height: 90px; transform: scale(${scale}); transform-origin: 0 0; }
      #box { position: absolute; left: 10px; top: 25px; width: 40px; height: 40px; background: #ff0000; }
      .dot { position: absolute; top: 4px; width: 8px; height: 8px; border-radius: 50%; background: #0000ff; }
    </style>
    <script src="${RUNTIME_FILE}"></script>
  </head>
  <body>
    <div id="stage" data-composition-id="motion" data-width="${w}" data-height="${h}" data-duration="${duration}">
      <div class="clip" data-start="0" data-duration="${duration}" data-track-index="0">
        <div id="world">
          <div id="box"></div>
          <div class="dot" style="left: 4px"></div><div class="dot" style="left: 16px"></div><div class="dot" style="left: 28px"></div>
        </div>
      </div>
    </div>
    <script>
      var M = window.FrameshellMotion;
      var box = document.getElementById("box");
      var dots = document.querySelectorAll(".dot");
      // WRITE: how poses reach the page. runtime = M.write of the bundled runtime; fixed3 = runtime 0.2.0's write
      // (3 decimals); grid = runtime 0.3.0's write (x, y on 1/32 px, rotate on 0.02°).
      var WRITE = "${process.env.WRITE ?? "runtime"}";
      function f3(v) { return String(Math.round(v * 1000) / 1000); }
      function W(el, p) {
        if (WRITE === "runtime") return M.write(el, p);
        var g = WRITE === "grid";
        var x = g ? String(Math.round((p.x || 0) * 32) / 32) : f3(p.x || 0);
        var y = g ? String(Math.round((p.y || 0) * 32) / 32) : f3(p.y || 0);
        var r = g ? String(Math.round((p.rotate || 0) * 50) / 50) : f3(p.rotate || 0);
        el.style.transform = "translate(" + x + "px, " + y + "px) rotate(" + r + "deg) scale(1, 1)";
        el.style.opacity = f3(Math.min(1, Math.max(0, p.opacity == null ? 1 : p.opacity)));
      }
      var path = M.track("snappy", 0, [{ at: 0.1, to: 90 }, { at: 0.45, to: 40 }]);
      M.bind("motion", function (t) {
        W(box, { x: M.spring("playful", t, 0, 80), rotate: 12 * M.ease("enter", t), opacity: M.ease("enter", t / 0.3) });
        for (var i = 0; i < dots.length; i++) {
          W(dots[i], { x: path(t - M.stagger(i, dots.length, M.STAGGER_STEPS.items)).value, y: 0.37 * i });
        }
      });
      var realSeek = window.__timelines.motion.seek;
      window.__timelines.motion.seek = function (s) {
        var r = realSeek.call(this, s);
        ${PAGE_FIXES[process.env.PAGE_FIX ?? "none"]}
        if (window.__logSeeks) console.log("SEEK " + s + " " + box.style.transform + " " + dots[1].style.transform + " hf-seeks=" + window.__hfSeeks);
        return r;
      };
      window.__logSeeks = ${process.env.SEEKLOG ? "true" : "false"};
      ${PAGE_SETUPS[process.env.PAGE_SETUP ?? "none"]}
    </script>
  </body>
</html>
`;
}

// Every sample the accumulator folds in, in order, for the render in progress.
let samples = null;
const realAdd = blur.MotionBlurAccumulator.prototype.add;
blur.MotionBlurAccumulator.prototype.add = function (buffer) {
  samples?.push(Buffer.from(buffer));
  return realAdd.call(this, buffer);
};

async function render({ samplesPerFrame = 8, env = {}, scale = 1, blend } = {}) {
  const dir = tmp("render");
  const comp = join(dir, "composition");
  mkdirSync(comp, { recursive: true });
  writeFileSync(join(comp, "index.html"), composition({ scale }));
  writeFileSync(join(comp, RUNTIME_FILE), RUNTIME);
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  samples = [];
  seekLog = [];
  const motionBlur = samplesPerFrame ? { samplesPerFrame, ...(blend ? { blend } : {}) } : undefined;
  const job = producer.createRenderJob({
    fps: 30,
    quality: "standard",
    format: "png-sequence",
    entryFile: "index.html",
    variables: {},
    logger: { error() {}, warn() {}, info() {}, debug() {} },
    ...(motionBlur ? { motionBlur, pageMotionBlur: "off" } : {}),
  });
  const frames = join(dir, "frames");
  try {
    await producer.executeRenderJob(job, comp, frames, () => {}, new AbortController().signal);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  const got = samples;
  samples = null;
  const seeks = seekLog;
  seekLog = null;
  return { frames: readdirSync(frames).sort().map((n) => readFileSync(join(frames, n))), samples: got, seeks, perf: job.perfSummary, comp };
}

const decoded = (buf) => png.decodePng(buf).data;
function maxDiff(a, b) {
  let max = 0;
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]));
  return max;
}

/** Pixels that differ between two RGBA buffers, with both values. */
function differing(a, b, width, limit = 6) {
  const list = [];
  for (let p = 0; p < a.length; p += 4) {
    let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(a[p + c] - b[p + c]));
    if (d > 0) list.push({ x: (p / 4) % width, y: Math.floor(p / 4 / width), a: [...a.subarray(p, p + 4)], b: [...b.subarray(p, p + 4)] });
  }
  return { count: list.length, first: list.slice(0, limit) };
}

/** Renders `runs` times and reports, per run against run 0: differing output frames and differing samples. */
async function compare(label, runs, options) {
  const all = [];
  for (let r = 0; r < runs; r++) {
    const load = +loadavg()[0].toFixed(1);
    const res = await render(options);
    all.push(res);
    const base = all[0];
    if (r === 0) {
      out({ label, run: r, load1m: load, ms: res.perf?.totalElapsedMs, screenshotMs: res.perf?.captureScreenshotAvgMs, frames: res.frames.length, samples: res.samples.length });
      continue;
    }
    const frameDiffs = [];
    res.frames.forEach((f, i) => {
      if (!f.equals(base.frames[i])) frameDiffs.push({ frame: i, max: maxDiff(decoded(f), decoded(base.frames[i])) });
    });
    const per = options.samplesPerFrame ?? 0;
    const sampleDiffs = [];
    res.samples.forEach((s, i) => {
      if (!s.equals(base.samples[i])) {
        const d = differing(decoded(s), decoded(base.samples[i]), 160 * (options.scale ?? 1), 3);
        sampleDiffs.push({ frame: per ? Math.floor(i / per) : null, k: per ? i % per : i, pixels: d.count, first: d.first });
      }
    });
    out({ label, run: r, load1m: load, ms: res.perf?.totalElapsedMs, screenshotMs: res.perf?.captureScreenshotAvgMs, differingFrames: frameDiffs, differingSamples: sampleDiffs.length, sampleDetail: sampleDiffs.slice(0, 6) });
  }
  return all;
}

/** Each sample time captured on a fresh page (no raster history), with the producer's own Chrome flags. */
async function coldCaptures(comp, times, scale = 1) {
  const [w, h] = [160 * scale, 90 * scale];
  const { createServer } = await import("node:http");
  const server = createServer((request, response) => {
    const name = decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname).replace(/^\//, "");
    try {
      response.writeHead(200, { "content-type": name.endsWith(".html") ? "text/html" : "text/javascript" }).end(readFileSync(join(comp, name)));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/index.html`;
  const args = browserManager.buildChromeArgs({ width: w, height: h, captureMode: "screenshot" }, { browserGpuMode: "software" });
  const browser = await realPuppeteer.launch({ executablePath: process.env.PRODUCER_HEADLESS_SHELL_PATH, headless: true, args: [...args, ...extraArgs] });
  const shots = [];
  try {
    for (const t of times) {
      const page = await browser.newPage();
      await page.setViewport({ width: w, height: h });
      await page.goto(url);
      await page.waitForFunction("window.__timelines && window.__timelines.motion");
      const cdp = await page.createCDPSession();
      await cdp.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
      await page.evaluate(`window.__timelines.motion.seek(${t})`);
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false, clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
      shots.push(Buffer.from(data, "base64"));
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  return shots;
}

/** Renders until two different sample sets show up, then says which one a cold capture agrees with. */
async function variants(maxRuns, per = 8) {
  const seen = [];
  for (let r = 0; r < maxRuns && seen.length < 2; r++) {
    const load = +loadavg()[0].toFixed(1);
    const res = await render({ samplesPerFrame: per, env });
    const key = res.samples.map(sha).join();
    if (!seen.some((v) => v.key === key)) seen.push({ key, run: r, ...res });
    out({ stage: "variants", run: r, load1m: load, variant: seen.findIndex((v) => v.key === key) });
  }
  if (seen.length < 2) return seen;
  const [a, b] = seen;
  const plan = blur.resolveMotionBlurPlan({ samplesPerFrame: per });
  const idx = a.samples.map((s, i) => (s.equals(b.samples[i]) ? -1 : i)).filter((i) => i >= 0);
  const times = idx.map((i) => blur.motionBlurSampleTimes(plan, Math.floor(i / per), 30, per)[i % per]);
  const cold = await coldCaptures(a.comp, times);
  for (const [n, i] of idx.entries()) {
    const ref = decoded(cold[n]);
    const [da, db] = [decoded(a.samples[i]), decoded(b.samples[i])];
    out({
      stage: "variants",
      frame: Math.floor(i / per),
      k: i % per,
      t: times[n],
      variantAvsCold: differing(da, ref, 160, 3),
      variantBvsCold: differing(db, ref, 160, 3),
    });
  }
  if (a.seeks.length && b.seeks.length) {
    const firstDiff = a.seeks.findIndex((s, i) => s !== b.seeks[i]);
    out({ stage: "variants", seeksA: a.seeks.length, seeksB: b.seeks.length, firstDifferentSeek: firstDiff, a: a.seeks[firstDiff], b: b.seeks[firstDiff] });
  }
  return seen;
}

/** One render against cold captures of every one of its sample times: how many samples carry raster history? */
async function vsCold(per = 8) {
  const res = await render({ samplesPerFrame: per, env });
  const plan = blur.resolveMotionBlurPlan({ samplesPerFrame: per });
  const times = res.frames.flatMap((_, f) => blur.motionBlurSampleTimes(plan, f, 30, per));
  const cold = await coldCaptures(res.comp, times);
  let [bad, worst, pixels] = [0, 0, 0];
  const where = [];
  res.samples.forEach((s, i) => {
    if (s.equals(cold[i])) return;
    const [a, b] = [decoded(s), decoded(cold[i])];
    const d = differing(a, b, 160, 2);
    bad++;
    pixels += d.count;
    worst = Math.max(worst, maxDiff(a, b));
    if (where.length < Number(process.env.WHERE ?? 4)) where.push({ frame: Math.floor(i / per), k: i % per, ...d });
  });
  out({ stage: "vscold", extraArgs, env, load1m: +loadavg()[0].toFixed(1), samples: res.samples.length, notIdenticalToCold: bad, differingPixels: pixels, worstByteDiff: worst, where });
  return [res];
}

const burners =Array.from({ length: Number(process.env.BURN ?? 0) }, () =>
  import("node:child_process").then(({ spawn }) => spawn(process.execPath, ["-e", "for(;;);"], { stdio: "ignore" })),
);
const killBurners = async () => (await Promise.all(burners)).forEach((b) => b.kill());
process.on("exit", () => void killBurners());

// RENDER_ENV='{"PRODUCER_ENABLE_BROWSER_POOL":"false"}' sets producer env for each render; SAVE=file writes run hashes.
const [stage = "samples", runs = "4"] = process.argv.slice(2);
const env = JSON.parse(process.env.RENDER_ENV ?? "{}");
let result = [];
if (stage === "samples") result = await compare("fixed8", Number(runs), { samplesPerFrame: 8, env });
if (stage === "sharp") result = await compare("off", Number(runs), { samplesPerFrame: 0, env });
if (stage === "variants") result = await variants(Number(runs));
if (stage === "vscold") result = await vsCold();
if (stage === "sharpcold") {
  // A sharp render (one seek and one capture per frame) against cold captures of its frame times.
  const res = await render({ samplesPerFrame: 0, env });
  const cold = await coldCaptures(res.comp, res.frames.map((_, f) => f / 30));
  const bad = res.frames.map((f, i) => (f.equals(cold[i]) ? null : { frame: i, max: maxDiff(decoded(f), decoded(cold[i])) })).filter(Boolean);
  out({ stage: "sharpcold", env, extraArgs, load1m: +loadavg()[0].toFixed(1), frames: res.frames.length, notIdenticalToCold: bad.length, bad: bad.slice(0, 8) });
}
if (stage === "stale") {
  // SEEKLOG=1: for each sample that differs from its cold capture, which earlier seek's cold capture
  // agrees with the differing pixels? (Is the capture showing an older state?)
  const res = await render({ samplesPerFrame: 8, env });
  const seekTimes = res.seeks.map((s) => Number(s.split(" ")[0]));
  const distinct = [...new Set(seekTimes)];
  const cold = await coldCaptures(res.comp, distinct);
  const coldOf = new Map(distinct.map((t, i) => [t, decoded(cold[i])]));
  const plan = blur.resolveMotionBlurPlan({ samplesPerFrame: 8 });
  const times = res.frames.flatMap((_, f) => blur.motionBlurSampleTimes(plan, f, 30, 8));
  // Seek index of each sample: the n-th seek to a planned sample time, in order.
  let cursor = 0;
  const report = [];
  res.samples.forEach((s, i) => {
    while (seekTimes[cursor] !== times[i]) cursor++;
    const mine = decoded(s);
    const ref = coldOf.get(times[i]);
    if (maxDiff(mine, ref) === 0) {
      cursor++;
      return;
    }
    const mask = [];
    for (let p = 0; p < mine.length; p += 4) if (mine.subarray(p, p + 4).some((v, c) => v !== ref[p + c])) mask.push(p);
    const agree = (img) => mask.filter((p) => [0, 1, 2, 3].every((c) => img[p + c] === mine[p + c])).length;
    const back = [];
    for (let j = cursor - 1; j >= Math.max(0, cursor - 12); j--) back.push({ ago: cursor - j, t: seekTimes[j], agree: agree(coldOf.get(seekTimes[j])) });
    report.push({ frame: Math.floor(i / 8), k: i % 8, pixels: mask.length, best: back.sort((a, b) => b.agree - a.agree).slice(0, 3) });
    cursor++;
  });
  out({ stage: "stale", differing: report.length, report: report.slice(0, Number(process.env.WHERE ?? 10)) });
}
if (stage === "seeks") {
  // SEEKLOG=1: the times the page was seeked to, against the producer's planned sample times.
  const res = await render({ samplesPerFrame: 8, env });
  const plan = blur.resolveMotionBlurPlan({ samplesPerFrame: 8 });
  const planned = new Set(res.frames.flatMap((_, f) => blur.motionBlurSampleTimes(plan, f, 30, 8)).map(String));
  const seen = res.seeks.map((s) => s.split(" ")[0]);
  out({ stage: "seeks", total: seen.length, notPlanned: [...new Set(seen.filter((t) => !planned.has(t)))].slice(0, 80), missing: [...planned].filter((t) => !seen.includes(t)) });
}
await killBurners();
if (process.env.SAVE) {
  writeFileSync(process.env.SAVE, JSON.stringify(result.map((r) => ({ frames: r.frames.map(sha), samples: r.samples.map(sha) }))));
}
