// Which unit tests and whether e2e run for a set of changed paths. CI (`.github/workflows/ci.yml`) and agents
// iterating locally share it. Packages form one chain (schema → protocol → core → cli → desktop) behind barrel
// imports, so a package change runs everything; only leaf areas (app, plugins, docs) narrow the run.
// Usage:
//   node scripts/test-scope.mjs [base]   paths changed since merge-base with base (default origin/main), plus
//                                        uncommitted ones; prints the commands to run
//   node scripts/test-scope.mjs --github <base> <head>   writes `filter`, `unit`, `e2e` to $GITHUB_OUTPUT
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Tests that read plugin files (skills, package manifests, a twin constant) from outside `plugins/`. */
const PLUGIN_READERS = [
  "packages/core/test/official-plugin-packages.test.ts",
  "packages/cli/test/skill-docs.test.ts",
  "apps/desktop/test/whisper-default-model.test.ts",
];

/** Paths no test, build or packaged app reads. */
const NO_TESTS = [/^docs\//, /^website\//, /^evals\//, /^\.claude\//, /^[^/]+\.md$/, /^LICENSE$/, /^NOTICE$/];

/**
 * Scope for changed repo-relative paths: `unit` is "all", "none" or "some" (then `filter` lists vitest path
 * filters); `e2e` says whether the Electron e2e suite runs. Unknown paths run everything.
 * @param {string[]} paths
 * @returns {{ unit: "all" | "none" | "some", filter: string[], e2e: boolean }}
 */
export function testScope(paths) {
  const filter = new Set();
  let e2e = false;
  for (const raw of paths) {
    const path = raw.replaceAll("\\", "/");
    if (NO_TESTS.some((re) => re.test(path))) continue;
    const plugin = /^plugins\/([^/]+)\//.exec(path);
    if (plugin) {
      filter.add(`plugins/${plugin[1]}/test`);
      PLUGIN_READERS.forEach((test) => filter.add(test));
      e2e = true;
      continue;
    }
    if (path.startsWith("apps/desktop/")) {
      filter.add("apps/desktop/test");
      e2e = true;
      continue;
    }
    return { unit: "all", filter: [], e2e: true };
  }
  if (filter.size === 0) return { unit: "none", filter: [], e2e };
  // "apps/desktop/test" already covers the desktop plugin reader.
  if (filter.has("apps/desktop/test")) filter.delete("apps/desktop/test/whisper-default-model.test.ts");
  return { unit: "some", filter: [...filter].sort(), e2e };
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).split("\n").filter(Boolean);
}

function main(argv) {
  if (argv[0] === "--github") {
    const [, base, head] = argv;
    const scope = testScope(git("diff", "--name-only", base, head));
    const out = `unit=${scope.unit}\nfilter=${scope.filter.join(" ")}\ne2e=${scope.e2e}\n`;
    process.stdout.write(out);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, out);
    return;
  }
  const base = argv[0] ?? "origin/main";
  const committed = git("diff", "--name-only", `${base}...HEAD`);
  const pending = git("status", "--porcelain", "--untracked-files=all").map((line) => line.slice(3).split(" -> ").pop());
  const scope = testScope([...new Set([...committed, ...pending])]);
  const unit =
    scope.unit === "none" ? "(none)" : `pnpm typecheck && pnpm lint && pnpm test ${scope.filter.join(" ")}`.trim();
  process.stdout.write(`unit: ${unit}\ne2e:  ${scope.e2e ? "pnpm test:e2e" : "(none)"}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
