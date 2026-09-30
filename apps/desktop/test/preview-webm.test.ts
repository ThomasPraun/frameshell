import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ffmpegRun, testFfmpeg } from "../e2e/media.js";
import { openWebm } from "../src/renderer/src/preview/webm.js";

// Seam under test: the preview's WebM demux of cached clip renders (ADR 0002: VP9 with the alpha plane as a second VP9
// stream in BlockAdditions), against files the real managed ffmpeg encodes the way the render adapters do.

let alpha: Uint8Array;
let opaque: Uint8Array;

async function encode(dir: string, name: string, pixFmt: string, source: string): Promise<Uint8Array> {
  const out = join(dir, name);
  await ffmpegRun(await testFfmpeg(), [
    ...["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", source],
    ...["-c:v", "libvpx-vp9", "-pix_fmt", pixFmt, "-g", "15", "-auto-alt-ref", "0", "-deadline", "realtime", "-b:v", "0", "-crf", "30", out],
  ]);
  return new Uint8Array(readFileSync(out));
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "frameshell-webm-"));
  alpha = await encode(dir, "alpha.webm", "yuva420p", "color=c=red@0.5:s=64x36:r=30:d=2,format=rgba");
  opaque = await encode(dir, "opaque.webm", "yuv420p", "testsrc2=s=64x36:r=30:d=2");
}, 120_000);

describe("openWebm", () => {
  it("lists every frame of a VP9-alpha render in display order, each with its alpha frame, and a VP9 decoder config", () => {
    const render = openWebm(alpha);
    expect(render.config).toEqual({ codec: "vp09.00.10.08", codedWidth: 64, codedHeight: 36 });
    expect(render.hasAlpha).toBe(true);
    expect(render.frames).toHaveLength(60);
    expect(render.table.count).toBe(60);
    // A frame is a decode start only where colour and alpha are both keyframes.
    expect([...Array(60).keys()].filter((i) => render.table.isSync(i))).toEqual([0, 15, 30, 45]);
    for (const frame of render.frames) {
      expect(frame.data.length).toBeGreaterThan(0);
      expect(frame.alpha?.data.length).toBeGreaterThan(0);
    }
    expect(render.frames.filter((f) => f.key).length).toBe(4);
    expect(render.frames[15]).toMatchObject({ key: true, alpha: { key: true } });
    expect(render.frames[16]).toMatchObject({ key: false, alpha: { key: false } });
  });

  it("reads an opaque render as colour only", () => {
    const render = openWebm(opaque);
    expect(render.hasAlpha).toBe(false);
    expect(render.frames).toHaveLength(60);
    expect(render.frames.every((frame) => frame.alpha === null)).toBe(true);
    expect(render.table.isSync(0)).toBe(true);
  });

  it("fails clearly on bytes that are not WebM", () => {
    expect(() => openWebm(new Uint8Array([0, 1, 2, 3]))).toThrow(/not a WebM file/);
    expect(() => openWebm(alpha.subarray(0, 40))).toThrow(/no video frames/);
  });
});
