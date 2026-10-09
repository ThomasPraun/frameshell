// Check, pack and publish the official plugins (`plugins/*`) to npm (docs/release.md, "npm plugins").
// Usage:
//   node scripts/plugins-npm.mjs verify             package.json + manifest checks only (no build, no network)
//   node scripts/plugins-npm.mjs dry-run [outDir]   verify, pnpm pack, check the tarballs, npm publish --dry-run
//   node scripts/plugins-npm.mjs publish [outDir]   dry-run, then publish each version npm lacks, with provenance
// `dry-run` and `publish` need the plugins built (`pnpm exec tsc -b plugins/whisper-cpp plugins/hyperframes`).
// `publish` runs in GitHub Actions only: npm trusted publishing authenticates the workflow by its OIDC identity
// (`id-token: write`, npm >= 11.5.1), so no npm token exists.
// Versions are per plugin, from package.json; a version already on npm is skipped, never republished.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPOSITORY = "git+https://github.com/ThomasPraun/frameshell.git";
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const DEP_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"];
const WIN = process.platform === "win32";

const [command, outArg] = process.argv.slice(2);
if (!["verify", "dry-run", "publish"].includes(command ?? "")) fail("usage: plugins-npm.mjs <verify|dry-run|publish> [outDir]");

const plugins = readdirSync(join(ROOT, "plugins"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(ROOT, "plugins", entry.name, "package.json")))
  .map((entry) => readPlugin(entry.name));
const problems = plugins.flatMap(verify);
if (problems.length > 0) fail(`Official plugin packages are not publishable:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
for (const plugin of plugins) log(`ok ${plugin.pkg.name}@${plugin.pkg.version} (dist-tag ${distTag(plugin.pkg.version)})`);
if (command === "verify") process.exit(0);

const outDir = outArg ? resolve(outArg) : mkdtempSync(join(tmpdir(), "frameshell-plugins-"));
mkdirSync(outDir, { recursive: true });
const tarballs = plugins.map((plugin) => ({ plugin, file: pack(plugin, outDir) }));
for (const { plugin, file } of tarballs) {
  const missing = checkTarball(plugin, file);
  if (missing.length > 0) fail(`${file}:\n${missing.map((p) => `  - ${p}`).join("\n")}`);
  npm(["publish", file, "--dry-run", "--access", "public", "--tag", distTag(plugin.pkg.version)]);
  log(`packed ${plugin.pkg.name}@${plugin.pkg.version} -> ${file}`);
}
if (command === "dry-run") process.exit(0);

if (!process.env.ACTIONS_ID_TOKEN_REQUEST_URL) fail("No GitHub Actions OIDC token: publish runs only in the Release workflow, with `id-token: write` (docs/release.md).");
if (!npmSupportsTrustedPublishing()) fail("npm >= 11.5.1 is needed for trusted publishing (docs/release.md).");
for (const { plugin, file } of tarballs) {
  const id = `${plugin.pkg.name}@${plugin.pkg.version}`;
  if (isPublished(plugin.pkg.name, plugin.pkg.version)) {
    summary(`- \`${id}\` already on npm, skipped`);
    continue;
  }
  npm(["publish", file, "--access", "public", "--provenance", "--tag", distTag(plugin.pkg.version)]);
  summary(`- \`${id}\` published to npm (dist-tag \`${distTag(plugin.pkg.version)}\`)`);
}

/** Package.json and plugin manifest of `plugins/<dir>`. */
function readPlugin(dir) {
  const path = join(ROOT, "plugins", dir);
  const pkg = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
  const manifestFile = join(path, "frameshell-plugin.json");
  const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, "utf8")) : null;
  return { dir, path, pkg, manifest };
}

/** Everything that would make the published package wrong, as messages. */
function verify({ dir, pkg, manifest }) {
  const at = `plugins/${dir}/package.json`;
  const problems = [];
  const check = (ok, message) => ok || problems.push(`${at}: ${message}`);
  check(typeof pkg.name === "string" && pkg.name.startsWith("@frameshell/"), `name must be @frameshell/<name>, got ${pkg.name}`);
  check(pkg.private !== true, "must not be private");
  check(SEMVER.test(pkg.version ?? ""), `version must be semver, got ${pkg.version}`);
  check(pkg.license === "Apache-2.0", `license must be Apache-2.0, got ${pkg.license}`);
  check(pkg.publishConfig?.access === "public", 'publishConfig.access must be "public" (scoped packages default to restricted)');
  check(pkg.publishConfig?.provenance === true, "publishConfig.provenance must be true");
  check(pkg.repository?.type === "git" && pkg.repository?.url === REPOSITORY, `repository.url must be ${REPOSITORY} (provenance checks it)`);
  check(pkg.repository?.directory === `plugins/${dir}`, `repository.directory must be plugins/${dir}`);
  check(typeof pkg.homepage === "string", "homepage is missing");
  const files = pkg.files ?? [];
  for (const required of ["dist", "frameshell-plugin.json"]) {
    check(files.includes(required), `files must include ${required}`);
  }
  for (const field of DEP_FIELDS) {
    for (const [name, range] of Object.entries(pkg[field] ?? {})) {
      check(!String(range).startsWith("workspace:"), `${field}.${name} is ${range}: unpublished workspace packages cannot be runtime dependencies`);
    }
  }
  if (!manifest) {
    problems.push(`plugins/${dir}: frameshell-plugin.json is missing`);
    return problems;
  }
  check(manifest.name === pkg.name, `frameshell-plugin.json name ${manifest.name} differs from package.json`);
  check(manifest.version === pkg.version, `frameshell-plugin.json version ${manifest.version} differs from package.json ${pkg.version}`);
  check(manifest.main === pkg.main, `frameshell-plugin.json main ${manifest.main} differs from package.json ${pkg.main}`);
  for (const skill of manifest.contributes?.skills ?? []) {
    check(files.some((entry) => skill === entry || skill.startsWith(`${entry}/`)), `files does not cover skill ${skill}`);
  }
  return problems;
}

/** Prerelease versions go to `next`, so `npm install @frameshell/x` never picks one. */
function distTag(version) {
  return SEMVER.exec(version)?.[4] ? "next" : "latest";
}

/** `pnpm pack` rewrites `workspace:` ranges, which `npm pack` would publish verbatim. */
function pack({ path, pkg }, dir) {
  run("pnpm", ["pack", "--pack-destination", dir], path);
  const file = join(dir, `${pkg.name.replace(/^@/, "").replace("/", "-")}-${pkg.version}.tgz`);
  if (!existsSync(file)) fail(`pnpm pack did not write ${file}`);
  return file;
}

/** Files a working plugin needs that the tarball lacks, plus sources that should not ship. */
function checkTarball({ pkg, manifest }, file) {
  const entries = new Set(
    execFileSync("tar", ["-tzf", file], { encoding: "utf8" })
      .split(/\r?\n/)
      .filter(Boolean)
      .map((entry) => posix.normalize(entry)),
  );
  const required = ["package.json", "frameshell-plugin.json", "README.md", "LICENSE", manifest.main, ...(manifest.contributes?.skills ?? [])];
  const problems = required.filter((path) => !entries.has(`package/${posix.normalize(path)}`)).map((path) => `missing ${path}`);
  for (const entry of entries) {
    if (/^package\/(src|test)\//.test(entry)) problems.push(`ships ${entry.slice("package/".length)}`);
  }
  if (problems.length > 0) problems.unshift(`${pkg.name}@${pkg.version}:`);
  return problems;
}

/** True when the registry has `name@version`; false only on a clean 404. */
function isPublished(name, version) {
  const result = spawnSync("npm", ["view", `${name}@${version}`, "version", "--json"], { encoding: "utf8", shell: WIN });
  if (result.status === 0) return result.stdout.trim() !== "";
  if (/E404|404 Not Found/.test(`${result.stdout}${result.stderr}`)) return false;
  fail(`npm view ${name}@${version} failed:\n${result.stderr}`);
}

/** True when the npm CLI is 11.5.1 or later, the first version with trusted publishing. */
function npmSupportsTrustedPublishing() {
  const version = execFileSync("npm", ["--version"], { encoding: "utf8", shell: WIN }).trim();
  const [major, minor, patch] = version.split(/[.-]/).map(Number);
  return major > 11 || (major === 11 && (minor > 5 || (minor === 5 && patch >= 1)));
}

function npm(args) {
  run("npm", args, ROOT);
}

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: WIN });
  if (result.status !== 0) fail(`${cmd} ${args.join(" ")} failed (exit ${result.status ?? result.signal})`);
}

function summary(line) {
  log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

function log(line) {
  process.stdout.write(`${line}\n`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
