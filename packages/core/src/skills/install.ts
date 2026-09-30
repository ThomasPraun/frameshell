import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { exists } from "../fs-util.js";
import { AGENT_SKILLS_DIR } from "../plugins/skills.js";
import { CORE_SKILL_FILES } from "./core-skill.js";

/** Name, and directory under {@link AGENT_SKILLS_DIR}, of the core agent skill. */
export const CORE_SKILL_NAME = "frameshell";

/**
 * Write the core `frameshell` agent skill into the project at `root`, where
 * agents load it. A copy, not a link: the project owns it, can commit it
 * and tune it. An existing skill of that name is kept as is.
 * Returns the project-relative files written; empty when kept.
 */
export async function installCoreSkill(root: string): Promise<string[]> {
  const base = `${AGENT_SKILLS_DIR}/${CORE_SKILL_NAME}`;
  if (await exists(join(root, ...base.split("/")))) return [];
  const written: string[] = [];
  for (const [file, content] of Object.entries(CORE_SKILL_FILES)) {
    const path = join(root, ...base.split("/"), ...file.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
    written.push(`${base}/${file}`);
  }
  return written;
}
