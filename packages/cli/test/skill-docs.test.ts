import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ErrorCode } from "@frameshell/protocol";
import { RESOURCE_TEMPLATES, buildTools } from "@frameshell/mcp";
import { GLOBAL_FLAGS, cliCommands } from "../src/index.js";

// Agent skills are only as good as their names: every command, flag, MCP tool, resource and error code a skill
// names must exist, so a renamed or removed one fails here instead of misleading an agent.
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const coreSkill = join(repo, "skills", "frameshell");

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".md"))
    .map((file) => join(dir, file));
}

const pluginDirs = readdirSync(join(repo, "plugins")).map((name) => join(repo, "plugins", name));
const skillFiles = [
  ...markdownFiles(coreSkill),
  ...pluginDirs.flatMap((dir) => {
    try {
      return markdownFiles(join(dir, "skills"));
    } catch {
      return [];
    }
  }),
];

/** Plugin commands (`hyperframes new`) from the official plugins' manifests. */
const pluginCommands = new Set(
  pluginDirs.flatMap((dir) => {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, "frameshell-plugin.json"), "utf8")) as { contributes?: { commands?: string[] } };
      return manifest.contributes?.commands ?? [];
    } catch {
      return [];
    }
  }),
);

/** Inline code spans and fenced code lines of a Markdown file, with where they came from. */
function snippets(file: string): { text: string; where: string }[] {
  const out: { text: string; where: string }[] = [];
  const name = relative(repo, file);
  let fenced = false;
  readFileSync(file, "utf8")
    .split(/\r?\n/)
    .forEach((line, index) => {
      const where = `${name}:${index + 1}`;
      if (line.trimStart().startsWith("```")) {
        fenced = !fenced;
        return;
      }
      if (fenced) {
        out.push({ text: line, where });
        return;
      }
      // Escaped pipes belong to table cells.
      for (const match of line.replace(/\\\|/g, "|").matchAll(/`([^`]+)`/g)) out.push({ text: match[1]!, where });
    });
  return out;
}

const all = skillFiles.flatMap(snippets);
const commands = cliCommands();
const globalFlags = new Set<string>(GLOBAL_FLAGS);
const anyFlag = new Set([...globalFlags, ...[...commands.values()].flat()]);

/** Every `frameshell <command> …` invocation in `text`, with the flags that follow it. */
function invocations(text: string): { command: string; flags: string[]; plugin: boolean }[] {
  const found: { command: string; flags: string[]; plugin: boolean }[] = [];
  const parts = text.split(/(?<![\w@/.:=-])frameshell(?=\s)/).slice(1);
  for (const part of parts) {
    const words = part.trim().split(/\s+/);
    const [first, second] = words;
    if (!first || !/^[a-z]/.test(first)) continue; // `frameshell --help`, `frameshell <plugin> …`
    const two = `${first} ${second ?? ""}`;
    const command = commands.has(two) ? two : commands.has(first) ? first : pluginCommands.has(two) ? two : null;
    const flags = [...part.matchAll(/(?:^|[\s[(|])--([a-z][a-z0-9-]*)/g)].map((match) => match[1]!);
    found.push({ command: command ?? two.trim(), flags, plugin: command !== null && pluginCommands.has(command) });
  }
  return found;
}

describe("agent skills name only what exists", () => {
  it("finds the skills to check", () => {
    expect(skillFiles.map((file) => relative(repo, file).split("\\").join("/"))).toEqual(
      expect.arrayContaining(["skills/frameshell/SKILL.md", "plugins/hyperframes/skills/hyperframes/SKILL.md"]),
    );
  });

  it("every documented `frameshell` command exists and takes the flags shown", () => {
    const problems: string[] = [];
    for (const { text, where } of all) {
      for (const { command, flags, plugin } of invocations(text)) {
        const allowed = commands.get(command);
        if (!allowed && !plugin) {
          problems.push(`${where}: \`frameshell ${command}\` is not a command`);
          continue;
        }
        if (plugin) continue; // Plugins parse their own flags.
        for (const flag of flags) {
          if (!allowed!.includes(flag) && !globalFlags.has(flag)) problems.push(`${where}: \`frameshell ${command}\` takes no --${flag}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("every documented flag exists on some command", () => {
    const problems = all
      .filter(({ text }) => text.startsWith("--"))
      .flatMap(({ text, where }) =>
        [...text.matchAll(/(?:^|\s)--([a-z][a-z0-9-]*)/g)].map((m) => m[1]!).filter((flag) => !anyFlag.has(flag)).map((flag) => `${where}: --${flag}`),
      );
    expect(problems).toEqual([]);
  });

  it("every documented MCP tool, resource and error code exists", () => {
    const tools = new Set(buildTools(repo).map((tool) => tool.name));
    // Snake case alone is not a tool name (`target_duration` is frontmatter): its first word must start one.
    const groups = new Set([...tools].map((name) => name.split("_")[0]!));
    const codes = new Set(Object.keys(ErrorCode));
    const problems: string[] = [];
    for (const { text, where } of all) {
      const tool = /^([a-z]+(?:_[a-z]+)+)(?=$|[\s({])/.exec(text)?.[1];
      if (tool && groups.has(tool.split("_")[0]!) && !tools.has(tool)) problems.push(`${where}: MCP tool \`${tool}\``);
      const uri = /^frameshell:\/\/\S+/.exec(text)?.[0];
      if (uri && !RESOURCE_TEMPLATES.includes(uri)) problems.push(`${where}: MCP resource \`${uri}\``);
      if (/^[A-Z][a-z]+(?:[A-Z][a-z]*)+$/.test(text) && !codes.has(text)) problems.push(`${where}: error code \`${text}\``);
    }
    expect(problems).toEqual([]);
  });

  it("the core skill covers every CLI command", () => {
    const documented = new Set(markdownFiles(coreSkill).flatMap(snippets).flatMap(({ text }) => invocations(text).map((i) => i.command)));
    expect([...commands.keys()].filter((command) => !documented.has(command))).toEqual([]);
  });
});
