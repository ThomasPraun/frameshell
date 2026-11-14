// PROTOTYPE, throwaway (#501 slice 0): measures the HyperFrames producer's sub-frame motion blur. See README.md.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { cpus, loadavg, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(join(root, "plugins/hyperframes/package.json"));
// The packages only export for `import`, so resolve their files by path: producer and engine are siblings in the pnpm store.
const producerDir = realpathSync(join(root, "plugins/hyperframes/node_modules/@hyperframes/producer"));
const engineDir = realpathSync(join(producerDir, "../engine"));
const producer = await import(pathToFileURL(join(producerDir, "dist/index.js")).href);
const puppeteer = (await import(pathToFileURL(require.resolve("puppeteer-core")).href)).default;
const blurModule = await import(pathToFileURL(join(engineDir, "dist/services/motionBlur.js")).href);
const enginePkg = JSON.parse(readFileSync(join(engineDir, "package.json"), "utf8"));
const producerPkg = JSON.parse(readFileSync(join(producerDir, "package.json"), "utf8"));

const binDir = process.env.FRAMESHELL_TEST_BINARIES_DIR || join(root, ".cache/test-binaries");
const find = (name) => {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name === name ? [join(dir, e.name)] : []));
  return walk(join(binDir, "binaries"))[0];
};
const ffmpeg = find("ffmpeg");
const ffprobe = find("ffprobe");
const chrome = find("chrome-headless-shell");
process.env.HYPERFRAMES_FFMPEG_PATH = ffmpeg;
process.env.HYPERFRAMES_FFPROBE_PATH = ffprobe;
process.env.PRODUCER_HEADLESS_SHELL_PATH = chrome;

const runtimeSource = readFileSync(join(root, "plugins/hyperframes/src/motion-runtime.ts"), "utf8");
const RUNTIME_FILE = /MOTION_RUNTIME_FILE = ("[^"]*")/.exec(runtimeSource)[1];
const RUNTIME = JSON.parse(/export const MOTION_RUNTIME = ("(?:[^"\\]|\\.)*");/.exec(runtimeSource)[1]);
const FPS = 30;
const out = (record) => console.log(JSON.stringify(record));
const tmp = (prefix) => realpathSync(mkdtempSync(join(tmpdir(), `fs-motion-blur-${prefix}-`)));

/**
 * The motion-real fixture (`plugins/hyperframes/test/motion-real.test.ts`): a red box springs 80 px right while turning
 * and fading in, three blue dots follow a staggered track. `scale` zooms the 160x90 world; `hold` clamps time at 1 s so
 * the rest of a longer composition is static; `beacon` reports every seek to a local server.
 */
function composition({ scale = 1, duration = 1, hold = false, beacon = 0 }) {
  const w = 160 * scale;
  const h = 90 * scale;
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
    <script src="${RUNTIME_FILE.slice(1, -1)}"></script>
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
      var path = M.track("snappy", 0, [{ at: 0.1, to: 90 }, { at: 0.45, to: 40 }]);
      M.bind("motion", function (t0) {
        var t = ${hold ? "Math.min(t0, 1)" : "t0"};
        M.write(box, { x: M.spring("playful", t, 0, 80), rotate: 12 * M.ease("enter", t), opacity: M.ease("enter", t / 0.3) });
        for (var i = 0; i < dots.length; i++) {
          M.write(dots[i], { x: path(t - M.stagger(i, dots.length, M.STAGGER_STEPS.items)).value, y: 0.37 * i });
        }
      });
      ${
        beacon
          ? `var realSeek = window.__timelines.motion.seek;
      window.__timelines.motion.seek = function (s) { new Image().src = "http://127.0.0.1:${beacon}/s?t=" + encodeURIComponent(s); return realSeek.call(this, s); };`
          : ""
      }
    </script>
  </body>
</html>
`;
}

const FIXTURES = {
  // Exactly the motion-real fixture: 160x90, 1 s, moving on every frame.
  fixture: { scale: 1, duration: 1 },
  // 640x360 (4x pixels per side), 2 s, motion in the first second then an exactly static hold.
  hold: { scale: 4, duration: 2, hold: true },
  // 1280x720, 1 s: realistic pixel count for cost per sample.
  hd: { scale: 8, duration: 1 },
};

function project(fixture, extra = {}) {
  const dir = tmp("project");
  const comp = join(dir, "compositions", "hyperframes", "motion");
  mkdirSync(comp, { recursive: true });
  writeFileSync(join(comp, "index.html"), composition({ ...FIXTURES[fixture], ...extra }));
  writeFileSync(join(comp, RUNTIME_FILE.slice(1, -1)), RUNTIME);
  return { dir, comp };
}

const MODES = {
  off: undefined,
  adaptive: {},
  fixed4: { samplesPerFrame: 4 },
  fixed8: { samplesPerFrame: 8 },
  fixed16: { samplesPerFrame: 16 },
  fixed8lin: { samplesPerFrame: 8, blend: "linear" },
  adaptivelin: { blend: "linear" },
};

/** Renders the fixture the way the adapter does (webm alpha, in-process producer) with the given blur options. */
async function render(fixture, mode, { elementCss, beacon = 0, workers, blurOptions, format = "webm" } = {}) {
  const { dir, comp } = project(fixture, { beacon });
  const copy = tmp("render");
  cpSync(comp, join(copy, "composition"), { recursive: true });
  const entry = join(copy, "composition", "index.html");
  if (elementCss) {
    const html = readFileSync(entry, "utf8");
    const tag = `<style data-frameshell-elements>\n${elementCss}\n</style>`;
    const at = html.search(/<\/head\s*>/i);
    writeFileSync(entry, html.slice(0, at) + tag + html.slice(at));
  }
  const logs = [];
  const logger = Object.fromEntries(["error", "warn", "info", "debug"].map((level) => [level, (message, meta) => logs.push({ level, message, meta })]));
  const motionBlur = blurOptions ?? MODES[mode];
  const config = {
    fps: FPS,
    quality: "standard",
    format,
    entryFile: "index.html",
    variables: {},
    logger,
    ...(motionBlur ? { motionBlur, pageMotionBlur: "off" } : {}),
    ...(workers ? { workers } : {}),
  };
  const job = producer.createRenderJob(config);
  const file = format === "png-sequence" ? join(copy, "frames") : join(copy, "render.webm");
  const started = performance.now();
  let error;
  try {
    await producer.executeRenderJob(job, join(copy, "composition"), file, () => {}, new AbortController().signal);
  } catch (e) {
    error = String(e?.message ?? e);
  }
  const ms = Math.round(performance.now() - started);
  const perf = job.perfSummary;
  return { file, ms, error, logs, perf, dir };
}

const pick = (perf) =>
  perf && {
    totalElapsedMs: perf.totalElapsedMs,
    totalFrames: perf.totalFrames,
    workers: perf.workers,
    captureAvgMs: perf.captureAvgMs,
    captureSeekAvgMs: perf.captureSeekAvgMs,
    captureScreenshotAvgMs: perf.captureScreenshotAvgMs,
    staticDedup: perf.staticDedup && { ...perf.staticDedup, verificationOutcomes: undefined },
    beginFrameReuse: perf.beginFrameReuse,
    drawElement: perf.drawElement,
    motionBlur: perf.motionBlur,
    stages: perf.stages,
  };

/** All frames of a render as RGBA, decoded with libvpx (keeps alpha). */
async function decode(file, width, height) {
  const { stdout } = await execFileAsync(ffmpeg, ["-v", "error", "-c:v", "libvpx-vp9", "-i", file, "-vf", "format=rgba", "-f", "rawvideo", "-"], {
    encoding: "buffer",
    maxBuffer: 1 << 30,
  });
  const size = width * height * 4;
  return Array.from({ length: Math.floor(stdout.length / size) }, (_, i) => stdout.subarray(i * size, (i + 1) * size));
}

/** Shape of the red box in an RGBA frame: horizontal extent, alpha mass and partially covered pixels. */
function boxStats(frame, width, height) {
  let [minX, maxX, mass, partial, n, sx, sy] = [width, -1, 0, 0, 0, 0, 0];
  for (let i = 0; i < frame.length; i += 4) {
    const [r, g, b, a] = [frame[i], frame[i + 1], frame[i + 2], frame[i + 3]];
    if (a > 8 && r > g + 60 && r > b + 60) {
      const x = (i / 4) % width;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      mass += a / 255;
      if (a < 247) partial++;
      if (a > 128 && r > 150) {
        n++;
        sx += x;
        sy += Math.floor(i / 4 / width);
      }
    }
  }
  return { width: maxX - minX + 1, alphaMass: Math.round(mass), partialPixels: partial, centre: n ? [+(sx / n).toFixed(1), +(sy / n).toFixed(1)] : null };
}

const diffStats = (a, b) => {
  let [max, sum] = [0, 0];
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    max = Math.max(max, d);
    sum += d;
  }
  return { max, mean: +(sum / a.length).toFixed(4) };
};

const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 12);

async function timing(fixture, reps) {
  for (const mode of (process.env.MODES ?? "off,adaptive,fixed4,fixed8,fixed16").split(",")) {
    for (let rep = 0; rep < reps; rep++) {
      const r = await render(fixture, mode);
      out({ stage: "timing", fixture, mode, rep, ms: r.ms, load1m: +loadavg()[0].toFixed(1), error: r.error, perf: pick(r.perf) });
    }
  }
}

/** Seeks per output frame, counted by a beacon the page sends on every `seek`. */
async function counts(fixture) {
  const seen = [];
  const server = createServer((request, response) => {
    seen.push(Number(new URL(request.url, "http://x").searchParams.get("t")));
    response.writeHead(204, { "access-control-allow-origin": "*" }).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const beacon = server.address().port;
  for (const mode of ["off", "adaptive", "fixed8"]) {
    seen.length = 0;
    const r = await render(fixture, mode, { beacon });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const total = r.perf?.totalFrames ?? Math.round(FIXTURES[fixture].duration * FPS);
    const perFrame = new Array(total).fill(0);
    let outside = 0;
    const distinct = new Set(seen);
    for (const t of seen) {
      const f = Math.round(t * FPS);
      if (f >= 0 && f < total) perFrame[f]++;
      else outside++;
    }
    const histogram = {};
    for (const c of perFrame) histogram[c] = (histogram[c] ?? 0) + 1;
    out({
      stage: "counts",
      fixture,
      mode,
      ms: r.ms,
      error: r.error,
      beaconsTotal: seen.length,
      distinctTimes: distinct.size,
      outsideRange: outside,
      framesWithNoSeek: perFrame.filter((c) => c === 0).length,
      histogramSeeksPerFrame: histogram,
      firstFrames: perFrame.slice(0, 12),
      lastFrames: perFrame.slice(-6),
      perf: pick(r.perf),
      dedupLogs: r.logs.filter((l) => /dedup|MotionBlur|capture mode|Auto-selected/i.test(l.message)).map((l) => l.message),
    });
  }
  server.close();
}

/** Does the blurred output smear, and does a sprung element still take element CSS (ADR 0021)? */
async function blurLook(fixture) {
  const f = FIXTURES[fixture];
  const [w, h] = [160 * f.scale, 90 * f.scale];
  const css = "#box { translate: 0px 30px !important; }";
  const frames = {};
  for (const [name, mode, elementCss] of [
    ["off", "off"],
    ["adaptive", "adaptive"],
    ["fixed8", "fixed8"],
    ["adaptive+css", "adaptive", css],
    ["off+css", "off", css],
  ]) {
    const r = await render(fixture, mode, { elementCss });
    if (r.error) {
      out({ stage: "blur-look", fixture, name, error: r.error, logs: r.logs.filter((l) => l.level !== "debug").slice(-3) });
      continue;
    }
    frames[name] = await decode(r.file, w, h);
  }
  for (const name of Object.keys(frames)) {
    out({
      stage: "blur-look",
      fixture,
      name,
      frames: frames[name].length,
      // 0.1 s: spring ramping up; 0.3 s: near peak speed/overshoot; 0.9 s: at rest.
      t0_1: boxStats(frames[name][3], w, h),
      t0_3: boxStats(frames[name][9], w, h),
      t0_9: boxStats(frames[name][27], w, h),
    });
  }
}

/** Serves a composition directory (no HyperFrames runtime: the motion runtime paints on `seek`). */
async function serve(comp) {
  const server = createServer((request, response) => {
    const name = decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname).replace(/^\//, "");
    try {
      const body = readFileSync(join(comp, name));
      response.writeHead(200, { "content-type": name.endsWith(".html") ? "text/html" : "text/javascript" }).end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/index.html` };
}

/** Render-to-render determinism, and cold-vs-reseek of the producer's own sample times (<= 2/255 target). */
async function diff(fixture) {
  const f = FIXTURES[fixture];
  const [w, h] = [160 * f.scale, 90 * f.scale];
  const a = await render(fixture, "adaptive");
  const b = await render(fixture, "adaptive");
  const fa = await decode(a.file, w, h);
  const fb = await decode(b.file, w, h);
  let worst = 0;
  fa.forEach((frame, i) => (worst = Math.max(worst, diffStats(frame, fb[i]).max)));
  out({ stage: "diff", fixture, check: "render-to-render adaptive", sameFileHash: sha(a.file) === sha(b.file), frames: fa.length, worstDecodedByteDiff: worst, ms: [a.ms, b.ms] });
  const c = await render(fixture, "fixed8");
  const d = await render(fixture, "fixed8");
  const fc = await decode(c.file, w, h);
  const fd = await decode(d.file, w, h);
  worst = 0;
  fc.forEach((frame, i) => (worst = Math.max(worst, diffStats(frame, fd[i]).max)));
  out({ stage: "diff", fixture, check: "render-to-render fixed8", sameFileHash: sha(c.file) === sha(d.file), frames: fc.length, worstDecodedByteDiff: worst });

  // Cold vs reseek: capture the producer's sample times (fixed 8) on a fresh page each, and on one page after unrelated seeks.
  const { comp } = project(fixture);
  const { server, url } = await serve(comp);
  const browser = await puppeteer.launch({ executablePath: chrome });
  try {
    const plan = blurModule.resolveMotionBlurPlan({ samplesPerFrame: 8 });
    const frameIdx = Array.from({ length: 12 }, (_, i) => Math.floor(((i + 0.37) * Math.round(f.duration * FPS)) / 12));
    const shot = async (page, t) => {
      await page.evaluate(`window.__timelines.motion.seek(${t})`);
      return Buffer.from(await page.screenshot({ type: "png", omitBackground: true }));
    };
    const open = async () => {
      const page = await browser.newPage();
      await page.setViewport({ width: w, height: h });
      await page.goto(url);
      await page.waitForFunction("window.__timelines && window.__timelines.motion");
      return page;
    };
    const times = frameIdx.map((frame) => blurModule.motionBlurSampleTimes(plan, frame, FPS, 8));
    const cold = [];
    for (const list of times) {
      const samples = [];
      for (const t of list) {
        const page = await open();
        samples.push(await shot(page, t));
        await page.close();
      }
      cold.push(samples);
    }
    const warm = await open();
    const reseek = [];
    for (const [i, list] of times.entries()) {
      const samples = [];
      for (const t of list) {
        await shot(warm, times[(i + 5) % times.length][0]);
        samples.push(await shot(warm, t));
      }
      reseek.push(samples);
    }
    const avg = (pngs) => {
      const acc = new blurModule.MotionBlurAccumulator("linear");
      pngs.forEach((png) => acc.add(png));
      return acc.finish().data;
    };
    let [worstSample, worstAverage] = [0, 0];
    for (let i = 0; i < times.length; i++) {
      for (let k = 0; k < times[i].length; k++) {
        const [x, y] = await Promise.all([decodePng(cold[i][k]), decodePng(reseek[i][k])]);
        worstSample = Math.max(worstSample, diffStats(x, y).max);
      }
      worstAverage = Math.max(worstAverage, diffStats(avg(cold[i]), avg(reseek[i])).max);
    }
    out({ stage: "diff", fixture, check: "cold vs reseek, fixed 8 sample times of 12 probe frames", frames: frameIdx, samples: times.flat().length, worstSampleByteDiff: worstSample, worstBlendedByteDiff: worstAverage });

    // Do the producer's frames match an average of those samples? (VP9 lossy, so not exact.)
    const mine = frameIdx.map((_, i) => avg(cold[i]));
    const closeToBlur = mine.map((m, i) => diffStats(m, fc[frameIdx[i]]).mean);
    const sharp = await render(fixture, "off");
    const fs = await decode(sharp.file, w, h);
    const closeToSharp = mine.map((m, i) => diffStats(m, fs[frameIdx[i]]).mean);
    out({ stage: "diff", fixture, check: "own sample average vs producer fixed8 / vs sharp frame (mean abs byte diff)", frameIdx, vsBlurred: closeToBlur, vsSharp: closeToSharp });
  } finally {
    await browser.close();
    server.close();
  }
}


/** Is the pipeline itself repeatable? Two renders per mode, as lossless PNG sequences and as the shipped WebM. */
async function repeat(fixture) {
  const f = FIXTURES[fixture];
  const [w, h] = [160 * f.scale, 90 * f.scale];
  for (const mode of ["off", "fixed8", "adaptive"]) {
    const pngs = [];
    for (let i = 0; i < 2; i++) {
      const r = await render(fixture, mode, { format: "png-sequence" });
      if (r.error) {
        out({ stage: "repeat", fixture, mode, format: "png-sequence", error: r.error });
        break;
      }
      const names = readdirSync(r.file).sort();
      pngs.push(names.map((n) => readFileSync(join(r.file, n))));
    }
    if (pngs.length === 2) {
      let identical = 0;
      let worst = 0;
      for (let i = 0; i < pngs[0].length; i++) {
        if (pngs[0][i].equals(pngs[1][i])) identical++;
        else worst = Math.max(worst, diffStats(await decodePng(pngs[0][i]), await decodePng(pngs[1][i])).max);
      }
      out({ stage: "repeat", fixture, mode, format: "png-sequence", frames: pngs[0].length, byteIdenticalFrames: identical, worstByteDiffOfOthers: worst });
    }
    const webm = [];
    for (let i = 0; i < 3; i++) webm.push(await decode((await render(fixture, mode)).file, w, h));
    let worst = [0, 0];
    webm[0].forEach((frame, i) => {
      worst[0] = Math.max(worst[0], diffStats(frame, webm[1][i]).max);
      worst[1] = Math.max(worst[1], diffStats(frame, webm[2][i]).max);
    });
    out({ stage: "repeat", fixture, mode, format: "webm", frames: webm[0].length, worstDecodedByteDiff_run0_vs_run1_and_run2: worst });
  }
}


/**
 * Which frames of a repeated fixed-8 render differ, and which side is wrong? Each frame is compared with a reference built
 * from the same sample times captured one by one on a quiet page (the page is a pure function of t, see `diff`).
 */
async function which(fixture) {
  const f = FIXTURES[fixture];
  const [w, h] = [160 * f.scale, 90 * f.scale];
  const frames = Math.round(f.duration * FPS);
  const plan = blurModule.resolveMotionBlurPlan(MODES.fixed8);
  const { comp } = project(fixture);
  const { server, url } = await serve(comp);
  const browser = await puppeteer.launch({ executablePath: chrome });
  const reference = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: h });
    await page.goto(url);
    await page.waitForFunction("window.__timelines && window.__timelines.motion");
    for (let frame = 0; frame < frames; frame++) {
      const acc = new blurModule.MotionBlurAccumulator(plan.blend);
      for (const t of blurModule.motionBlurSampleTimes(plan, frame, FPS, 8)) {
        await page.evaluate(`window.__timelines.motion.seek(${t})`);
        acc.add(Buffer.from(await page.screenshot({ type: "png", omitBackground: true })));
      }
      reference.push(acc.finish().data);
    }
  } finally {
    await browser.close();
    server.close();
  }
  for (let run = 0; run < 4; run++) {
    const r = await render(fixture, "fixed8", { format: "png-sequence" });
    const names = readdirSync(r.file).sort();
    const bad = [];
    for (const [i, name] of names.entries()) {
      const d = diffStats(await decodePng(readFileSync(join(r.file, name))), Buffer.from(reference[i]));
      if (d.max > 2) bad.push({ frame: i, ...d });
    }
    out({ stage: "which", fixture, run, load1m: +loadavg()[0].toFixed(1), frames: names.length, framesFarFromReference: bad });
  }
}


/** Where do two fixed-8 renders of the same clip differ? Prints the differing pixels of each differing frame. */
async function where(fixture) {
  const f = FIXTURES[fixture];
  const w = 160 * f.scale;
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const r = await render(fixture, "fixed8", { format: "png-sequence" });
    runs.push(await Promise.all(readdirSync(r.file).sort().map((n) => decodePng(readFileSync(join(r.file, n))))));
  }
  for (const [a, b] of [[0, 1], [0, 2]]) {
    runs[a].forEach((frame, i) => {
      const pixels = [];
      for (let p = 0; p < frame.length; p += 4) {
        const d = Math.max(...[0, 1, 2, 3].map((c) => Math.abs(frame[p + c] - runs[b][i][p + c])));
        if (d > 2) pixels.push({ x: (p / 4) % w, y: Math.floor(p / 4 / w), a: [...frame.subarray(p, p + 4)], b: [...runs[b][i].subarray(p, p + 4)] });
      }
      if (pixels.length) out({ stage: "where", pair: [a, b], frame: i, pixels: pixels.length, first: pixels.slice(0, 4) });
    });
  }
}

/** PNG screenshot to RGBA bytes with ffmpeg. */
async function decodePng(png) {
  const file = join(tmp("png"), "s.png");
  writeFileSync(file, png);
  const { stdout } = await execFileAsync(ffmpeg, ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { encoding: "buffer", maxBuffer: 1 << 28 });
  return stdout;
}

// BURN=n: n busy-loop processes for the length of the run, to see what host load does to a render.
const burners = Array.from({ length: Number(process.env.BURN ?? 0) }, () => spawn(process.execPath, ["-e", "for(;;);"], { stdio: "ignore" }));
process.on("exit", () => burners.forEach((b) => b.kill()));

const [stage = "all", fixture = "fixture", reps = "3"] = process.argv.slice(2);
out({
  stage: "env",
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  cpus: cpus().length,
  cpu: cpus()[0]?.model,
  memGb: Math.round(totalmem() / 2 ** 30),
  producer: producerPkg.version,
  engine: enginePkg.version,
});
if (stage === "timing" || stage === "all") await timing(fixture, Number(reps));
if (stage === "counts" || stage === "all") await counts(fixture);
if (stage === "blur-look" || stage === "all") await blurLook(fixture);
if (stage === "diff" || stage === "all") await diff(fixture);
if (stage === "repeat" || stage === "all") await repeat(fixture);
if (stage === "which") await which(fixture);
if (stage === "where") await where(fixture);
burners.forEach((b) => b.kill());
