// Builds Frameshell's whisper.cpp release assets (WHISPER_FRAMESHELL_BUILDS in
// src/binaries/manifest.ts) reproducibly, and checks them against their pins.
// Run by .github/workflows/whisper-cpp-release.yml. Requires a prior `tsc -b`.
//
//   node packages/core/scripts/whisper-cpp-build.mjs matrix
//       JSON list of { platform, runner } for the CI matrix.
//   node packages/core/scripts/whisper-cpp-build.mjs release
//       Release tag, then one "<sha256>  <asset>" line per pinned asset.
//   node packages/core/scripts/whisper-cpp-build.mjs build <platform> <outDir>
//       Download and verify the pinned source, build, start-check, pack
//       <outDir>/<asset>, then compare it with the pin: exit 1 on mismatch,
//       printing the actual SHA-256 and size (that output is how pins are made).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WHISPER_FRAMESHELL_BUILDS, WHISPER_FRAMESHELL_TAG, WHISPER_SOURCE, packTar } from "../dist/index.js";

const [command, platform, outDir] = process.argv.slice(2);

if (command === "matrix") {
  console.log(JSON.stringify(WHISPER_FRAMESHELL_BUILDS.map(({ platform, runner }) => ({ platform, runner }))));
} else if (command === "release") {
  console.log(WHISPER_FRAMESHELL_TAG);
  for (const { sha256, asset } of WHISPER_FRAMESHELL_BUILDS) console.log(`${sha256}  ${asset}`);
} else if (command === "build" && platform && outDir) {
  build(platform, resolve(outDir));
} else {
  console.error("usage: whisper-cpp-build.mjs matrix | release | build <platform> <outDir>");
  process.exit(2);
}

function build(platform, outDir) {
  const pin = WHISPER_FRAMESHELL_BUILDS.find((candidate) => candidate.platform === platform);
  if (!pin) throw new Error(`No Frameshell whisper.cpp build for ${platform}`);
  // Fixed paths, remapped below: the bytes must not depend on where the build ran.
  const work = join(process.env.RUNNER_TEMP ?? tmpdir(), "frameshell-whisper-build", platform);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const tarball = join(work, "source.tar.gz");
  run("curl", ["-fsSL", "--retry", "3", "-o", tarball, WHISPER_SOURCE.url]);
  const sourceHash = sha256(readFileSync(tarball));
  if (sourceHash !== WHISPER_SOURCE.sha256) throw new Error(`source SHA-256 ${sourceHash}, pinned ${WHISPER_SOURCE.sha256}`);
  run("tar", ["-xzf", tarball, "-C", work]);
  const src = join(work, WHISPER_SOURCE.root);
  const buildDir = join(work, "build");

  const remap = `-ffile-prefix-map=${src}=/whisper.cpp -ffile-prefix-map=${buildDir}=/build`;
  const env = { ...process.env, SOURCE_DATE_EPOCH: "0", ZERO_AR_DATE: "1" };
  run(
    "cmake",
    [
      "-S", src, "-B", buildDir,
      "-DCMAKE_BUILD_TYPE=Release",
      ...["C", "CXX", "OBJC", "OBJCXX", "ASM"].map((lang) => `-DCMAKE_${lang}_FLAGS=${remap}`),
      ...pin.configure,
    ],
    env,
  );
  run("cmake", ["--build", buildDir, "--config", "Release", "--parallel", String(availableParallelism()), "--target", "whisper-cli"], env);

  const exe = join(buildDir, "bin", "whisper-cli");
  // Start check: must run on the build machine (darwin-x64 through Rosetta).
  const version = execFileSync(exe, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  console.log(version.trim());

  const archive = packTar([
    { name: "whisper-cli", data: readFileSync(exe), mode: 0o755 },
    { name: "LICENSE", data: readFileSync(join(src, "LICENSE")), mode: 0o644 },
  ]);
  const file = join(outDir, pin.asset);
  writeFileSync(file, archive);
  const actual = { sha256: sha256(archive), size: archive.length };
  writeFileSync(`${file}.sha256`, `${actual.sha256}  ${pin.asset}\n`);
  console.log(`${pin.asset}: sha256 ${actual.sha256}, size ${actual.size}`);
  if (actual.sha256 !== pin.sha256 || actual.size !== pin.size) {
    console.error(
      `::error::${pin.asset} does not match its pin (pinned sha256 ${pin.sha256}, size ${pin.size}; ` +
        `built sha256 ${actual.sha256}, size ${actual.size}). If the recipe or runner changed on purpose, re-pin (docs/binaries.md).`,
    );
    process.exit(1);
  }
}

function run(file, args, env = process.env) {
  console.log(`$ ${file} ${args.join(" ")}`);
  execFileSync(file, args, { stdio: "inherit", env });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
