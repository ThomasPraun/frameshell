import { execFile } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
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

/** A project with the product-shot template scaffolded as `shot`, `--duration` {@link DURATION}. */
async function project(): Promise<string> {
  const dir = tempDir();
  writeFileSync(join(dir, "frameshell.json"), JSON.stringify({ resolution: { width: WIDTH, height: HEIGHT } }));
  await newComposition.run({ args: ["shot", "--template", "product-shot", "--duration", String(DURATION)], cwd: dir, project: { dir } });
  const composition = join(dir, "compositions", "hyperframes", "shot");
  writeFileSync(join(composition, "product.glb"), glb());
  writeFileSync(join(composition, "label.png"), png(64, (x, y) => (((x >> 3) + (y >> 3)) % 2 === 0 ? [20, 200, 60, 255] : [240, 240, 240, 255])));
  return dir;
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
      const result = await verifier.verify(dir, { timeline: "main", clip: "c_shot", tolerance: 0 });
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
