// PROTOTYPE, throwaway. Shows why overlay.mjs forces libvpx-vp9: decodes the
// same VP9 alpha pixel with ffmpeg's native decoder and with libvpx.
import { execFileSync } from "node:child_process";
import { FFMPEG, SAMPLES } from "./ff.mjs";

const file = process.argv[2] ?? "out/title-card-standard.webm";
const alpha = (decoder, s) => {
  const args = ["-v", "error", "-ss", String(s.t)];
  if (decoder) args.push("-c:v", decoder);
  args.push("-i", file, "-frames:v", "1", "-vf", `crop=1:1:${s.x}:${s.y},format=rgba`, "-f", "rawvideo", "-");
  return execFileSync(FFMPEG, args)[3];
};
for (const s of SAMPLES) {
  console.log(`${s.name}: native vp9 alpha=${alpha(null, s)}, libvpx-vp9 alpha=${alpha("libvpx-vp9", s)}`);
}
