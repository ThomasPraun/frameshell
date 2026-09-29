// PROTOTYPE, throwaway. SPEC §3.4 plays cached clip renders in <video> inside
// Electron (Chromium). Checks which alpha output Chromium can decode, and
// whether alpha survives: draws frame at t=3 s to a canvas, reads pixels.
import puppeteer from "puppeteer";
import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SAMPLES } from "./ff.mjs";

const outDir = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "out");
const files = ["title-card-standard.mov", "title-card-standard.webm"];

// Local HTTP: file:// blocks canvas readback (tainted).
const server = createServer((req, res) => {
  const name = decodeURIComponent(req.url.slice(1));
  if (name === "") return res.end("<!doctype html><body></body>");
  if (!files.includes(name)) return res.writeHead(404).end();
  const p = join(outDir, name);
  const type = name.endsWith(".webm") ? "video/webm" : "video/quicktime";
  const size = statSync(p).size;
  // Range support: media element seeks need it.
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
  if (!m) {
    res.writeHead(200, { "content-type": type, "content-length": size, "accept-ranges": "bytes" });
    return createReadStream(p).pipe(res);
  }
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : size - 1;
  res.writeHead(206, {
    "content-type": type,
    "content-length": end - start + 1,
    "content-range": `bytes ${start}-${end}/${size}`,
    "accept-ranges": "bytes",
  });
  createReadStream(p, { start, end }).pipe(res);
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.goto(base);
console.log(`Browser: ${await browser.version()}`);
for (const f of files) {
  const r = await page.evaluate(
    async (src, samples) => {
      const v = document.createElement("video");
      v.muted = true;
      const canPlay = {
        prores: v.canPlayType('video/quicktime; codecs="ap4h"'),
        vp9: v.canPlayType('video/webm; codecs="vp9"'),
      };
      v.src = src;
      const loaded = await new Promise((ok) => {
        v.onloadeddata = () => ok("loadeddata");
        v.onerror = () => ok(`error code ${v.error?.code}: ${v.error?.message}`);
        setTimeout(() => ok("timeout"), 10000);
      });
      if (loaded !== "loadeddata") return { canPlay, loaded };
      v.currentTime = 3;
      await new Promise((ok) => (v.onseeked = ok));
      const c = document.createElement("canvas");
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      const ctx = c.getContext("2d");
      ctx.drawImage(v, 0, 0);
      const alpha = samples.map((s) => ctx.getImageData(s.x, s.y, 1, 1).data[3]);
      return { canPlay, loaded, size: `${v.videoWidth}x${v.videoHeight}`, alpha };
    },
    base + f,
    SAMPLES,
  );
  console.log(f, JSON.stringify(r));
}
await browser.close();
server.close();
