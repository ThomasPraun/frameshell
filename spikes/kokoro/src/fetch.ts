// Downloads the pinned Kokoro files (and the misaki English dictionary) into WORK_DIR/downloads, hash-checked.
// Usage: node src/fetch.ts [fp32|int8|q8f16|fp16 ...]   (default: int8 q8f16 fp32)
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DOWNLOADS } from "./paths.ts";
import { MODELS, type Pinned, SMALL, VOICES, hf, local } from "./pins.ts";

async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function fetchPinned(pin: Pinned): Promise<void> {
  const target = local(pin.file);
  if (existsSync(target) && (await stat(target)).size === pin.bytes) {
    if (pin.sha256 === null || (await sha256Of(target)) === pin.sha256) return;
  }
  await mkdir(dirname(target), { recursive: true });
  const started = performance.now();
  const response = await fetch(pin.url);
  if (!response.ok) throw new Error(`${pin.url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== pin.bytes) throw new Error(`${pin.file}: ${bytes.length} bytes, expected ${pin.bytes}`);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (pin.sha256 !== null && digest !== pin.sha256) throw new Error(`${pin.file}: sha256 ${digest}, expected ${pin.sha256}`);
  await writeFile(`${target}.part`, bytes);
  await rm(target, { force: true });
  await rename(`${target}.part`, target);
  const seconds = (performance.now() - started) / 1000;
  console.log(`${pin.file}  ${bytes.length} B  sha256 ${digest}  ${seconds.toFixed(1)} s`);
}

const wanted = process.argv.slice(2);
const variants = wanted.length > 0 ? wanted : ["int8", "q8f16", "fp32"];
for (const pin of SMALL) await fetchPinned(pin);
for (const [voice, sha256] of Object.entries(VOICES)) {
  await fetchPinned({ file: `voices/${voice}.bin`, url: hf(`voices/${voice}.bin`), bytes: 522_240, sha256 });
}
for (const variant of variants) {
  const pin = MODELS[variant];
  if (!pin) throw new Error(`Unknown variant ${variant}: ${Object.keys(MODELS).join(", ")}`);
  await fetchPinned(pin);
}
console.log(`ok: ${DOWNLOADS}`);
