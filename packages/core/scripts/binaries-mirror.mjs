// Build and check the GitHub release that mirrors a managed binary package (docs/binaries.md, "Mirror").
// Needs the built core (`pnpm exec tsc -b packages/core`). Usage:
//   node packages/core/scripts/binaries-mirror.mjs tag <package>                 print the mirror tag
//   node packages/core/scripts/binaries-mirror.mjs stage <package> <dir> <notes> download, verify, write the release files
//   node packages/core/scripts/binaries-mirror.mjs verify <package>              check the published release
// `stage` aborts on any checksum or size mismatch, so a release never holds bytes the manifest does not pin.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DEFAULT_PACKAGES, checkMirrorSums, mirrorUrl, parseSha256Sums, planMirror } from "../dist/index.js";

const USER_AGENT = "frameshell-binaries-mirror";
/** Written offers must stay valid at least this long (GPL-3.0 §6(b)). */
const OFFER_YEARS = 3;

const [command, name, ...rest] = process.argv.slice(2);
const pkg = DEFAULT_PACKAGES.find((p) => p.name === name);
if (!command || !pkg) {
  const names = DEFAULT_PACKAGES.filter((p) => p.mirror).map((p) => p.name);
  fail(`usage: binaries-mirror.mjs <tag|stage|verify> <${names.join("|")}> [...]`);
}
const plan = planMirror(pkg);

if (command === "tag") {
  process.stdout.write(`${plan.tag}\n`);
} else if (command === "stage") {
  const [dir, notes] = rest;
  if (!dir || !notes) fail("usage: binaries-mirror.mjs stage <package> <dir> <notes-file>");
  await stage(dir, notes);
} else if (command === "verify") {
  await verify();
} else {
  fail(`unknown command ${command}`);
}

/**
 * @param {string} dir
 * @param {string} notesFile
 */
async function stage(dir, notesFile) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const asset of plan.assets) {
    await download(asset, join(dir, asset.name));
    console.log(`ok ${asset.name} (${asset.size} bytes)`);
  }
  writeFileSync(join(dir, "COPYING.GPLv3"), licenseText(dir));
  writeFileSync(join(dir, "SOURCE-OFFER.txt"), sourceOffer());
  const sums = readdirSync(dir)
    .filter((file) => file !== "SHA256SUMS.txt")
    .sort()
    .map((file) => `${createHash("sha256").update(readFileSync(join(dir, file))).digest("hex")}  ${file}`);
  writeFileSync(join(dir, "SHA256SUMS.txt"), `${sums.join("\n")}\n`);
  // The staged listing must pass the same check `verify` runs against the published release.
  const problems = checkMirrorSums(plan, parseSha256Sums(readFileSync(join(dir, "SHA256SUMS.txt"), "utf8")));
  if (problems.length > 0) fail(problems.join("\n"));
  writeFileSync(notesFile, releaseNotes());
  console.log(`staged ${readdirSync(dir).length} files for ${plan.repo}@${plan.tag}`);
}

async function verify() {
  const response = await fetchWithRetry(mirrorUrl({ repo: plan.repo, tag: plan.tag }, "SHA256SUMS.txt"));
  const problems = checkMirrorSums(plan, parseSha256Sums(await response.text()));
  // SHA256SUMS lists what was uploaded; also check each URL the daemon and the offer point to resolves.
  for (const asset of plan.assets) {
    const head = await fetch(asset.url, { method: "HEAD", headers: { "user-agent": USER_AGENT } });
    if (!head.ok) problems.push(`${asset.url}: HTTP ${head.status}`);
  }
  if (problems.length > 0) {
    fail(`Mirror ${plan.repo}@${plan.tag} does not match the manifest:\n  ${problems.join("\n  ")}`);
  }
  console.log(`Mirror ${plan.repo}@${plan.tag} holds all ${plan.assets.length} pinned files with matching SHA-256.`);
}

/**
 * Stream to disk while hashing; retry transient failures, never a checksum mismatch.
 * @param {import("../dist/index.js").MirrorAsset} asset
 * @param {string} dest
 */
async function download(asset, dest) {
  const response = await fetchWithRetry(asset.from);
  const hash = createHash("sha256");
  let size = 0;
  await pipeline(
    Readable.fromWeb(/** @type {import("node:stream/web").ReadableStream<Uint8Array>} */ (response.body)),
    async function* (/** @type {AsyncIterable<Buffer>} */ source) {
      for await (const chunk of source) {
        hash.update(chunk);
        size += chunk.length;
        yield chunk;
      }
    },
    createWriteStream(dest),
  );
  const sha256 = hash.digest("hex");
  if (sha256 !== asset.sha256 || size !== asset.size) {
    fail(
      `${asset.name}: ${asset.from} served ${size} bytes with SHA-256 ${sha256}; ` +
        `the manifest pins ${asset.size} bytes with ${asset.sha256}. Re-pin (docs/binaries.md) before mirroring.`,
    );
  }
}

/** @param {string} url */
async function fetchWithRetry(url) {
  let last = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, { headers: { "user-agent": USER_AGENT } });
      if (response.ok && response.body) return response;
      last = `HTTP ${response.status}`;
      if (response.status === 404) break;
    } catch (error) {
      last = /** @type {Error} */ (error).message;
    }
    await new Promise((done) => setTimeout(done, attempt * 5_000));
  }
  return fail(`${url}: ${last}`);
}

/**
 * GPL-3.0 §4 asks for a copy of the licence with each copy: take it from the FFmpeg source being mirrored.
 * @param {string} dir
 */
function licenseText(dir) {
  for (const asset of plan.assets.filter((a) => a.kind === "source")) {
    const archive = join(dir, asset.name);
    const member = execFileSync("tar", ["-tf", archive], { encoding: "utf8", maxBuffer: 64 << 20 })
      .split("\n")
      .find((line) => /^[^/]+\/COPYING\.GPLv3$/.test(line));
    if (member) return execFileSync("tar", ["-xOf", archive, member], { maxBuffer: 1 << 20 });
  }
  return fail("No mirrored source archive contains COPYING.GPLv3.");
}

function sourceOffer() {
  const binaries = plan.assets.filter((a) => a.kind === "binary");
  const sources = plan.assets.filter((a) => a.kind === "source");
  const issues = `https://github.com/${plan.repo}/issues`;
  return `Corresponding source for the ${plan.package} binaries in ${plan.repo} release ${plan.tag}
${"=".repeat(60)}

The binaries in this release are copies of third-party builds, licensed ${plan.licenses.join(", ")}.
Frameshell redistributes them unmodified as a download fallback. See COPYING.GPLv3.

Source included in this release:

${sources.map((s) => `  ${s.name}\n    ${s.description}\n    from ${s.from}`).join("\n")}

The build scripts name every library linked into the binaries and pin its exact version
or commit. The FFmpeg archives are the exact FFmpeg revision of each build.

Written offer

For at least ${OFFER_YEARS} years after this release was published, and for as long as Frameshell
offers these binaries for download, the Frameshell maintainer will give any third party a
complete machine-readable copy of the Corresponding Source of the binaries listed below:
FFmpeg and every library linked into them at the exact versions used, and the scripts used
to build them. It is provided by download at no charge, or on a physical medium customarily
used for software interchange for no more than the cost of physically performing the
distribution. Ask by opening an issue at ${issues} titled
"Source request: ${plan.tag}".

Binaries covered:

${binaries.map((b) => `  ${b.name}  (${b.platforms.join(", ")})\n    ${b.description}\n    sha256 ${b.sha256}`).join("\n")}
`;
}

function releaseNotes() {
  const row = (/** @type {import("../dist/index.js").MirrorAsset} */ a) =>
    `| \`${a.name}\` | ${a.kind === "binary" ? a.platforms.join(", ") : "source"} | ${a.description} | [origin](${a.from}) |`;
  return `Fallback copy of the ${plan.package} builds pinned in \`packages/core/src/binaries/manifest.ts\`.
Frameshell downloads from the original builder first and uses these files only if that fails.
Every file has the pinned SHA-256 (\`SHA256SUMS.txt\`).

These are GPL builds. Their corresponding source is in this release, with a written offer
for the complete source of every linked library (\`SOURCE-OFFER.txt\`) and the licence (\`COPYING.GPLv3\`).

| File | Platforms | Content | Origin |
|---|---|---|---|
${plan.assets.map(row).join("\n")}
`;
}

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  console.error(message);
  process.exit(1);
}
