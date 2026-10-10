// PROTOTYPE, throwaway. Question 3: is bundle() deterministic, does a change outside the
// Remotion project change it, can we read its file dependencies, and is React duplicated?
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ENTRY, OUT, PROJECT, SPIKE, bundler, dirHash, singleReact } from "./common.mjs";

const { bundle } = await bundler();

async function run(name, { alias = true, caching = true } = {}) {
  const outDir = join(OUT, "bundles", name);
  await rm(outDir, { recursive: true, force: true });
  let deps = [];
  const t0 = performance.now();
  await bundle({
    entryPoint: ENTRY,
    rootDir: PROJECT,
    outDir,
    enableCaching: caching,
    webpackOverride: (config) => {
      const c = alias ? singleReact(config) : config;
      return {
        ...c,
        plugins: [
          ...(c.plugins ?? []),
          { apply: (compiler) => compiler.hooks.done.tap("deps", (stats) => (deps = [...stats.compilation.fileDependencies])) },
        ],
      };
    },
  });
  const ms = Math.round(performance.now() - t0);
  const { hash, files } = await dirHash(outDir);
  return { name, ms, hash, fileCount: Object.keys(files).length, files, deps };
}

const report = {};
await rm(join(PROJECT, "node_modules", ".cache"), { recursive: true, force: true });
const cold = await run("cold", { caching: true });
const warm = await run("warm", { caching: true });
const nocache = await run("nocache", { caching: false });
report.timing = { coldMs: cold.ms, warmMs: warm.ms, nocacheMs: nocache.ms };
report.deterministic = { coldVsWarm: cold.hash === warm.hash, coldVsNocache: cold.hash === nocache.hash };
if (cold.hash !== warm.hash) {
  report.differingFiles = Object.keys({ ...cold.files, ...warm.files }).filter((f) => cold.files[f] !== warm.files[f]);
}
const own = cold.deps.filter((d) => !d.includes("node_modules"));
report.deps = { total: cold.deps.length, outsideNodeModules: own.map((d) => d.replace(SPIKE + "/", "")) };

// A change in the "web app", outside the Remotion project.
const panel = join(SPIKE, "web", "src", "Panel.tsx");
const original = await readFile(panel, "utf8");
await writeFile(panel, original.replace("borderRadius: 24", "borderRadius: 25"));
try {
  const edited = await run("edited");
  report.externalEdit = { changesHash: edited.hash !== cold.hash, ms: edited.ms, changedFiles: Object.keys(edited.files).filter((f) => edited.files[f] !== cold.files[f]) };
} finally {
  await writeFile(panel, original);
}
const restored = await run("restored");
report.restoredMatchesCold = restored.hash === cold.hash;

// Without the alias, web/ resolves its own React copy.
const dup = await run("no-alias", { alias: false });
report.noAlias = {
  reactFromWeb: dup.deps.some((d) => d.includes("web/node_modules/react")),
  reactFromProject: dup.deps.some((d) => d.includes("remotion/node_modules/react/")),
};
report.withAlias = { reactFromWeb: cold.deps.some((d) => d.includes("web/node_modules/react")) };
report.bundleFiles = Object.keys(cold.files);
console.log(JSON.stringify(report, null, 2));
