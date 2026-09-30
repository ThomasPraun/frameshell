// Test fixture: a clip adapter that renders a flat colour card with ffmpeg, like a HyperFrames clip but in
// milliseconds. The composition is a JSON file: { color, alpha, seconds, delayMs, fail }. Props: { label? }.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Standard Schema v1 validator, hand-written: the fixture has no dependencies. */
const propsSchema = {
  "~standard": {
    version: 1,
    vendor: "card-fixture",
    validate(value) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return { issues: [{ message: "props must be an object" }] };
      if (value.label !== undefined && typeof value.label !== "string") return { issues: [{ message: "must be a string", path: ["label"] }] };
      return { value };
    },
  },
};

export function activate(api) {
  const project = api.project.dir;
  api.registerClipType({
    type: "card",
    propsSchema,
    inputs: (clip) => (clip.source ? [clip.source] : []),
    async render(clip, ctx) {
      const card = JSON.parse(await readFile(join(project, ...clip.source.split("/")), "utf8"));
      if (card.fail) throw new Error(`card ${clip.source} asks to fail`);
      const steps = 5;
      for (let step = 1; step <= steps; step++) {
        await new Promise((resolve) => setTimeout(resolve, (card.delayMs ?? 0) / steps));
        if (ctx.signal.aborted) throw new Error("aborted");
        ctx.progress({ fraction: step / (steps + 1), message: "Painting" });
      }
      const ffmpeg = await ctx.ensureBinary("ffmpeg");
      const file = join(ctx.outDir, "card.webm");
      const size = `${ctx.width}x${ctx.height}`;
      const alpha = card.alpha ?? 1;
      await new Promise((resolve, reject) =>
        execFile(
          ffmpeg,
          [
            ...["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi"],
            ...["-i", `color=c=${card.color ?? "white"}@${alpha}:s=${size}:r=${ctx.fps}:d=${card.seconds ?? 2},format=rgba`],
            ...["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", "-crf", "30", "-b:v", "0", "-deadline", "realtime", file],
          ],
          (error, _stdout, stderr) => (error ? reject(new Error(stderr || error.message)) : resolve()),
        ),
      );
      return { file, hasAlpha: true };
    },
  });
}
