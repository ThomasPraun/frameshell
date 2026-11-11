import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probeSource } from "../src/media/ffmpeg.js";
import { JobQueue } from "../src/jobs/queue.js";
import { MediaService } from "../src/media/service.js";
import { MediaStore, type Manifest } from "../src/media/store.js";
import { RECIPE_VERSION } from "../src/media/recipe.js";
import { ProjectRegistry } from "../src/projects.js";
import { tempDir } from "./helpers.js";
import { makeClip } from "./media-fixtures.js";
import { testBinaryManager } from "./media-tools.js";

/** A fake ffprobe that prints one video stream with the given fields. */
function fakeFfprobe(stream: Record<string, unknown>, formatName: string): string {
  const dir = tempDir();
  const json = join(dir, "out.json");
  writeFileSync(
    json,
    JSON.stringify({
      streams: [{ codec_type: "video", width: 64, height: 64, ...stream }],
      format: { format_name: formatName, duration: "1" },
    }),
  );
  const script = join(dir, "ffprobe");
  writeFileSync(script, `#!/bin/sh\ncat '${json}'\n`);
  chmodSync(script, 0o755);
  return script;
}

// The fake ffprobe is a shell script, which Windows cannot spawn; the parsing it checks is the same on every OS.
describe.skipIf(process.platform === "win32")("alpha detection by pixel format", () => {
  it.each([
    ["ProRes 4444", { codec_name: "prores", pix_fmt: "yuva444p10le" }, "mov,mp4,m4a,3gp,3g2,mj2", true],
    ["QuickTime Animation", { codec_name: "qtrle", pix_fmt: "argb" }, "mov,mp4,m4a,3gp,3g2,mj2", true],
    ["opaque H.264", { codec_name: "h264", pix_fmt: "yuv420p" }, "mov,mp4,m4a,3gp,3g2,mj2", false],
    ["palette PNG still", { codec_name: "png", pix_fmt: "pal8" }, "png_pipe", true],
    ["RGBA PNG still", { codec_name: "png", pix_fmt: "rgba" }, "png_pipe", true],
    ["RGB PNG still", { codec_name: "png", pix_fmt: "rgb24" }, "png_pipe", false],
  ])("%s", async (_name, stream, format, alpha) => {
    const { media } = await probeSource(fakeFfprobe(stream, format), "ignored");
    expect(media.video?.alpha).toBe(alpha);
  });

  it("builds no alpha proxy for a still", async () => {
    const probe = await probeSource(fakeFfprobe({ codec_name: "png", pix_fmt: "pal8" }, "png_pipe"), "ignored");
    expect(probe.alpha).toBeNull();
  });

  it("asks the default decoder to keep alpha of a ProRes 4444 clip", async () => {
    const probe = await probeSource(fakeFfprobe({ codec_name: "prores", pix_fmt: "yuva444p10le" }, "mov,mp4"), "ignored");
    expect(probe.alpha).toEqual({ decoder: null });
  });
});

describe("MediaService.probe of an old manifest", () => {
  const services: MediaService[] = [];
  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.close()));
  });

  async function setup(video: Record<string, unknown>) {
    const root = tempDir();
    await new ProjectRegistry().init(root);
    mkdirSync(join(root, "assets"), { recursive: true });
    await makeClip(join(root, "assets", "a.mp4"));
    const media = new MediaService({ binaries: testBinaryManager(), jobs: new JobQueue(), watch: false });
    services.push(media);
    const store = new MediaStore(root);
    const hash = await media.hash(root, "assets/a.mp4");
    const manifest = {
      version: 1,
      recipe: RECIPE_VERSION,
      fps: 30,
      hash,
      media: { duration: 1, format: "cached", video, audio: null },
      proxy: null,
      sidecar: null,
      waveform: null,
      thumbnails: null,
    } as unknown as Manifest;
    await store.writeManifest(store.key(hash, 30), manifest);
    return { root, media };
  }

  const oldVideo = { codec: "h264", width: 1, height: 1, fps: 30, vfr: false, still: false };

  it("probes again when the manifest has no alpha fact", async () => {
    const { root, media } = await setup(oldVideo);
    const probed = await media.probe(root, "assets/a.mp4");
    expect(probed.format).not.toBe("cached");
    expect(probed.video).toMatchObject({ width: 320, alpha: false });
  }, 120_000);

  it("answers from a manifest that records alpha", async () => {
    const { root, media } = await setup({ ...oldVideo, alpha: true });
    expect((await media.probe(root, "assets/a.mp4")).format).toBe("cached");
  }, 120_000);
});
