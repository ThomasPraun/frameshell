// Files `project.init` writes beside the core skill so every agent CLI finds its way in (#186). Never overwritten.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { exists } from "../fs-util.js";
import { AGENT_SKILLS_DIR } from "../plugins/skills.js";
import { CORE_SKILL_NAME } from "./install.js";

/**
 * Project instructions for agents that read `AGENTS.md` (Codex, OpenCode,
 * Pi…) or `GEMINI.md` (Gemini CLI). Claude Code loads the skill itself.
 */
export const AGENT_INSTRUCTIONS = `# Frameshell project

This folder is a Frameshell video project. Change it with the \`frameshell\` command (\`frameshell --help\`) or the Frameshell MCP tools, not by editing its files by hand.

Before the first change, read \`${AGENT_SKILLS_DIR}/${CORE_SKILL_NAME}/SKILL.md\`: it explains the project, the editing commands, and how the person reviews and corrects your work.

- Never edit, move or delete the media in \`assets/\`. They are the person's footage; write new files instead.
- Every change is recorded. \`frameshell history\` lists them, and \`frameshell revert\` undoes one.
`;

/**
 * Claude Code project settings: Frameshell's own commands and MCP tools run
 * without a prompt, deleting files always asks. People new to agents tend to
 * approve every prompt; these keep the prompts for what can lose work.
 */
export const CLAUDE_SETTINGS = {
  permissions: {
    allow: ["Bash(frameshell *)", "mcp__frameshell"],
    ask: ["Bash(rm *)"],
  },
};

/** Project-relative path → content of each agent file. */
const AGENT_FILES: Record<string, string> = {
  "AGENTS.md": AGENT_INSTRUCTIONS,
  "GEMINI.md": AGENT_INSTRUCTIONS,
  ".claude/settings.json": `${JSON.stringify(CLAUDE_SETTINGS, null, 2)}\n`,
};

/**
 * Write the agent files into the project at `root`, each only when absent:
 * the user's own files win. Returns the project-relative paths written.
 */
export async function installAgentFiles(root: string): Promise<string[]> {
  const written: string[] = [];
  for (const [rel, content] of Object.entries(AGENT_FILES)) {
    const path = join(root, ...rel.split("/"));
    if (await exists(path)) continue;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
    written.push(rel);
  }
  return written;
}
