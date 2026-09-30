import { lstat, mkdir, readdir, readlink, rm, symlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

/**
 * Project-relative directory agents load skills from, one sub-directory per
 * skill holding `SKILL.md` (Claude Code's layout; other agents read it too).
 */
export const AGENT_SKILLS_DIR = ".claude/skills";

/** One skill a loaded plugin ships. */
export interface PluginSkill {
  plugin: string;
  /** Absolute path of its `SKILL.md`. */
  file: string;
}

/** Outcome of {@link syncPluginSkills}. Paths are project-relative and `/`-separated. */
export interface SkillSync {
  /** Every skill link that exists now, by plugin. */
  linked: Array<{ plugin: string; path: string }>;
  /** Links removed because no loaded plugin ships them any more. */
  removed: string[];
  /** Skills not linked: the name is taken by an entry the user owns or by another plugin. */
  warnings: Array<{ plugin: string; message: string }>;
}

/**
 * Make the project's skills directory hold one link per skill in `skills`
 * (SPEC §8.2), named after the directory holding `SKILL.md`, and no other
 * link into the project's plugin install directory. Entries the user owns
 * (real directories, links elsewhere) are never touched.
 *
 * Links are relative, so they survive moving or cloning the project; on
 * Windows they are junctions, which need no privilege.
 */
export async function syncPluginSkills(root: string, skills: readonly PluginSkill[]): Promise<SkillSync> {
  const dir = join(root, ...AGENT_SKILLS_DIR.split("/"));
  const store = join(root, ".frameshell", "plugins");
  const rel = (name: string) => `${AGENT_SKILLS_DIR}/${name}`;
  const result: SkillSync = { linked: [], removed: [], warnings: [] };

  const wanted = new Map<string, PluginSkill>();
  for (const skill of skills) {
    const name = basename(dirname(skill.file));
    const other = wanted.get(name);
    if (other) {
      result.warnings.push({ plugin: skill.plugin, message: `Skill ${rel(name)} of ${skill.plugin} not linked: ${other.plugin} ships one with that name.` });
      continue;
    }
    wanted.set(name, skill);
  }

  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const target = await ownedTarget(join(dir, name), store);
    if (target === null) continue;
    const skill = wanted.get(name);
    if (skill && samePath(target, dirname(skill.file))) continue;
    await rm(join(dir, name), { force: true });
    if (!skill) result.removed.push(rel(name));
  }

  for (const [name, skill] of wanted) {
    const link = join(dir, name);
    const existing = await lstat(link).catch(() => null);
    if (existing && (await ownedTarget(link, store)) === null) {
      result.warnings.push({
        plugin: skill.plugin,
        message: `Skill ${rel(name)} of ${skill.plugin} not linked: the project already has ${rel(name)}. Rename or remove it to use the plugin's.`,
      });
      continue;
    }
    if (!existing) {
      await mkdir(dir, { recursive: true });
      await symlink(relative(dir, dirname(skill.file)), link, "junction");
    }
    result.linked.push({ plugin: skill.plugin, path: rel(name) });
  }
  return result;
}

/** Absolute target of `path` when it is a link into `store`; null for anything else. */
async function ownedTarget(path: string, store: string): Promise<string | null> {
  const stat = await lstat(path).catch(() => null);
  if (!stat?.isSymbolicLink()) return null;
  // Junctions read back absolute and `\\?\`-prefixed.
  const raw = (await readlink(path)).replace(/^\\\\\?\\/, "");
  const target = resolve(dirname(path), raw);
  return samePath(target, store) || isInside(target, store) ? target : null;
}

function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel);
}

function samePath(a: string, b: string): boolean {
  return relative(a, b) === "";
}
