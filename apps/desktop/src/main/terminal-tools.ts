import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BinaryLocation, ProjectBinaries } from "@frameshell/core/binaries";
import type { TerminalTool } from "./terminal-launch.js";

/** Native tools an agent in an app terminal may run by hand: probing levels, re-transcribing an excerpt. */
export const TERMINAL_TOOLS = ["ffmpeg", "ffprobe", "whisper-cli"] as const;

/** The one `BinaryManager` call {@link terminalToolPaths} needs; tests pass a fake. */
export interface ToolLocator {
  locate(tool: string, project?: ProjectBinaries): Promise<BinaryLocation>;
}

/**
 * Tools of {@link TERMINAL_TOOLS} that are installed, by name: the same binary
 * the daemon runs (managed download, or a `binaries` override from the
 * project's `frameshell.json` or the global config, flagged `managed: false`).
 * Never downloads. Missing tools are left out; an unreadable config
 * leaves out every tool rather than failing the terminal.
 */
export async function terminalToolPaths(locator: ToolLocator, projectDir: string): Promise<Record<string, TerminalTool>> {
  const project: ProjectBinaries = { dir: projectDir, binaries: await projectBinaries(projectDir) };
  const paths: Record<string, TerminalTool> = {};
  for (const tool of TERMINAL_TOOLS) {
    try {
      const location = await locator.locate(tool, project);
      if (location.installed && location.path) paths[tool] = { path: location.path, managed: location.source === "managed" };
    } catch {
      // Malformed global config: the daemon reports it on first use; the terminal still opens.
    }
  }
  return paths;
}

/** `binaries` of `frameshell.json` when it is a string map; otherwise none (the daemon validates the file). */
async function projectBinaries(projectDir: string): Promise<Record<string, string> | undefined> {
  try {
    const { binaries } = JSON.parse(await readFile(join(projectDir, "frameshell.json"), "utf8")) as { binaries?: unknown };
    if (typeof binaries !== "object" || binaries === null || Array.isArray(binaries)) return undefined;
    const entries = Object.entries(binaries);
    return entries.every(([, value]) => typeof value === "string") ? (Object.fromEntries(entries) as Record<string, string>) : undefined;
  } catch {
    return undefined;
  }
}
