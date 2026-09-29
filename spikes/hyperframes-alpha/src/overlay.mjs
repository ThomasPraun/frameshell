// PROTOTYPE, throwaway (ticket #3). Overlays a rendered alpha clip on a
// synthetic background with ffmpeg-static, then extracts frames to inspect.
//
// Usage: node src/overlay.mjs out/title-card-standard.mov
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ffmpeg, probe } from "./ff.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "out");
const clip = resolve(process.argv[2] ?? join(outDir, "title-card-standard.mov"));
const codec = probe(clip).codec;

// Synthetic "footage": moving test pattern, opaque H.264, same size and fps.
const bg = join(outDir, "background.mp4");
if (!existsSync(bg)) {
  ffmpeg([
    "-f", "lavfi", "-i", "testsrc2=size=2560x1440:rate=30:duration=8",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", bg,
  ]);
}

const name = basename(clip).replace(/\.([^.]+)$/, "-$1"); // keep ext: mov and webm must not collide
const composite = join(outDir, `composite-${name}.mp4`);
const t0 = performance.now();
ffmpeg([
  "-i", bg,
  // VP9 alpha only decodes through libvpx; native vp9 decoder drops it.
  ...(codec === "vp9" ? ["-c:v", "libvpx-vp9"] : []),
  "-i", clip,
  "-filter_complex", "[0:v][1:v]overlay=0:0:format=auto:shortest=1[v]",
  "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", composite,
]);
const overlaySeconds = (performance.now() - t0) / 1000;

// Frames to eyeball: before intro, mid-title, during fade-out.
const framesDir = join(outDir, "frames");
mkdirSync(framesDir, { recursive: true });
const frames = [];
for (const t of [0.1, 3, 7.5]) {
  const png = join(framesDir, `${name}-t${t}.png`);
  ffmpeg(["-ss", String(t), "-i", composite, "-frames:v", "1", "-vf", "scale=1280:-1", png]);
  frames.push(png);
}
const result = { clip, composite, overlaySeconds: +overlaySeconds.toFixed(2), frames };
console.log(JSON.stringify(result, null, 2));
console.log("RESULT " + JSON.stringify(result));
