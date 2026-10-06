import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alphaProxyArgs } from "@frameshell/core";
import { beforeAll, describe, expect, it } from "vitest";
import { ffmpegRun, testFfmpeg } from "../e2e/media.js";
import { openVideoSource } from "../src/renderer/src/preview/video-source.js";
import { openWebm, openWebmProxy, readWebmProxy } from "../src/renderer/src/preview/webm.js";

// Seam under test: the preview's WebM demux of cached clip renders (ADR 0002: VP9 with the alpha plane as a second VP9
// stream in BlockAdditions), against files the real managed ffmpeg encodes the way the render adapters do.

let alpha: Uint8Array;
let opaque: Uint8Array;
/** VP9-alpha proxies by the ingest recipe (#90): 3 s at 30 fps, tiny (several GOPs per Cluster) and 540p (one each). */
let tinyProxy: Uint8Array;
let bigProxy: Uint8Array;

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
  const ffmpeg = await testFfmpeg();
  const proxy = async (name: string, size: string) => {
    const source = join(dir, `${name}-source.webm`);
    await ffmpegRun(ffmpeg, [
      ...["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi"],
      ...["-i", `testsrc2=s=${size}:r=25:d=3,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(X,W/2),255,64)'`],
      ...["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", "-deadline", "realtime", "-b:v", "0", "-crf", "30", source],
    ]);
    await ffmpegRun(ffmpeg, alphaProxyArgs(source, join(dir, `${name}.webm`), 30, "libvpx-vp9"));
    return new Uint8Array(readFileSync(join(dir, `${name}.webm`)));
  };
  tinyProxy = await proxy("tiny", "64x36");
  bigProxy = await proxy("big", "960x540");
}, 120_000);

/** Ranged reader over `file`, recording each read. */
function reader(file: Uint8Array) {
  const reads: [number, number][] = [];
  const read = async (start: number, end: number) => {
    reads.push([start, end]);
    return file.slice(start, Math.min(end, file.length));
  };
  return { read, reads };
}

describe("openWebm", () => {
  it("lists every frame of a VP9-alpha render in display order, each with its alpha frame, and a VP9 decoder config", () => {
    const render = openWebm(alpha);
    // Untagged, like the adapters' renders: read as BT.601 limited range, as export's ffmpeg does.
    expect(render.config).toEqual({
      codec: "vp09.00.10.08",
      codedWidth: 64,
      codedHeight: 36,
      colorSpace: { matrix: "smpte170m", primaries: "bt709", transfer: "bt709", fullRange: false },
    });
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

describe("openVideoSource", () => {
  it("reads a .webm render whole, never by ranges, and serves its pictures clamped to the render", async () => {
    let whole = 0;
    const source = await openVideoSource(
      "assets/../.frameshell/cache/clips/k.WEBM",
      () => Promise.reject(new Error("a render is never read by ranges")),
      async () => {
        whole++;
        return alpha;
      },
    );
    expect(whole).toBe(1);
    expect(source.hasAlpha).toBe(true);
    expect(source.config.codec).toBe("vp09.00.10.08");
    const pictures = await source.read(58, 70);
    expect(pictures).toHaveLength(2);
    expect(pictures[0]!.alpha).not.toBeNull();
    expect(await source.read(-5, 1)).toHaveLength(1);
  });

  it("reads a .webm proxy (#90) by ranges, never whole, with its alpha", async () => {
    const source = await openVideoSource(".frameshell/proxies/k.webm", reader(bigProxy).read, () =>
      Promise.reject(new Error("a proxy is never read whole")),
    );
    expect(source.hasAlpha).toBe(true);
    const pictures = await source.read(88, 95);
    expect(pictures).toHaveLength(2);
    expect(pictures[0]!.alpha).not.toBeNull();
  });
});

describe("openWebmProxy", () => {
  for (const [name, file] of [
    ["several GOPs per Cluster", () => tinyProxy],
    ["one GOP per Cluster", () => bigProxy],
  ] as const) {
    it(`indexes a VP9-alpha proxy from its head and Cues, and reads any frame run by one range (${name})`, async () => {
      const bytes = file();
      const whole = openWebm(bytes);
      const { read, reads } = reader(bytes);
      const proxy = await openWebmProxy(read);
      expect(proxy.hasAlpha).toBe(true);
      // Tagged by the recipe: BT.709 limited, unlike untagged renders.
      expect(proxy.config).toMatchObject({ codec: "vp09.00.10.08", colorSpace: { matrix: "bt709", fullRange: false } });
      expect(proxy.config).toEqual(whole.config);
      expect(proxy.table.count).toBe(90);
      expect([...Array(90).keys()].filter((i) => proxy.table.isSync(i))).toEqual([0, 15, 30, 45, 60, 75]);
      // Head (64 KiB), Cues header and body, first GOP: not the whole file, once it is larger than the head.
      expect(reads.length).toBeLessThanOrEqual(4);
      if (bytes.length > 256 << 10) expect(reads.reduce((sum, [s, e]) => sum + Math.min(e, bytes.length) - s, 0)).toBeLessThan(bytes.length / 2);

      for (const [from, to] of [
        [0, 30],
        [20, 50],
        [44, 46],
        [75, 90],
        [80, 200],
      ] as const) {
        reads.length = 0;
        const frames = await readWebmProxy(proxy, from, to, read);
        expect(reads).toHaveLength(1);
        const expected = whole.frames.slice(from, Math.min(to, 90));
        expect(frames.map((f) => [f.key, f.alpha?.key, f.data.length, f.alpha?.data.length])).toEqual(
          expected.map((f) => [f.key, f.alpha?.key, f.data.length, f.alpha?.data.length]),
        );
        expect(frames.every((f, i) => Buffer.from(f.data).equals(Buffer.from(expected[i]!.data)))).toBe(true);
      }
    });
  }

  it("fails clearly on a WebM without Cues", async () => {
    await expect(openWebmProxy(reader(alpha.slice(0, 200)).read)).rejects.toThrow(/Proxy/);
    await expect(openWebmProxy(reader(new Uint8Array([0, 1, 2, 3])).read)).rejects.toThrow(/Not a WebM file/);
  });
});
