// PROTOTYPE, throwaway (ticket #3). Runs every render variant N times, then
// overlays each alpha output once. Prints a Markdown table for the ADR.
//
// Usage: node src/bench.mjs [runs=3]
import { execFileSync } from "node:child_process";
import { cpus, totalmem } from "node:os";

const runs = Number(process.argv[2] ?? 3);
const variants = [
  ["mov", "standard"],
  ["webm", "standard"],
  ["png-sequence", "standard"],
  ["mov", "draft"],
  ["mov", "high"],
];

const run = (script, args) => {
  const out = execFileSync(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 26 });
  const line = out.toString().split("\n").find((l) => l.startsWith("RESULT "));
  return JSON.parse(line.slice(7));
};

const rows = [];
for (const [format, quality] of variants) {
  const times = [];
  let last;
  for (let i = 0; i < runs; i++) {
    last = run("src/render.mjs", [format, "--quality", quality]);
    times.push(last.renderSeconds);
    console.error(`${format}/${quality} run ${i + 1}: ${last.renderSeconds}s`);
  }
  let overlaySeconds = "n/a";
  if (format !== "png-sequence") overlaySeconds = run("src/overlay.mjs", [last.outputPath]).overlaySeconds;
  rows.push({ format, quality, times, last, overlaySeconds });
}

const sorted = (a) => [...a].sort((x, y) => x - y);
console.log(`Machine: ${cpus()[0].model}, ${cpus().length} cores, ${Math.round(totalmem() / 2 ** 30)} GB, node ${process.version}`);
console.log("");
console.log("| format | quality | render s (runs) | median s | size MB | pix_fmt (ffprobe) | alpha corner/panel/dot | overlay s |");
console.log("|---|---|---|---|---|---|---|---|");
for (const r of rows) {
  const med = sorted(r.times)[Math.floor(r.times.length / 2)];
  const a = r.last.alphaSamples.map((s) => s.alpha).join("/");
  const pf = r.last.pixFmt + (r.last.alphaModeTag ? ` (alpha_mode=${r.last.alphaModeTag})` : "");
  console.log(`| ${r.format} | ${r.quality} | ${r.times.join(", ")} | ${med} | ${r.last.megabytes} | ${pf} | ${a} | ${r.overlaySeconds} |`);
}
