// Release notes header (#740): one download per OS at the top, so nobody has to guess among a dozen assets.
// `node scripts/release/downloads.mjs <dist dir> <repo> <tag>` prints the Markdown; the release workflow passes it
// as the notes that `--generate-notes` appends the changes to. Pure part: `downloadsSection`.
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Asset name patterns per row, first match wins: what a person on that OS should download. */
const ROWS = [
  { label: "Windows", pattern: /-win-x64\.exe$/ },
  { label: "macOS (Apple silicon)", pattern: /-mac-arm64\.dmg$/ },
  { label: "macOS (Intel)", pattern: /-mac-x64\.dmg$/ },
  { label: "Linux (AppImage)", pattern: /-linux-x86_64\.AppImage$/ },
  { label: "Linux (Debian, Ubuntu)", pattern: /-linux-amd64\.deb$/ },
];

/**
 * The "Download" section for `files`, linking each to the release `tag` of `repo` (`owner/name`). Rows whose file
 * is missing are left out; empty when none is there.
 * @param {readonly string[]} files
 * @param {string} repo
 * @param {string} tag
 * @returns {string}
 */
export function downloadsSection(files, repo, tag) {
  const lines = ROWS.flatMap(({ label, pattern }) => {
    const file = files.find((name) => pattern.test(name));
    return file ? [`| ${label} | [${file}](https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(file)}) |`] : [];
  });
  if (lines.length === 0) return "";
  return ["## Download", "", "| Your computer | File |", "|---|---|", ...lines, "", "The other files are for automatic updates and checksums.", ""].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, repo, tag] = process.argv.slice(2);
  if (!dir || !repo || !tag) {
    console.error("usage: downloads.mjs <dist dir> <owner/repo> <tag>");
    process.exit(2);
  }
  process.stdout.write(downloadsSection(readdirSync(dir), repo, tag));
}
