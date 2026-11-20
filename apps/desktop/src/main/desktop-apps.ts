// "Open Claude Desktop / ChatGPT" from Connect your AI: how each desktop app is started, per platform. The renderer
// only asks; the launch and the clipboard write happen here.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import type { DesktopAppId, DesktopAppOpened } from "../shared/api.js";

/** How to start an app: ask the OS to open a URL it registered, or run a command. */
export type LaunchPlan =
  | { kind: "url"; url: string }
  | {
      kind: "command";
      file: string;
      args: string[];
      /** Wait for the command to end and read its exit code; false: the command is the app itself, it keeps running. */
      wait: boolean;
      /** The exit code that says the app is not installed. */
      missing?: number;
    };

/** The Start menu name(s) the ChatGPT desktop app shows under, best match first (the older app is "ChatGPT Classic"). */
const CHATGPT_START_NAMES = ["ChatGPT", "ChatGPT Classic"];

/** Exit code of the Windows script when no Start menu app has the name. */
const WINDOWS_MISSING = 3;

/**
 * Looks the app up in the Start menu by name and starts it the way the shell does, so it works for the Store package
 * and for a classic install alike. Names are fixed strings above, never user input.
 */
const WINDOWS_START_SCRIPT = `$names = ${CHATGPT_START_NAMES.map((name) => `'${name}'`).join(", ")}
$apps = Get-StartApps
foreach ($name in $names) {
  $app = $apps | Where-Object { $_.Name -eq $name } | Select-Object -First 1
  if ($app) { Start-Process ('shell:AppsFolder\\' + $app.AppID); exit 0 }
}
exit ${WINDOWS_MISSING}`;

/**
 * How `id` starts on `platform`; null where the app does not exist. Claude Desktop registers the `claude:` URL
 * protocol. OpenAI documents no URL scheme for the ChatGPT desktop app, so it is started by its name: Start menu
 * on Windows, `open -a` on macOS, a `chatgpt` command on Linux (best effort).
 */
export function launchPlan(id: DesktopAppId, platform: NodeJS.Platform): LaunchPlan | null {
  if (id === "claude-desktop") return platform === "darwin" || platform === "win32" ? { kind: "url", url: "claude://" } : null;
  if (platform === "win32") {
    return { kind: "command", file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_START_SCRIPT], wait: true, missing: WINDOWS_MISSING };
  }
  if (platform === "darwin") return { kind: "command", file: "open", args: ["-a", "ChatGPT"], wait: true, missing: 1 };
  return { kind: "command", file: "chatgpt", args: [], wait: false };
}

/** What starting a plan came to. */
export type LaunchResult = { ok: true } | { ok: false; problem: { kind: "not-found" } | { kind: "failed"; message: string } };

/** Starts plans; swapped for a recorder in e2e. */
export type Launcher = (plan: LaunchPlan) => Promise<LaunchResult>;

/** How long a waited-for command may take before it counts as failed, ms. */
const LAUNCH_TIMEOUT_MS = 20_000;

/** The real launcher: `openExternal` for URLs (rejects when no app handles the scheme), a detached child for commands. */
export function systemLauncher(openExternal: (url: string) => Promise<void>): Launcher {
  return async (plan) => {
    if (plan.kind === "url") {
      return openExternal(plan.url).then(
        () => ({ ok: true }) as const,
        () => ({ ok: false, problem: { kind: "not-found" } }) as const,
      );
    }
    return new Promise<LaunchResult>((resolve) => {
      const child = spawn(plan.file, plan.args, { detached: true, stdio: "ignore", windowsHide: true });
      const timer = plan.wait ? setTimeout(() => settle({ ok: false, problem: { kind: "failed", message: "timed out" } }), LAUNCH_TIMEOUT_MS) : null;
      const settle = (result: LaunchResult) => {
        if (timer) clearTimeout(timer);
        resolve(result);
      };
      child.on("error", (error: NodeJS.ErrnoException) =>
        settle({ ok: false, problem: error.code === "ENOENT" ? { kind: "not-found" } : { kind: "failed", message: error.message } }),
      );
      if (plan.wait) {
        child.on("exit", (code) =>
          settle(code === 0 ? { ok: true } : code === plan.missing ? { ok: false, problem: { kind: "not-found" } } : { ok: false, problem: { kind: "failed", message: `exit code ${String(code)}` } }),
        );
      } else {
        child.on("spawn", () => {
          child.unref();
          settle({ ok: true });
        });
      }
    });
  };
}

/**
 * e2e stand-in (`FRAMESHELL_OPEN_APP_STAND_IN=<file>`): starts nothing, appends each plan to `<file>` as a JSON line
 * and succeeds; with `FRAMESHELL_OPEN_APP_STAND_IN_MISSING=1` the apps are reported as not installed.
 */
export function standInLauncher(file: string, missing: boolean): Launcher {
  return async (plan) => {
    appendFileSync(file, `${JSON.stringify(plan)}\n`);
    return missing ? { ok: false, problem: { kind: "not-found" } } : { ok: true };
  };
}

/** The longest starter phrase put on the clipboard. */
const MAX_PHRASE = 500;

/** Open desktop app `id`; after it was asked to open, `phrase` goes on the clipboard through `copy`. Never throws. */
export async function openDesktopApp(
  id: DesktopAppId,
  phrase: string,
  place: { platform: NodeJS.Platform; launch: Launcher; copy: (text: string) => void },
): Promise<DesktopAppOpened> {
  const plan = launchPlan(id, place.platform);
  if (!plan) return { opened: false, problem: { kind: "not-found" } };
  let result: LaunchResult;
  try {
    result = await place.launch(plan);
  } catch (error) {
    result = { ok: false, problem: { kind: "failed", message: (error as Error).message ?? String(error) } };
  }
  if (!result.ok) return { opened: false, problem: result.problem };
  const text = phrase.slice(0, MAX_PHRASE);
  if (!text.trim()) return { opened: true, copied: false };
  try {
    place.copy(text);
    return { opened: true, copied: true };
  } catch {
    return { opened: true, copied: false };
  }
}
