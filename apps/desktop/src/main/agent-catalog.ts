// Agent CLIs the agent panel offers (#190): which are installed, and how to start or install them.
import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { posix, win32 } from "node:path";
import type { AgentChoice } from "../shared/api.js";

/** An agent CLI the panel knows, by `id` (also the label `agent-detect.ts` gives its terminals). */
interface CatalogEntry {
  id: string;
  name: string;
  /** Command that starts it in a project's terminal. */
  command: string;
  /** Official install command per shell: `unix` for the login shell, `win32` for PowerShell. */
  install: { unix: string; win32: string };
  /** Runs shell commands without asking first: the panel says so. */
  unattended?: boolean;
}

/** In the order the panel lists them. Install commands as on frameshell.dev/agents (`website/src/i18n/en.ts`). */
export const AGENT_CATALOG: readonly CatalogEntry[] = [
  {
    id: "claude",
    name: "Claude Code",
    command: "claude",
    install: { unix: "curl -fsSL https://claude.ai/install.sh | bash", win32: "irm https://claude.ai/install.ps1 | iex" },
  },
  {
    id: "codex",
    name: "Codex",
    command: "codex",
    install: { unix: "curl -fsSL https://chatgpt.com/codex/install.sh | sh", win32: "irm https://chatgpt.com/codex/install.ps1 | iex" },
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    command: "gemini",
    install: { unix: "npm install -g @google/gemini-cli", win32: "npm install -g @google/gemini-cli" },
  },
  {
    id: "opencode",
    name: "OpenCode",
    command: "opencode",
    install: { unix: "curl -fsSL https://opencode.ai/install | bash", win32: "scoop install opencode" },
  },
  {
    id: "pi",
    name: "Pi",
    command: "pi",
    install: { unix: "curl -fsSL https://pi.dev/install.sh | sh", win32: "irm https://pi.dev/install.ps1 | iex" },
    unattended: true,
  },
];

/**
 * Directories an agent may be installed in that a GUI app's PATH can miss: npm and Bun globals, Homebrew, Claude
 * Code's native installer (`~/.local/bin`).
 */
export function extraAgentDirs(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string[] {
  if (platform === "win32") {
    const appData = env["APPDATA"] ?? win32.join(home, "AppData", "Roaming");
    return [win32.join(home, ".local", "bin"), win32.join(appData, "npm"), win32.join(home, ".bun", "bin")];
  }
  return [
    posix.join(home, ".local", "bin"),
    posix.join(home, ".claude", "local"),
    posix.join(home, ".npm-global", "bin"),
    posix.join(home, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
}

/** First `dirs` entry holding an executable `command` (with a Windows extension on Windows), or null. */
export async function findCommand(
  command: string,
  dirs: readonly string[],
  platform: NodeJS.Platform,
  exists: (file: string) => Promise<boolean> = executable,
): Promise<string | null> {
  const { join } = platform === "win32" ? win32 : posix;
  const names = platform === "win32" ? [".exe", ".cmd", ".bat"].map((ext) => command + ext) : [command];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) {
      const file = join(dir, name);
      if (await exists(file)) return file;
    }
  }
  return null;
}

/** The catalog with where each agent was found, searching `dirs` in order. */
export async function detectAgents(
  dirs: readonly string[],
  platform: NodeJS.Platform,
  exists?: (file: string) => Promise<boolean>,
): Promise<AgentChoice[]> {
  return Promise.all(
    AGENT_CATALOG.map(async (entry) => ({
      id: entry.id,
      name: entry.name,
      command: entry.command,
      install: platform === "win32" ? entry.install.win32 : entry.install.unix,
      unattended: entry.unattended === true,
      path: await findCommand(entry.command, dirs, platform, exists),
    })),
  );
}

/** Shell command running the program at `path`: PowerShell on Windows, a POSIX shell elsewhere. */
export function startCommand(path: string, platform: NodeJS.Platform): string {
  if (platform === "win32") return /\s/.test(path) ? `& "${path}"` : path;
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`;
}

/**
 * PATH of the user's login shell, which a terminal of the app gets: an app opened from the Dock or Finder starts
 * with a minimal PATH. Falls back to `fallback` when the shell fails or takes over 5 s (a profile waiting for input).
 */
export function loginShellPath(shell: string, fallback: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(shell, ["-l", "-c", 'printf "%s" "$PATH"'], { timeout: 5000, env: { ...process.env, TERM: "dumb" } }, (error, stdout) =>
      resolve(error || !stdout.trim() ? fallback : stdout.trim()),
    );
  });
}

async function executable(file: string): Promise<boolean> {
  try {
    await access(file, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
