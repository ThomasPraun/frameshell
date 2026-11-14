// Generates the two loader fixtures: a 256x256 checker PNG (TextureLoader) and a small GLB with an embedded PNG (GLTFLoader).
// Hand-written so the spike has no model files to commit. Usage: imported by setup.mjs.
import { deflateSync, crc32 } from "node:zlib";

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])) >>> 0, 8 + data.length);
  return out;
}

/** RGBA PNG of `size` x `size` from a `(x, y) => [r, g, b, a]` function. */
export function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw.set([r, g, b, a], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

export const checker = () =>
  png(256, (x, y) => {
    const on = ((x >> 5) + (y >> 5)) % 2 === 0;
    return on ? [236, 236, 236, 255] : [150, 160, 175, 255];
  });

/** A unit cube-ish box (24 vertices) with a warm base-colour texture embedded in the GLB. */
export function glb() {
  const faces = [
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
    { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
    { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
    { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  ];
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const h = 0.5;
  for (const [i, f] of faces.entries()) {
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      positions.push(...[0, 1, 2].map((k) => f.n[k] * h + f.u[k] * su * h + f.v[k] * sv * h));
      normals.push(...f.n);
      uvs.push((su + 1) / 2, 1 - (sv + 1) / 2);
    }
    indices.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
  }
  const image = png(64, (x, y) => [200 + ((x * 3) % 40), 90 + ((y * 2) % 50), 60, 255]);
  const pad = (b) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
  const parts = [
    Buffer.from(new Float32Array(positions).buffer),
    Buffer.from(new Float32Array(normals).buffer),
    Buffer.from(new Float32Array(uvs).buffer),
    pad(Buffer.from(new Uint16Array(indices).buffer)),
    pad(image),
  ];
  const offsets = [];
  let at = 0;
  for (const p of parts) {
    offsets.push(at);
    at += p.length;
  }
  const bin = Buffer.concat(parts);
  const json = {
    asset: { version: "2.0", generator: "spike fixtures" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: "crate" }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0.2, roughnessFactor: 0.45 } }],
    textures: [{ source: 0, sampler: 0 }],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
    images: [{ bufferView: 4, mimeType: "image/png" }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 24, type: "VEC3", min: [-h, -h, -h], max: [h, h, h] },
      { bufferView: 1, componentType: 5126, count: 24, type: "VEC3" },
      { bufferView: 2, componentType: 5126, count: 24, type: "VEC2" },
      { bufferView: 3, componentType: 5123, count: 36, type: "SCALAR" },
    ],
    bufferViews: parts.map((p, i) => ({ buffer: 0, byteOffset: offsets[i], byteLength: i === 3 ? indices.length * 2 : i === 4 ? image.length : p.length })),
    buffers: [{ byteLength: bin.length }],
  };
  const jsonBuf = Buffer.concat([Buffer.from(JSON.stringify(json)), Buffer.from(" ".repeat((4 - (JSON.stringify(json).length % 4)) % 4))]);
  const header = Buffer.alloc(12);
  header.write("glTF", 0, "ascii");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(jsonBuf.length, 0);
  jh.write("JSON", 4, "ascii");
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(bin.length, 0);
  bh.write("BIN\0", 4, "ascii");
  return Buffer.concat([header, jh, jsonBuf, bh, bin]);
}
