// A machine yardstick: YuNet (already pinned, 0.2 MB) on one 512x288 frame through the same loader, so a Kokoro
// time here can be scaled to a machine where YuNet's time is known (docs/binaries.md: about 20 ms on an Apple M3).
// Usage: node src/yardstick.ts   (needs the YuNet model in FRAMESHELL_TEST_BINARIES_DIR, installed by face tests)
import { join } from "node:path";
import { ORT_RUNTIME, TEST_BINARIES, built } from "./paths.ts";

const { loadOnnxModel } = await built<any>("packages/core/dist/onnx-web.js");
const model = join(TEST_BINARIES, "models", "yunet-2026may", "26cc381e4d25", "face_detection_yunet_2026may.onnx");
const { ort, session } = await loadOnnxModel(ORT_RUNTIME, model);
const frame = new Float32Array(3 * 288 * 512).map(() => Math.random() * 255);
const feeds = { [session.inputNames[0]]: new ort.Tensor("float32", frame, [1, 3, 288, 512]) };
for (let i = 0; i < 5; i++) await session.run(feeds); // warm-up
const wall: number[] = [];
const cpu: number[] = [];
for (let i = 0; i < 40; i++) {
  const started = performance.now();
  const before = process.threadCpuUsage();
  await session.run(feeds);
  const used = process.threadCpuUsage(before);
  wall.push(performance.now() - started);
  cpu.push((used.user + used.system) / 1000);
}
const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
console.log(JSON.stringify({ yunetMs: +median(wall).toFixed(1), yunetCpuMs: +median(cpu).toFixed(1), fastestMs: +Math.min(...wall).toFixed(1) }));
