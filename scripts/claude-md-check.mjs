// Guards the agent docs: the root CLAUDE.md router and the nested area CLAUDE.md files it points to.
// Default run (CI, every PR): no CLAUDE.md inside a directory that ships to users, and every backticked repo path in
// any CLAUDE.md exists. `--split <rev>` also checks that every token and rule clause of the root CLAUDE.md at <rev>
// still appears in some CLAUDE.md (or, for tokens, in docs/), so a reorganization cannot drop a rule unseen.
// Usage:
//   node scripts/claude-md-check.mjs
//   node scripts/claude-md-check.mjs --split <rev> [--allow <file>]   allow file: `<token or rule key> :: <reason>` lines
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

/** Words that mark a sentence as a rule rather than a description. */
const POLARITY = /\b(never|only|always|one|reuse|bump|refuse[sd]?|must)\b/gi;

/** Code and doc files a bare backticked name (no directory) is checked against. */
const CHECKED_EXT = /\.(ts|tsx|mts|mjs|js|py|ya?ml|md|nsh)$/;

/** Backticked paths that live in a user's project, user dirs, build output or the packaged app, not in git. */
const OUTSIDE_REPO = [
  /^\.frameshell\//,
  /^\.cache\//,
  /^dist\//,
  /^assets\//,
  /^beats\//,
  /^timelines\//,
  /^configDir/,
  /^dataDir/,
  /^resources\//,
];

/**
 * Why a CLAUDE.md at `path` would ship to users, or null when it stays in the repo. `pluginFiles` gives a plugin
 * dir's npm `files` entries (`plugins/x` -> ["dist", ...]).
 * @param {string} path repo-relative, forward slashes
 * @param {(pluginDir: string) => string[]} pluginFiles
 * @returns {string | null}
 */
export function shippedReason(path, pluginFiles) {
  const parts = path.split("/");
  if (parts[0] === "skills") return "skills/ is bundled into user projects (`pnpm gen:skill`)";
  if (parts[0] === "plugins" && parts.length > 2) {
    if (parts[2] === "skills") return "plugins/*/skills/ ships in the plugin tarball and is linked into user projects";
    if (parts.length > 3 && pluginFiles(`plugins/${parts[1]}`).includes(parts[2])) {
      return `${parts[2]}/ is in the npm \`files\` of plugins/${parts[1]}`;
    }
  }
  // apps/desktop/electron-builder.yml copies each workspace package into the app minus src/, test/, scripts/.
  if (parts[0] === "packages" && parts.length > 2 && !["src", "test", "scripts"].includes(parts[2])) {
    return "the desktop app ships every packages/<pkg>/ file outside src/, test/ and scripts/";
  }
  if (parts[0] === "apps" && parts[1] === "desktop" && ["out", "build", "resources"].includes(parts[2])) {
    return "apps/desktop build output and resources ship in the app";
  }
  if (parts[0] === "website" && parts[1] === "public") return "website/public/ is deployed as is";
  return null;
}

/** @param {string} text */
export function backtickSpans(text) {
  // A pipe inside a table cell is escaped as `\|`; the same span in a list item is not.
  return [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].replaceAll("\\|", "|"));
}

/**
 * The repo path a backticked span names, cut at its first glob or brace, or null when the span is not a path to
 * check (code, a project path, a number pair).
 * @param {string} span
 * @returns {string | null}
 */
export function pathOf(span) {
  if (OUTSIDE_REPO.some((re) => re.test(span))) return null;
  const glob = span.search(/[*{[]/);
  const path = glob === -1 ? span : span.slice(0, span.lastIndexOf("/", glob) + 1);
  if (/[\s<>:;,()=|'"\\±]/.test(path) || !/[A-Za-z]/.test(path)) return null;
  if (!path.includes("/")) return CHECKED_EXT.test(path) ? path : null;
  if (!path.endsWith("/") && !/\.[A-Za-z]\w*$/.test(path.split("/").pop())) return null;
  return path;
}

/**
 * Where `path` (from `pathOf`) lands in the repo: tried from the CLAUDE.md's own dir and each dir above it, then as
 * the tail of a tracked path (abbreviated paths such as `main/trash.ts`). Null when nothing matches.
 * @param {string} path
 * @param {string} claudeDir repo-relative dir of the CLAUDE.md ("" for the root)
 * @param {Set<string>} entries tracked files and their dirs (dirs end with "/")
 * @returns {string | null}
 */
export function resolvePath(path, claudeDir, entries) {
  const dir = path.endsWith("/");
  const bare = dir ? path.slice(0, -1) : path;
  const key = (p) => (dir ? `${p}/` : p);
  for (let base = claudeDir; ; base = posix.dirname(base)) {
    const at = base === "" || base === "." ? bare : `${base}/${bare}`;
    if (entries.has(key(at))) return key(at);
    if (base === "" || base === ".") break;
  }
  for (const entry of entries) {
    if (entry === key(bare) || entry.endsWith(`/${key(bare)}`)) return entry;
  }
  return null;
}

/**
 * Rule keys of a doc: for each polarity word, the word plus the one or two backticked spans closest to it inside
 * its clause (or, with none, the two words of five letters or more closest to it). A key survives when one line of
 * the new docs holds the word and all parts.
 * @param {string} text
 * @returns {{ word: string, parts: string[], clause: string }[]}
 */
export function ruleKeys(text) {
  const keys = [];
  for (const line of text.split("\n")) {
    // Backticked spans first become placeholders, so the clause split never cuts inside one.
    const spansOf = [];
    const masked = line.replace(/`([^`\n]+)`/g, (_, span) => `${spansOf.push(span) - 1}`);
    for (const piece of masked.split(/;|\||\(|\)| \u2014 |\.\s/)) {
      const clause = piece.replace(/(\d+)/g, (_, i) => `\`${spansOf[Number(i)]}\``);
      const spans = [...clause.matchAll(/`([^`\n]+)`/g)].map((m) => ({ at: m.index, text: m[1] }));
      for (const hit of clause.matchAll(POLARITY)) {
        const word = hit[0].toLowerCase();
        let parts;
        if (spans.length > 0) {
          // The closest span always; a second one only when it sits close too.
          parts = spans
            .map((s) => ({ ...s, d: Math.abs(s.at - hit.index) }))
            .sort((a, b) => a.d - b.d)
            .filter((s, i) => i === 0 || (i === 1 && s.d < 40))
            .map((s) => s.text);
        } else {
          parts = [...clause.matchAll(/[\w-]{5,}/g)]
            .filter((m) => m[0].toLowerCase() !== word)
            .map((m) => ({ text: m[0], d: Math.abs(m.index - hit.index) }))
            .sort((a, b) => a.d - b.d)
            .slice(0, 2)
            .map((m) => m.text);
        }
        if (parts.length > 0) keys.push({ word, parts, clause: clause.trim() });
      }
    }
  }
  return keys;
}

/** Stable allowlist key of a rule. */
export function ruleId({ word, parts }) {
  return `rule: ${word} ${parts.join(" + ")}`;
}

/**
 * True when one line of `lines` holds the rule's polarity word and every part. A path part may appear as a shorter
 * tail (`methods/*.ts` for `protocol/src/methods/*.ts`); a word part matches in any case.
 * @param {{ word: string, parts: string[] }} rule
 * @param {string[]} lines
 */
export function ruleKept(rule, lines) {
  const word = new RegExp(`\\b${rule.word.replace(/s$|d$/, "")}`, "i");
  const forms = rule.parts.map((part) => {
    if (/^[\w-]+$/.test(part)) return (line) => line.toLowerCase().includes(part.toLowerCase());
    if (!part.includes("/")) return (line) => line.includes(part);
    const segments = part.replace(/\/$/, "").split("/");
    const tails = segments.map((_, i) => segments.slice(i).join("/")).filter((tail) => tail.includes("/") || tail.length > 4);
    return (line) => tails.some((tail) => line.includes(tail));
  });
  return lines.some((line) => word.test(line) && forms.every((has) => has(line)));
}

/**
 * Tokens of a doc that a rewrite must keep: backticked spans, ADR numbers, issue refs, env vars, pnpm commands and
 * UPPER_SNAKE constants.
 * @param {string} text
 * @returns {string[]}
 */
export function tokensOf(text) {
  const out = new Set(backtickSpans(text));
  for (const m of text.matchAll(/\bADR (\d{4})/g)) out.add(`ADR ${m[1]}`);
  for (const m of text.matchAll(/(^|[\s(])#(\d{2,})\b/g)) out.add(`#${m[2]}`);
  for (const m of text.matchAll(/\bFRAMESHELL_\w+/g)) out.add(m[0]);
  for (const m of text.matchAll(/\bpnpm [\w:-]+/g)) out.add(m[0]);
  for (const m of text.matchAll(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g)) out.add(m[0]);
  return [...out];
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 << 20 });
}

function repoEntries() {
  const files = git("ls-files", "-co", "--exclude-standard").split("\n").filter(Boolean);
  const entries = new Set();
  for (const file of files) {
    entries.add(file);
    for (let dir = posix.dirname(file); dir !== "."; dir = posix.dirname(dir)) entries.add(`${dir}/`);
  }
  return { files, entries };
}

function pluginFilesOf(dir) {
  try {
    return JSON.parse(readFileSync(`${dir}/package.json`, "utf8")).files ?? [];
  } catch {
    return [];
  }
}

function main(argv) {
  const { files, entries } = repoEntries();
  const claude = files.filter((f) => posix.basename(f) === "CLAUDE.md" && !f.startsWith(".claude/") && !f.includes("node_modules/"));
  const problems = [];
  const docs = new Map(claude.map((f) => [f, readFileSync(f, "utf8")]));
  const mentioned = new Set();
  for (const [file, text] of docs) {
    const reason = shippedReason(file, pluginFilesOf);
    if (reason) problems.push(`${file}: in a shipped dir (${reason})`);
    const dir = posix.dirname(file) === "." ? "" : posix.dirname(file);
    for (const span of backtickSpans(text)) {
      const path = pathOf(span);
      if (path === null) continue;
      const hit = resolvePath(path, dir, entries);
      if (hit === null) problems.push(`${file}: \`${span}\` names no repo path`);
      else mentioned.add(hit);
    }
    process.stdout.write(`${file}: ~${Math.round(text.length / 4)} tokens\n`);
  }

  const split = argv.indexOf("--split");
  if (split !== -1) {
    const old = git("show", `${argv[split + 1]}:CLAUDE.md`);
    const allowAt = argv.indexOf("--allow");
    const allowed = new Set(
      allowAt === -1
        ? []
        : readFileSync(argv[allowAt + 1], "utf8")
            .split("\n")
            .map((l) => l.split(" :: ")[0].trim())
            .filter((l) => l && !l.startsWith("#")),
    );
    const claudeText = [...docs.values()].join("\n").replaceAll("\\|", "|");
    const docText = files.filter((f) => /^docs\/.*\.md$|^GLOSSARY\.md$|^README\.md$/.test(f)).map((f) => readFileSync(f, "utf8")).join("\n");
    const moved = [];
    for (const token of tokensOf(old)) {
      if (allowed.has(token)) continue;
      const adr = /^ADR (\d{4})$/.exec(token);
      if (adr ? new RegExp(`\\b${adr[1]}\\b`).test(claudeText) : claudeText.includes(token)) continue;
      const path = pathOf(token);
      const hit = path === null ? null : resolvePath(path, "", entries);
      if (hit !== null && mentioned.has(hit)) continue;
      if (docText.includes(token)) moved.push(token);
      else problems.push(`MISSING ${token}`);
    }
    const lines = claudeText.split("\n");
    for (const rule of ruleKeys(old)) {
      const id = ruleId(rule);
      if (!allowed.has(id) && !ruleKept(rule, lines)) problems.push(`RULE_LOST ${id}    <- ${rule.clause.slice(0, 140)}`);
    }
    for (const token of moved) process.stdout.write(`MOVED_TO_DOC ${token}\n`);
  }

  for (const problem of [...new Set(problems)]) process.stdout.write(`${problem}\n`);
  if (problems.length > 0) {
    process.stdout.write(`${new Set(problems).size} problem(s)\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
