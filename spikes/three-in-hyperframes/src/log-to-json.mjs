// One-off: turns a bench stdout log ("<variant> {json}" per line) into a results JSON. Usage: node src/log-to-json.mjs out/bench-main.log results/x.json
import { readFileSync, writeFileSync } from "node:fs";

const [log, out] = process.argv.slice(2);
const rows = {};
for (const line of readFileSync(log, "utf8").split("\n")) {
  const at = line.indexOf("{");
  if (at > 0) rows[line.slice(0, at).trim()] = JSON.parse(line.slice(at));
}
writeFileSync(out, JSON.stringify(rows, null, 1));
