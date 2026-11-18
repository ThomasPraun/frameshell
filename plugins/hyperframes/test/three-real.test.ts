import { execFile } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { crc32, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { BinaryManager, ClipVerifier } from "@frameshell/core";
import { createHyperframesAdapter, newComposition } from "../src/index.js";

// Opt-in like render-real (FRAMESHELL_TEST_REAL_HYPERFRAMES=1): the 3D product-shot template (ADR 0042) with a GLB model
// and a texture, on SwiftShader in managed Chrome. templates-real covers its layout per format and the plain render.
const execFileAsync = promisify(execFile);
const tempDir = () => realpathSync(mkdtempSync(join(tmpdir(), "frameshell-three-real-")));
const binaries = () => {
  const dir = process.env["FRAMESHELL_TEST_BINARIES_DIR"] || fileURLToPath(new URL("../../../.cache/test-binaries", import.meta.url));
  return new BinaryManager({ dataDir: dir, configDir: dir });
};

const [WIDTH, HEIGHT, DURATION] = [320, 180, 1.5];
const clip = { id: "c_shot", source: "compositions/hyperframes/shot/index.html" };

/** An RGBA PNG of `size` x `size` painted by `pixel(x, y)`. */
function png(size: number, pixel: (x: number, y: number) => [number, number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])) >>> 0, 8 + data.length);
    return out;
  };
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) raw.set(pixel(x, y), y * (size * 4 + 1) + 1 + x * 4);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** A plain GLB: one red box twice as wide as it is tall, so the template's fit to the product size shows. */
function glb(): Buffer {
  const faces = [
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
  ] as const;
  const half = [1, 0.5, 0.5];
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (const [i, [n, u, v]] of faces.entries()) {
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      positions.push(...[0, 1, 2].map((k) => (n[k]! + u[k]! * su + v[k]! * sv) * half[k]!));
      normals.push(...n);
    }
    indices.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
  }
  const parts = [Buffer.from(new Float32Array(positions).buffer), Buffer.from(new Float32Array(normals).buffer), Buffer.from(new Uint16Array(indices).buffer)];
  const bin = Buffer.concat(parts);
  const offsets = [0, parts[0]!.length, parts[0]!.length + parts[1]!.length];
  const json = JSON.stringify({
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.9, 0.05, 0.05, 1], metallicFactor: 0, roughnessFactor: 0.5 } }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 24, type: "VEC3", min: [-1, -0.5, -0.5], max: [1, 0.5, 0.5] },
      { bufferView: 1, componentType: 5126, count: 24, type: "VEC3" },
      { bufferView: 2, componentType: 5123, count: 36, type: "SCALAR" },
    ],
    bufferViews: parts.map((part, i) => ({ buffer: 0, byteOffset: offsets[i], byteLength: part.length })),
    buffers: [{ byteLength: bin.length }],
  });
  const text = Buffer.from(json + " ".repeat((4 - (json.length % 4)) % 4));
  const head = Buffer.alloc(12);
  head.write("glTF", 0, "ascii");
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + text.length + 8 + bin.length, 8);
  const chunkHead = (length: number, type: string) => {
    const out = Buffer.alloc(8);
    out.writeUInt32LE(length, 0);
    out.write(type, 4, "ascii");
    return out;
  };
  return Buffer.concat([head, chunkHead(text.length, "JSON"), text, chunkHead(bin.length, "BIN\0"), bin]);
}

/** A project with `template` scaffolded as `shot`, `--duration` {@link DURATION}; returns the project and composition directories. */
async function scaffold(template: string): Promise<{ dir: string; composition: string }> {
  const dir = tempDir();
  writeFileSync(join(dir, "frameshell.json"), JSON.stringify({ resolution: { width: WIDTH, height: HEIGHT } }));
  await newComposition.run({ args: ["shot", "--template", template, "--duration", String(DURATION)], cwd: dir, project: { dir } });
  return { dir, composition: join(dir, "compositions", "hyperframes", "shot") };
}

/** A project with the product-shot template scaffolded as `shot`, with a GLB and a texture beside it. */
async function project(): Promise<string> {
  const { dir, composition } = await scaffold("product-shot");
  writeFileSync(join(composition, "product.glb"), glb());
  writeFileSync(join(composition, "label.png"), png(64, (x, y) => (((x >> 3) + (y >> 3)) % 2 === 0 ? [20, 200, 60, 255] : [240, 240, 240, 255])));
  return dir;
}

/** `clip.verify` of the clip `c_shot` carrying `props` over 12 probes, cold vs reseek. */
async function verify(dir: string, props: Record<string, unknown>, tolerance: number) {
  const manager = binaries();
  const adapter = createHyperframesAdapter({ projectDir: dir });
  const timeline = { id: "main", revision: 1, tracks: [{ id: "v1", kind: "video", clips: [{ ...clip, props, type: "hyperframes", start: 0, in: 0, duration: DURATION }] }] };
  const verifier = new ClipVerifier({
    timeline: async () => ({ timeline: timeline as never, fps: 30 }),
    live: async (_root, _timeline, id) => ({
      ...(await adapter.livePreview!({ ...clip, props }, { projectDir: dir, fps: 30, width: WIDTH, height: HEIGHT, ensureBinary: (name) => manager.ensure(name) })),
      clip: id,
      key: "k",
    }),
    resolution: async () => ({ width: WIDTH, height: HEIGHT }),
    chrome: () => manager.ensure("chrome-headless-shell"),
    ffmpeg: () => manager.ensure("ffmpeg"),
  });
  return verifier.verify(dir, { timeline: "main", clip: "c_shot", tolerance });
}

describe.runIf(process.env["FRAMESHELL_TEST_REAL_HYPERFRAMES"] === "1")("3D product shot (real HyperFrames, SwiftShader)", () => {
  it(
    "renders a GLB model loaded before frame 0, with alpha, and passes clip verify (cold vs reseek identical)",
    async () => {
      const dir = await project();
      const manager = binaries();
      const ffmpeg = await manager.ensure("ffmpeg");
      const props = { model: "product.glb", title: "", backdrop: 0 };
      const adapter = createHyperframesAdapter({ projectDir: dir });
      const rendered = await adapter.render(
        { ...clip, props },
        {
          projectDir: dir,
          outDir: tempDir(),
          fps: 30,
          width: WIDTH,
          height: HEIGHT,
          signal: new AbortController().signal,
          ensureBinary: (name) => manager.ensure(name),
          progress: () => {},
        },
      );
      // The first frame already shows the model: the render waited for __hf.buildReady, not for the clock.
      for (const at of [0.05, 1]) {
        const { stdout } = await execFileAsync(
          ffmpeg,
          ["-v", "error", "-c:v", "libvpx-vp9", "-ss", String(at), "-i", rendered.file, "-frames:v", "1", "-vf", "format=rgba", "-f", "rawvideo", "-"],
          { encoding: "buffer", maxBuffer: 1 << 26 },
        );
        let [red, clear] = [0, 0];
        for (let p = 0; p < stdout.length; p += 4) {
          if (stdout[p + 3]! < 16) clear++;
          else if (stdout[p + 3]! > 200 && stdout[p]! > 90 && stdout[p]! > 2 * stdout[p + 1]! && stdout[p]! > 2 * stdout[p + 2]!) red++;
        }
        expect(red, `red model pixels at ${at} s`).toBeGreaterThan(WIDTH * HEIGHT * 0.01);
        expect(clear, `transparent pixels at ${at} s`).toBeGreaterThan(WIDTH * HEIGHT * 0.5);
      }

      const result = await verify(dir, props, 0);
      expect(result).toMatchObject({ ok: true, worst: null, warnings: [] });
      expect(result.probes).toHaveLength(12);
      expect(result.distinct).toBeGreaterThan(8);
    },
    600_000,
  );

  it(
    "paints the label texture on the built-in box, and fails the render with the path of a model that is missing",
    async () => {
      const dir = await project();
      const manager = binaries();
      const ffmpeg = await manager.ensure("ffmpeg");
      const adapter = createHyperframesAdapter({ projectDir: dir });
      const ctx = () => ({
        projectDir: dir,
        outDir: tempDir(),
        fps: 30,
        width: WIDTH,
        height: HEIGHT,
        signal: new AbortController().signal,
        ensureBinary: (name: string) => manager.ensure(name),
        progress: () => {},
      });
      const labelled = await adapter.render({ ...clip, props: { label: "label.png", title: "" } }, ctx());
      const { stdout } = await execFileAsync(
        ffmpeg,
        ["-v", "error", "-c:v", "libvpx-vp9", "-ss", "0.05", "-i", labelled.file, "-frames:v", "1", "-vf", "format=rgba", "-f", "rawvideo", "-"],
        { encoding: "buffer", maxBuffer: 1 << 26 },
      );
      let green = 0;
      for (let p = 0; p < stdout.length; p += 4) if (stdout[p + 3]! > 200 && stdout[p + 1]! > 1.5 * stdout[p]! && stdout[p + 1]! > 1.5 * stdout[p + 2]!) green++;
      expect(green, "green label pixels on the first frame").toBeGreaterThan(WIDTH * HEIGHT * 0.002);

      await expect(adapter.render({ ...clip, props: { model: "missing.glb" } }, ctx())).rejects.toThrow(/missing\.glb/);
    },
    600_000,
  );
});

// The 3D logo template (ADR 0042): a generated SVG of a red disc and a blue frame (a hole in it), extruded on SwiftShader.
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100">
  <circle cx="50" cy="50" r="40" fill="#e11d48"/>
  <path fill="#0ea5e9" fill-rule="evenodd" d="M110 10h80v80h-80z M130 30v40h40v-40z"/>
</svg>`;

describe.runIf(process.env["FRAMESHELL_TEST_REAL_HYPERFRAMES"] === "1")("3D logo (real HyperFrames, SwiftShader)", () => {
  const ctx = (dir: string, manager: BinaryManager) => ({
    projectDir: dir,
    outDir: tempDir(),
    fps: 30,
    width: WIDTH,
    height: HEIGHT,
    signal: new AbortController().signal,
    ensureBinary: (name: string) => manager.ensure(name),
    progress: () => {},
  });

  it(
    "extrudes the SVG's own fills before frame 0, keeps alpha, and passes clip verify (cold vs reseek identical)",
    async () => {
      const { dir, composition } = await scaffold("logo-3d");
      writeFileSync(join(composition, "mark.svg"), LOGO_SVG);
      const manager = binaries();
      const ffmpeg = await manager.ensure("ffmpeg");
      const props = { logo: "mark.svg", colors: "svg", title: "", backdrop: 0 };
      const rendered = await createHyperframesAdapter({ projectDir: dir }).render({ ...clip, props }, ctx(dir, manager));
      // The first frame already shows the flat logo (the render waited for __hf.buildReady); at 1 s both fills are there.
      for (const at of [0.05, 1]) {
        const { stdout } = await execFileAsync(
          ffmpeg,
          ["-v", "error", "-c:v", "libvpx-vp9", "-ss", String(at), "-i", rendered.file, "-frames:v", "1", "-vf", "format=rgba", "-f", "rawvideo", "-"],
          { encoding: "buffer", maxBuffer: 1 << 26 },
        );
        let [red, blue, clear] = [0, 0, 0];
        for (let p = 0; p < stdout.length; p += 4) {
          const [r, g, b, a] = [stdout[p]!, stdout[p + 1]!, stdout[p + 2]!, stdout[p + 3]!];
          if (a < 16) clear++;
          else if (a > 200 && r > 90 && r > 2 * g && r > 1.4 * b) red++;
          else if (a > 200 && b > 90 && b > 1.3 * r && b > 1.15 * g) blue++;
        }
        expect(red, `red logo pixels at ${at} s`).toBeGreaterThan(WIDTH * HEIGHT * 0.004);
        expect(blue, `blue logo pixels at ${at} s`).toBeGreaterThan(WIDTH * HEIGHT * 0.004);
        expect(clear, `transparent pixels at ${at} s`).toBeGreaterThan(WIDTH * HEIGHT * 0.5);
      }
      const result = await verify(dir, props, 0);
      expect(result).toMatchObject({ ok: true, worst: null, warnings: [] });
      expect(result.probes).toHaveLength(12);
      expect(result.distinct).toBeGreaterThan(8);
    },
    600_000,
  );

  it(
    "extrudes the built-in mark with no logo set, in every reveal",
    async () => {
      const { dir } = await scaffold("logo-3d");
      const manager = binaries();
      const ffmpeg = await manager.ensure("ffmpeg");
      for (const reveal of ["rise", "turn", "drop"]) {
        const rendered = await createHyperframesAdapter({ projectDir: dir }).render({ ...clip, props: { reveal, title: "", backdrop: 0 } }, ctx(dir, manager));
        const { stdout } = await execFileAsync(
          ffmpeg,
          ["-v", "error", "-c:v", "libvpx-vp9", "-ss", "1.2", "-i", rendered.file, "-frames:v", "1", "-vf", "format=rgba", "-f", "rawvideo", "-"],
          { encoding: "buffer", maxBuffer: 1 << 26 },
        );
        let opaque = 0;
        for (let p = 3; p < stdout.length; p += 4) if (stdout[p]! > 200) opaque++;
        expect(opaque, `${reveal}: logo pixels at 1.2 s`).toBeGreaterThan(WIDTH * HEIGHT * 0.02);
      }
    },
    600_000,
  );

  it(
    "fails the render naming the file for a missing SVG, a raster and an SVG with nothing filled",
    async () => {
      const { dir, composition } = await scaffold("logo-3d");
      writeFileSync(join(composition, "lines.svg"), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 10L90 90" stroke="#000" stroke-width="8" fill="none"/></svg>`);
      writeFileSync(join(composition, "logo.png"), png(8, () => [0, 0, 0, 255]));
      const manager = binaries();
      const adapter = createHyperframesAdapter({ projectDir: dir });
      await expect(adapter.render({ ...clip, props: { logo: "missing.svg" } }, ctx(dir, manager))).rejects.toThrow(/missing\.svg/);
      await expect(adapter.render({ ...clip, props: { logo: "logo.png" } }, ctx(dir, manager))).rejects.toThrow(/logo\.png/);
      await expect(adapter.render({ ...clip, props: { logo: "lines.svg" } }, ctx(dir, manager))).rejects.toThrow(/lines\.svg has no filled paths/);
    },
    600_000,
  );
});

// The 3D title template (ADR 0042): extruded Archivo Black letters from the shipped typeface JSON, on SwiftShader.
describe.runIf(process.env["FRAMESHELL_TEST_REAL_HYPERFRAMES"] === "1")("3D title (real HyperFrames, SwiftShader)", () => {
  const ctx = (dir: string, manager: BinaryManager) => ({
    projectDir: dir,
    outDir: tempDir(),
    fps: 30,
    width: WIDTH,
    height: HEIGHT,
    signal: new AbortController().signal,
    ensureBinary: (name: string) => manager.ensure(name),
    progress: () => {},
  });
  /** RGBA pixels of the frame at `at` seconds of `file`. */
  const frameAt = async (ffmpeg: string, file: string, at: number) =>
    (
      await execFileAsync(ffmpeg, ["-v", "error", "-c:v", "libvpx-vp9", "-ss", String(at), "-i", file, "-frames:v", "1", "-vf", "format=rgba", "-f", "rawvideo", "-"], {
        encoding: "buffer",
        maxBuffer: 1 << 26,
      })
    ).stdout;
  const count = (pixels: Buffer, test: (r: number, g: number, b: number, a: number) => boolean) => {
    let n = 0;
    for (let p = 0; p < pixels.length; p += 4) if (test(pixels[p]!, pixels[p + 1]!, pixels[p + 2]!, pixels[p + 3]!)) n++;
    return n;
  };
  const red = (r: number, g: number, b: number, a: number) => a > 200 && r > 90 && r > 2 * g && r > 1.4 * b;
  const blue = (r: number, g: number, b: number, a: number) => a > 200 && b > 90 && b > 1.3 * r && b > 1.15 * g;
  const opaque = (_r: number, _g: number, _b: number, a: number) => a > 200;

  it(
    "paints the letters from the first frame when the depth rises, keeps alpha, and passes clip verify (cold vs reseek identical) with letter by letter arrival",
    async () => {
      const { dir } = await scaffold("title-3d");
      const manager = binaries();
      const ffmpeg = await manager.ensure("ffmpeg");
      const props = { text: "HELLO", color: "#e11d48", reveal: "rise", subtitle: "", backdrop: 0 };
      const rendered = await createHyperframesAdapter({ projectDir: dir }).render({ ...clip, props }, ctx(dir, manager));
      // The first frame already shows the flat letters: the render waited for __hf.buildReady (the typeface), not for the clock.
      for (const at of [0.05, 1]) {
        const pixels = await frameAt(ffmpeg, rendered.file, at);
        expect(count(pixels, red), `red letter pixels at ${at} s`).toBeGreaterThan(WIDTH * HEIGHT * 0.01);
        expect(count(pixels, (_r, _g, _b, a) => a < 16), `transparent pixels at ${at} s`).toBeGreaterThan(WIDTH * HEIGHT * 0.4);
      }
      const result = await verify(dir, { ...props, reveal: "letters" }, 0);
      expect(result).toMatchObject({ ok: true, worst: null, warnings: [] });
      expect(result.probes).toHaveLength(12);
      expect(result.distinct).toBeGreaterThan(8);
    },
    600_000,
  );

  it(
    "paints a title in every reveal, wraps a long one into lines, and blends two colours across the letters",
    async () => {
      const { dir } = await scaffold("title-3d");
      const manager = binaries();
      const ffmpeg = await manager.ensure("ffmpeg");
      const adapter = createHyperframesAdapter({ projectDir: dir });
      for (const reveal of ["letters", "rise", "drop"]) {
        const rendered = await adapter.render({ ...clip, props: { reveal, text: "Hi\nthere", color: "#e11d48", subtitle: "", backdrop: 0 } }, ctx(dir, manager));
        expect(count(await frameAt(ffmpeg, rendered.file, 1.2), opaque), `${reveal}: letter pixels at 1.2 s`).toBeGreaterThan(WIDTH * HEIGHT * 0.03);
      }
      const long = await adapter.render({ ...clip, props: { reveal: "rise", text: "A very long title that has to wrap over lines", subtitle: "", backdrop: 0 } }, ctx(dir, manager));
      expect(count(await frameAt(ffmpeg, long.file, 1.2), opaque), "wrapped title pixels").toBeGreaterThan(WIDTH * HEIGHT * 0.03);
      const blended = await adapter.render({ ...clip, props: { reveal: "rise", text: "HHHHHH", colors: "blend", color: "#e11d48", color2: "#0ea5e9", finish: "matte", subtitle: "", backdrop: 0 } }, ctx(dir, manager));
      const pixels = await frameAt(ffmpeg, blended.file, 1.2);
      expect(count(pixels, red), "red letters of the blend").toBeGreaterThan(WIDTH * HEIGHT * 0.002);
      expect(count(pixels, blue), "blue letters of the blend").toBeGreaterThan(WIDTH * HEIGHT * 0.002);
    },
    600_000,
  );

  it(
    "fails the render naming the cause for a character the typeface lacks, too many lines, a broken typeface and a missing one",
    async () => {
      const { dir, composition } = await scaffold("title-3d");
      const manager = binaries();
      const adapter = createHyperframesAdapter({ projectDir: dir });
      await expect(adapter.render({ ...clip, props: { text: "Hi 日" } }, ctx(dir, manager))).rejects.toThrow(/no glyph for .* \(U\+65E5\)/);
      await expect(adapter.render({ ...clip, props: { text: "a\nb\nc\nd" } }, ctx(dir, manager))).rejects.toThrow(/at most 3 lines/);
      const typeface = join(composition, "frameshell-title.typeface.json");
      writeFileSync(typeface, "{ not json");
      await expect(adapter.render({ ...clip, props: { text: "Hi" } }, ctx(dir, manager))).rejects.toThrow(/frameshell-title\.typeface\.json is not valid JSON/);
      rmSync(typeface);
      await expect(adapter.render({ ...clip, props: { text: "Hi" } }, ctx(dir, manager))).rejects.toThrow(/frameshell-title\.typeface\.json/);
    },
    600_000,
  );
});
