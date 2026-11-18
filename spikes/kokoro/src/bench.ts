// Speed runs, one fresh process per variant and mode (so every load is cold), one after another (never in
// parallel: they would share the CPU). Writes results/speed-<host>.json. Usage: node src/bench.ts [variant ...]
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { cpus, hostname, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import { SPIKE_ROOT } from "./paths.ts";

const variants = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["int8", "q8f16", "fp32"];
const modes = (process.env.KOKORO_MODES ?? "main,worker").split(",");
const runs = [];
for (const variant of variants) {
  for (const mode of modes) {
    const out = execFileSync(process.execPath, [join(SPIKE_ROOT, "src", "bench-one.ts"), variant, mode], { encoding: "utf8", maxBuffer: 1 << 24 });
    const run = JSON.parse(out.trim().split("\n").at(-1)!);
    runs.push(run);
    console.log(`${variant} ${mode}: load ${run.loadMs} ms, peak RSS ${run.peakRssMb} MB`);
    for (const line of run.lines) console.log(`  ${line.id}: ${line.audioS} s audio, ${line.ms} ms (RTF ${line.rtf}), cpu RTF ${line.cpuRtf}, ${line.chunks} run(s)`);
  }
}
const machine = { cpu: cpus()[0]?.model, logicalCpus: cpus().length, memGb: Math.round(totalmem() / 2 ** 30), os: `${platform()} ${release()}`, node: process.version };
await mkdir(join(SPIKE_ROOT, "results"), { recursive: true });
const name = (process.env.KOKORO_HOST ?? hostname()).replace(/[^\w-]/g, "_");
await writeFile(join(SPIKE_ROOT, "results", `speed-${name}.json`), `${JSON.stringify({ machine, runs }, null, 2)}\n`);
