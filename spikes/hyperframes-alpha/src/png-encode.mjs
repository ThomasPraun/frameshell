// PROTOTYPE, throwaway. Alternative pipeline: capture once as RGBA PNGs, then
// encode preview (VP9 alpha) and/or master (ProRes 4444) ourselves.
// Run `npm run render:png` first.
import { statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ffmpeg, probe, alphaAt, SAMPLES } from "./ff.mjs";

const outDir = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "out");
const seq = join(outDir, "title-card-standard-png", "frame_%06d.png");

const targets = [
  // Same flags the producer documents for its own webm path.
  ["png-encoded.webm", ["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "30", "-auto-alt-ref", "0", "-cpu-used", "4", "-row-mt", "1", "-metadata:s:v:0", "alpha_mode=1"]],
  ["png-encoded.mov", ["-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le"]],
];
for (const [name, codecArgs] of targets) {
  const out = join(outDir, name);
  const t0 = performance.now();
  ffmpeg(["-framerate", "30", "-i", seq, ...codecArgs, out]);
  const seconds = +((performance.now() - t0) / 1000).toFixed(2);
  const info = probe(out);
  const alpha = SAMPLES.map((s) => alphaAt(out, s.t, s.x, s.y, info.codec));
  console.log(JSON.stringify({ name, encodeSeconds: seconds, megabytes: +(statSync(out).size / 2 ** 20).toFixed(1), pixFmt: info.pixFmt, alphaModeTag: info.alphaModeTag, alpha }));
}
