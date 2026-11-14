// What @hyperframes/lint (and the plugin's seek-safety rules) say about the spike composition with the vendored three bundle,
// against the 2D motion control composition. Usage: node src/lint.mjs
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { makeProject, repoRoot } from "./lib.mjs";

const pluginDir = join(repoRoot, "plugins", "hyperframes");
const { lintProject } = await import(pathToFileURL(join(pluginDir, "node_modules", "@hyperframes", "lint", "dist", "index.js")).href);
const { seekSafetyFindings } = await import(pathToFileURL(join(pluginDir, "dist", "seek-safety.js")).href);

for (const [name, overrides] of [["three product shot", {}], ["2D motion control", { template: "baseline.html" }]]) {
  const project = makeProject("lint", overrides);
  const result = await lintProject(project.comp, undefined, { host: "cli" });
  console.log(`== ${name}`);
  for (const { result: r } of result.results) {
    for (const f of r.findings) console.log(`  ${f.severity.padEnd(7)} ${f.code}  ${String(f.file ?? "").split("/").pop()}:${f.line ?? "?"}`);
  }
  const html = readFileSync(join(project.comp, "index.html"), "utf8");
  console.log("  seek-safety:", seekSafetyFindings(html).map((f) => `${f.severity} ${f.rule}`));
}
