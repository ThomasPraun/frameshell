import { execFile } from "node:child_process";
import { lstat, mkdir, readlink, rename, rm, symlink } from "node:fs/promises";
import { dirname, join, resolve, win32 } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * The system the install talks to. Injected so tests never touch the real
 * PATH, registry or admin prompt; {@link systemCliInstallHost} is the real one.
 */
export interface CliInstallHost {
  platform: NodeJS.Platform;
  /** Directory of the `frameshell` link (macOS, Linux). Windows adds the shim's own directory to PATH instead. */
  linkDir?: string;
  /** PATH the app runs with. Linux warns when `linkDir` is missing from it. */
  path: string;
  /** Asks whether to replace a `frameshell` command that another install put at `link`. */
  confirmReplace(link: string, target: string): Promise<boolean>;
  /** Runs a `sh` script as administrator. Rejects when the user cancels the prompt. */
  runAsAdmin(script: string): Promise<void>;
  /** Raw (unexpanded) user PATH on Windows. */
  readUserPath(): Promise<string>;
  /** Replaces the user PATH on Windows and tells running programs it changed. */
  writeUserPath(value: string): Promise<void>;
}

/** What an install or uninstall did, worded for a message box. */
export interface CliInstallOutcome {
  /** False when nothing changed: the user declined, or the command was not ours. */
  changed: boolean;
  message: string;
  detail?: string;
}

/**
 * Where the system-wide `frameshell` link goes: `/usr/local/bin` on macOS
 * (on every shell's PATH, may need admin), `~/.local/bin` on Linux (XDG user
 * bin, no admin). Undefined on Windows, which puts the shim's directory on
 * the user PATH instead.
 */
export function cliLinkDir(platform: NodeJS.Platform, home: string): string | undefined {
  if (platform === "darwin") return "/usr/local/bin";
  if (platform === "win32") return undefined;
  return join(home, ".local", "bin");
}

/**
 * Why this app copy cannot back a system-wide command, or undefined when it
 * can. The shim calls the app's own binary, so it must stay put: an AppImage
 * mounts at a new path on every start, and a macOS app run from its disk
 * image or quarantined in Downloads runs from a temporary path
 * (App Translocation).
 */
export function cliInstallBlocker(
  platform: NodeJS.Platform,
  execPath: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (platform === "linux" && env["APPIMAGE"]) {
    return "The AppImage runs from a different path on every start. Install the .deb package to use 'frameshell' outside the app.";
  }
  if (platform === "darwin" && (execPath.startsWith("/Volumes/") || execPath.includes("/AppTranslocation/"))) {
    return "Frameshell is running from a temporary location. Move it to the Applications folder, open it from there, and try again.";
  }
  return undefined;
}

/**
 * Makes `shim` (written by `writeCliShim` on every app start) callable as
 * `frameshell` from any terminal. The shim's path never changes across app
 * updates, so neither does the link. A command another install owns is
 * replaced only after {@link CliInstallHost.confirmReplace}; a regular file is
 * never replaced.
 */
export async function installCli(shim: string, host: CliInstallHost): Promise<CliInstallOutcome> {
  if (host.platform === "win32") {
    const dir = win32.dirname(shim);
    const current = await host.readUserPath();
    const next = addPathEntry(current, dir);
    if (next === current) return { changed: false, message: "The 'frameshell' command is already on your PATH." };
    await host.writeUserPath(next);
    return {
      changed: true,
      message: "Added the 'frameshell' command to your PATH.",
      detail: `${dir} is now on your user PATH. Terminals opened before this keep their old PATH: open a new one.`,
    };
  }
  const link = join(requireLinkDir(host), "frameshell");
  const existing = await inspectLink(link, shim);
  if (existing.kind === "file") throw new Error(`${link} exists and is not a link. Remove it, then install again.`);
  if (existing.kind === "ours" && existing.target === shim) {
    return { changed: false, message: `The 'frameshell' command is already installed at ${link}.` };
  }
  if (existing.kind === "foreign" && !(await host.confirmReplace(link, existing.target))) {
    return { changed: false, message: "The 'frameshell' command was left as it was." };
  }
  await withAdminFallback(host, `mkdir -p ${shQuote(dirname(link))} && ln -sfn ${shQuote(shim)} ${shQuote(link)}`, () =>
    replaceLink(link, shim),
  );
  const onPath = host.path.split(":").includes(dirname(link));
  return {
    changed: true,
    message: `Installed the 'frameshell' command at ${link}.`,
    ...(host.platform === "linux" && !onPath
      ? { detail: `${dirname(link)} is not on your PATH: add it in your shell profile.` }
      : {}),
  };
}

/**
 * Undoes {@link installCli}. Removes the link only when it points at a shim
 * of this app's data directory, so a `frameshell` from another install (npm,
 * a source checkout) is never removed.
 */
export async function uninstallCli(shim: string, host: CliInstallHost): Promise<CliInstallOutcome> {
  if (host.platform === "win32") {
    const current = await host.readUserPath();
    const next = removePathEntry(current, win32.dirname(shim));
    if (next === current) return { changed: false, message: "The 'frameshell' command is not on your PATH." };
    await host.writeUserPath(next);
    return { changed: true, message: "Removed the 'frameshell' command from your PATH." };
  }
  const link = join(requireLinkDir(host), "frameshell");
  const existing = await inspectLink(link, shim);
  if (existing.kind === "missing") return { changed: false, message: `No 'frameshell' command at ${link}.` };
  if (existing.kind !== "ours") {
    return { changed: false, message: `${link} was not installed by Frameshell: left in place.` };
  }
  await withAdminFallback(host, `rm -f ${shQuote(link)}`, () => rm(link, { force: true }));
  return { changed: true, message: `Removed the 'frameshell' command from ${link}.` };
}

/**
 * Adds `dir` to a `;`-separated Windows PATH unless already there. Entries
 * compare case-insensitively and ignore a trailing backslash, as Windows does.
 */
export function addPathEntry(path: string, dir: string): string {
  const entries = path.split(";").filter((entry) => entry !== "");
  if (entries.some((entry) => samePathEntry(entry, dir))) return path;
  return [...entries, dir].join(";");
}

/** Removes every occurrence of `dir` from a `;`-separated Windows PATH; returns `path` unchanged when absent. */
export function removePathEntry(path: string, dir: string): string {
  const entries = path.split(";");
  const kept = entries.filter((entry) => !samePathEntry(entry, dir));
  return kept.length === entries.length ? path : kept.filter((entry) => entry !== "").join(";");
}

/**
 * The real host: macOS asks for the admin password with the native prompt
 * (`osascript … with administrator privileges`), Windows edits
 * `HKCU\Environment\Path` through PowerShell, keeping `%VAR%` references.
 */
export function systemCliInstallHost(options: {
  home: string;
  confirmReplace: CliInstallHost["confirmReplace"];
}): CliInstallHost {
  const platform = process.platform;
  const linkDir = cliLinkDir(platform, options.home);
  return {
    platform,
    ...(linkDir ? { linkDir } : {}),
    path: process.env["PATH"] ?? "",
    confirmReplace: options.confirmReplace,
    runAsAdmin: async (script) => {
      try {
        await run("osascript", ["-e", `do shell script "${appleScriptString(script)}" with administrator privileges`]);
      } catch (error) {
        // -128: the user cancelled the password prompt.
        if (String((error as { stderr?: unknown }).stderr).includes("(-128)")) {
          throw new Error("Cancelled at the password prompt.", { cause: error });
        }
        throw error;
      }
    },
    readUserPath: async () => {
      const { stdout } = await powershell(
        "[Console]::OutputEncoding = [Text.Encoding]::UTF8; " +
          "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment'); " +
          "if ($key) { [Console]::Out.Write($key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')) }",
      );
      return stdout;
    },
    writeUserPath: async (value) => {
      // The value travels in the environment, so no quoting. Setting a user variable through .NET broadcasts
      // WM_SETTINGCHANGE, which Explorer and new terminals need to see the new PATH.
      await powershell(
        "$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment'); " +
          "$key.SetValue('Path', $env:FRAMESHELL_USER_PATH, 'ExpandString'); " +
          "[Environment]::SetEnvironmentVariable('FRAMESHELL_PATH_REFRESH', '1', 'User'); " +
          "[Environment]::SetEnvironmentVariable('FRAMESHELL_PATH_REFRESH', $null, 'User')",
        { FRAMESHELL_USER_PATH: value },
      );
    },
  };
}

type LinkState =
  | { kind: "missing" }
  /** A link to a shim of this app's data directory: this build's, or a dev or packaged build's sibling. */
  | { kind: "ours"; target: string }
  | { kind: "foreign"; target: string }
  | { kind: "file" };

async function inspectLink(link: string, shim: string): Promise<LinkState> {
  const stat = await lstat(link).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stat) return { kind: "missing" };
  if (!stat.isSymbolicLink()) return { kind: "file" };
  const target = resolve(dirname(link), await readlink(link));
  const dataDir = dirname(dirname(shim));
  return dirname(dirname(target)) === dataDir && target.endsWith("frameshell")
    ? { kind: "ours", target }
    : { kind: "foreign", target };
}

/** Swaps the link in one rename, so a failure never leaves `link` missing. */
async function replaceLink(link: string, shim: string): Promise<void> {
  await mkdir(dirname(link), { recursive: true });
  const temp = `${link}.${process.pid}.tmp`;
  await rm(temp, { force: true });
  await symlink(shim, temp);
  try {
    await rename(temp, link);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** Runs `direct`; on macOS, when the directory is not writable, runs `script` as administrator instead. */
async function withAdminFallback(host: CliInstallHost, script: string, direct: () => Promise<unknown>): Promise<void> {
  try {
    await direct();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (host.platform !== "darwin" || (code !== "EACCES" && code !== "EPERM")) throw error;
    await host.runAsAdmin(script);
  }
}

function requireLinkDir(host: CliInstallHost): string {
  if (!host.linkDir) throw new Error(`No link directory for ${host.platform}.`);
  return host.linkDir;
}

function samePathEntry(entry: string, dir: string): boolean {
  const normalize = (value: string) => value.trim().replace(/\\+$/, "").toLowerCase();
  return normalize(entry) === normalize(dir);
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function appleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function powershell(command: string, env: Record<string, string> = {}) {
  return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    env: { ...process.env, ...env },
    windowsHide: true,
  });
}
