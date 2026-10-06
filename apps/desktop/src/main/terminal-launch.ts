import { posix, win32 } from "node:path";

/** Inputs for {@link terminalLaunch}. */
export interface TerminalLaunchOptions {
  platform: NodeJS.Platform;
  /** Environment the app was started with. */
  env: NodeJS.ProcessEnv;
  /** Project root: shell cwd and `FRAMESHELL_PROJECT`. */
  projectDir: string;
  /** Daemon endpoint the app uses: `FRAMESHELL_SOCKET`. */
  socketPath: string;
  /** Terminal session id: `FRAMESHELL_SESSION`, attributes CLI calls to this terminal. */
  session: string;
  /** Directory holding the `frameshell` shim; prepended to PATH. */
  binDir: string;
  /**
   * Installed native tools the daemon runs, name to absolute executable
   * (`terminalToolPaths` in `terminal-tools.ts`). Each one's directory goes on PATH after
   * `binDir`, and its path into `FRAMESHELL_<NAME>` (`whisper-cli` →
   * `FRAMESHELL_WHISPER_CLI`): login profiles may reorder PATH, the variable
   * stays exact.
   */
  tools?: Readonly<Record<string, string>>;
}

/** How to spawn one terminal's shell. */
export interface TerminalLaunch {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/** Set by Electron for its own child processes; leaking them breaks Electron apps and Node tools run from the shell. */
const ELECTRON_ONLY_VARS = ["ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE"];

/**
 * Shell command and environment for a terminal (SPEC §3.2). Unix gets the
 * user's login shell (`-l`, so profile PATH additions such as nvm or Homebrew apply);
 * Windows gets PowerShell.
 */
export function terminalLaunch(options: TerminalLaunchOptions): TerminalLaunch {
  const { platform, projectDir } = options;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.env)) {
    if (value !== undefined && !ELECTRON_ONLY_VARS.includes(key)) env[key] = value;
  }
  // Windows env keys are case-insensitive: reuse whatever casing PATH already has.
  const pathKey = (platform === "win32" && Object.keys(env).find((key) => key.toUpperCase() === "PATH")) || "PATH";
  const delimiter = platform === "win32" ? ";" : ":";
  const tools = Object.entries(options.tools ?? {});
  const { dirname } = platform === "win32" ? win32 : posix;
  const prepend = [...new Set([options.binDir, ...tools.map(([, path]) => dirname(path))])].join(delimiter);
  env[pathKey] = env[pathKey] ? `${prepend}${delimiter}${env[pathKey]}` : prepend;
  for (const [name, path] of tools) env[toolVariable(name)] = path;
  Object.assign(env, {
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    TERM_PROGRAM: "Frameshell",
    FRAMESHELL_SOCKET: options.socketPath,
    FRAMESHELL_PROJECT: projectDir,
    FRAMESHELL_SESSION: options.session,
  });

  if (platform === "win32") return { file: "powershell.exe", args: ["-NoLogo"], cwd: projectDir, env };
  const shell = options.env["SHELL"] || (platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  return { file: shell, args: ["-l"], cwd: projectDir, env };
}

/** Environment variable holding `tool`'s absolute path: `whisper-cli` → `FRAMESHELL_WHISPER_CLI`. */
export function toolVariable(tool: string): string {
  return `FRAMESHELL_${tool.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}
