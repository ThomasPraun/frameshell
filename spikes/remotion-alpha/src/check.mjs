// PROTOTYPE, throwaway. Question 1, second half: the fast render plays with alpha in Chromium
// <video> (managed Chrome via playwright-core from the repo), and overlays on footage with ffmpeg.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { CHROME, OUT, SPIKE, alphaAt, ffmpeg } from "./common.mjs";

const file = process.argv[2] ?? join(OUT, "card-2560x1440-30-managed.webm");
const repoRequire = createRequire(join(SPIKE, "..", "..", "node_modules", ".pnpm", "playwright-core@1.63.0", "node_modules", "playwright-core", "package.json"));
const { chromium } = repoRequire("playwright-core");
const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage();
const b64 = (await readFile(file)).toString("base64");
const result = await page.evaluate(async (data) => {
  const blob = new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type: "video/webm" });
  const video = document.createElement("video");
  video.muted = true;
  video.src = URL.createObjectURL(blob);
  await new Promise((ok, fail) => { video.onloadeddata = ok; video.onerror = () => fail(new Error(String(video.error?.message))); });
  video.currentTime = 3;
  await new Promise((ok) => (video.onseeked = ok));
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0);
  const at = (x, y) => ctx.getImageData(x, y, 1, 1).data[3];
  return { width: video.videoWidth, height: video.videoHeight, alpha: [at(10, 10), at(1150, 750), at(2130, 340)] };
}, b64);
await browser.close();

// Overlay on synthetic footage, VP9 input decoded with libvpx (ADR 0002 trap).
const over = join(OUT, "overlay.mp4");
ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=2560x1440:rate=30:duration=8", "-c:v", "libvpx-vp9", "-i", file, "-filter_complex", "[0:v][1:v]overlay=format=auto", "-c:v", "libx264", "-pix_fmt", "yuv420p", over]);
for (const t of [0.1, 3, 7.5]) ffmpeg(["-ss", String(t), "-i", over, "-frames:v", "1", join(OUT, `overlay-${t}.png`)]);
console.log(JSON.stringify({ chromium: result, overlayFrames: [0.1, 3, 7.5].map((t) => `out/overlay-${t}.png`) }, null, 2));
