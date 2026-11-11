// Stand-in for the Blender executable (the real one is not installed in CI): copied next to a `config.json`
// into a temp dir and run by the adapter as `binaries.blender` through a `blender` shell wrapper. It answers `--version`, and for
// `-P deps.py` / `-P render.py` does what the shipped scripts do, from a "blend" file that is `BLENDER` plus a JSON
// model of the scene. Every invocation is appended to `calls.jsonl`.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(here, "config.json"), "utf8"));
const argv = process.argv.slice(2);
appendFileSync(join(here, "calls.jsonl"), `${JSON.stringify({ argv })}\n`);

if (argv.includes("--version")) {
  writeSync(1, `Blender ${config.version ?? "4.5.3"} LTS\n\tbuild date: stub\n`);
  process.exit(0);
}

const after = (flag) => argv[argv.indexOf(flag) + 1];
const blend = after("-Y");
const script = basename(after("-P"));
const request = JSON.parse(argv[argv.indexOf("--") + 1]);
const model = JSON.parse(readFileSync(blend, "latin1").slice("BLENDER".length));

// Synchronous writes: nothing is lost when the process exits right after.
const print = (text) => writeSync(1, `${text}\n`);
const emit = (event) => print(`FRAMESHELL ${JSON.stringify(event)}`);
const refuse = (code, detail) => {
  emit({ event: "error", code, ...detail });
  process.exit(2);
};

if (script === "deps.py") {
  const paths = (model.links ?? []).map((link) => (link.startsWith("//") ? join(dirname(blend), link.slice(2)) : link));
  writeFileSync(request.out, JSON.stringify({ paths }));
  process.exit(0);
}

// render.py: the same refusals, in the same order, as python/render.py.
const scenes = model.scenes ?? ["Scene"];
if (request.scene !== null && !scenes.includes(request.scene)) refuse("scene", { scene: request.scene, scenes });
const fps = model.fps ?? 24;
if (Math.abs(fps - request.fps) > 0.001) refuse("fps", { scene: request.scene ?? scenes[0], sceneFps: fps, projectFps: request.fps });
const cameras = model.cameras ?? ["Camera"];
if (request.camera !== null && !cameras.includes(request.camera)) refuse("camera", { camera: request.camera, cameras });
if (request.camera === null && cameras.length === 0) refuse("camera", { camera: null, scene: scenes[0], cameras });
const first = model.frameStart ?? 1;
if (first + request.frames - 1 > (model.frameEnd ?? 250)) refuse("range", { scene: scenes[0], frameStart: first, frameEnd: model.frameEnd ?? 250, frames: request.frames });

writeFileSync(join(here, "pid"), String(process.pid));
mkdirSync(request.outDir, { recursive: true });
let hung = false;
emit({ event: "start", frameStart: first, frames: request.frames, engine: "BLENDER_EEVEE_NEXT" });
for (let index = 0; index < request.frames; index++) {
  print(`Fra:${first + index} Mem:10.00M (Peak 10.00M) | Time:00:00.01 | Rendering`);
  if (config.crash && index === 1) {
    writeSync(2, 'Traceback (most recent call last):\n  File "render.py", line 1\nRuntimeError: stub crash\n');
    process.exit(1);
  }
  if (!(config.skipLast && index === request.frames - 1)) writeFileSync(join(request.outDir, `frame_${String(index).padStart(6, "0")}.png`), png(request.width, request.height));
  emit({ event: "frame", index });
  if (config.hangAfter === index + 1) {
    // Never finishes, as a long final render: only a kill ends it.
    setInterval(() => {}, 1000);
    hung = true;
    break;
  }
}
if (!hung) process.exit(0);

/** RGBA PNG: transparent, a 60 % white panel (alpha 153) over x in [w/4, w/2), an opaque red dot over x in [w*5/8, w*7/8). */
function png(width, height) {
  const rows = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 4);
    for (let x = 0; x < width; x++) {
      const at = row + 1 + x * 4;
      const middle = y >= height / 4 && y < (height * 3) / 4;
      if (middle && x >= width / 4 && x < width / 2) rows.set([255, 255, 255, 153], at);
      else if (middle && x >= (width * 5) / 8 && x < (width * 7) / 8) rows.set([255, 0, 0, 255], at);
    }
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
