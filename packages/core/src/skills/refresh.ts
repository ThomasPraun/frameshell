import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeTextAtomic } from "../fs-util.js";
import { AGENT_SKILLS_DIR } from "../plugins/skills.js";
import { CORE_SKILL_FILES, SHIPPED_SKILL_HASHES } from "./core-skill.js";
import { CORE_SKILL_NAME } from "./install.js";

/**
 * Keeping a project's copy of the core skill current (#396). The copy is the project's (it may be
 * committed and tuned), so only a copy whose every Frameshell file is a version Frameshell shipped
 * is replaced; an edited one is reported and left alone unless forced. Files the person added
 * (names Frameshell never shipped) always stay.
 */

/** How a project's copy of the core skill compares with the bundled one. */
export interface CoreSkillState {
  /**
   * `current`: same as the bundled skill. `outdated`: an older shipped version, unedited (safe to update).
   * `edited`: some Frameshell file differs from every shipped version. `absent`: no copy (deleted or `--no-skill`).
   */
  state: "current" | "outdated" | "edited" | "absent";
  /** Project-relative directory of the copy. */
  dir: string;
  /** Files of the copy (relative to `dir`) that differ from every shipped version. */
  edited: string[];
}

/** Result of {@link refreshCoreSkill}. */
export interface CoreSkillRefresh extends CoreSkillState {
  /** Files written, relative to `dir`. */
  written: string[];
  /** Files removed (shipped before, gone from the bundle, unedited), relative to `dir`. */
  removed: string[];
}

const SKILL_DIR = `${AGENT_SKILLS_DIR}/${CORE_SKILL_NAME}`;

/** Compare the copy in project `root` with the bundled skill. Never throws for an unreadable file: it counts as edited. */
export async function coreSkillState(root: string): Promise<CoreSkillState> {
  const base = join(root, ...SKILL_DIR.split("/"));
  if (!(await isDirectory(base))) return { state: "absent", dir: SKILL_DIR, edited: [] };
  const copy = await readCopy(base);
  const edited: string[] = [];
  let same = true;
  for (const [file, text] of copy) {
    const shipped = SHIPPED_SKILL_HASHES[file];
    if (!shipped) continue;
    if (text === null || !shipped.includes(sha256(text))) edited.push(file);
    if (CORE_SKILL_FILES[file] !== text) same = false;
  }
  for (const file of Object.keys(CORE_SKILL_FILES)) if (!copy.has(file)) same = false;
  const state = edited.length > 0 ? "edited" : same ? "current" : "outdated";
  return { state, dir: SKILL_DIR, edited: edited.sort() };
}

/**
 * Bring the copy in `root` to the bundled skill when it is `outdated`; with `force` also when `edited`
 * (shipped file names only: added files stay). An absent copy stays absent.
 */
export async function refreshCoreSkill(root: string, options: { force?: boolean } = {}): Promise<CoreSkillRefresh> {
  const before = await coreSkillState(root);
  const none = { ...before, written: [], removed: [] };
  if (before.state === "absent" || before.state === "current" || (before.state === "edited" && options.force !== true)) return none;
  const base = join(root, ...SKILL_DIR.split("/"));
  const copy = await readCopy(base);
  const written: string[] = [];
  const removed: string[] = [];
  for (const [file, text] of Object.entries(CORE_SKILL_FILES)) {
    if (copy.get(file) === text) continue;
    const path = join(base, ...file.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeTextAtomic(path, text);
    written.push(file);
  }
  for (const [file, text] of copy) {
    // Shipped once, gone now: removed only while unedited, so a person's change is never lost.
    if (file in CORE_SKILL_FILES || !SHIPPED_SKILL_HASHES[file] || text === null || !SHIPPED_SKILL_HASHES[file]!.includes(sha256(text))) continue;
    await rm(join(base, ...file.split("/")), { force: true });
    removed.push(file);
  }
  return { ...(await coreSkillState(root)), written: written.sort(), removed: removed.sort() };
}

/** Every regular file of the copy, relative path to text with LF line ends (null when unreadable). */
async function readCopy(base: string): Promise<Map<string, string | null>> {
  const files = new Map<string, string | null>();
  const entries = await readdir(base, { recursive: true, withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const rel = path.slice(base.length + 1).split(/[\\/]/).join("/");
    files.set(rel, await readFile(path, "utf8").then((text) => text.replace(/\r\n/g, "\n"), () => null));
  }
  return files;
}

async function isDirectory(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => null))?.isDirectory() ?? false;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
