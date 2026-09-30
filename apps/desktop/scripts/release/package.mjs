// Package the built app (`out/`) with electron-builder for the host OS. Usage:
//   node scripts/release/package.mjs [--dir]
// --dir stops at the unpacked app (quick local check, host arch only).
// In GitHub Actions it appends the plan summary to the job summary and writes `executable`, `version` and `signing` outputs.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { planRelease } from "./plan.mjs";

const appDir = resolve(import.meta.dirname, "../..");
const platform = /** @type {"darwin" | "linux" | "win32"} */ (process.platform);
const arch = process.arch === "arm64" ? "arm64" : "x64";
const plan = planRelease({ platform, arch, env: process.env, dirOnly: process.argv.includes("--dir") });

const summaryFile = process.env["GITHUB_STEP_SUMMARY"];
const report = (/** @type {string} */ text) => {
  process.stdout.write(`${text}\n`);
  if (summaryFile) appendFileSync(summaryFile, `${text}\n`);
};

if (plan.errors.length > 0) {
  report(`### Release configuration error\n\n${plan.errors.map((error) => `- ${error}`).join("\n")}\n`);
  process.exit(1);
}
report(plan.summary);

const env = { ...process.env, ...plan.env };
let keyDir;
if (plan.appleApiKeyBase64) {
  // electron-builder takes the App Store Connect key as a .p8 file path.
  keyDir = mkdtempSync(join(tmpdir(), "frameshell-notary-"));
  const keyFile = join(keyDir, "AuthKey.p8");
  writeFileSync(keyFile, Buffer.from(plan.appleApiKeyBase64, "base64"), { mode: 0o600 });
  env["APPLE_API_KEY"] = keyFile;
}

let status;
try {
  status = spawnSync("pnpm", ["exec", "electron-builder", ...plan.args], {
    cwd: appDir,
    env,
    stdio: "inherit",
    // pnpm is a .cmd shim on Windows.
    shell: process.platform === "win32",
  }).status;
} finally {
  // Before any exit: the key must not outlive the build.
  if (keyDir) rmSync(keyDir, { recursive: true, force: true });
}
if (status !== 0) process.exit(status ?? 1);

const output = process.env["GITHUB_OUTPUT"];
if (output) appendFileSync(output, `executable=${join(appDir, plan.executable)}\nversion=${plan.version}\nsigning=${plan.signing}\n`);
console.log(`Packaged ${plan.version}; app executable: ${join(appDir, plan.executable)}`);
