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

/** The Start menu name the ChatGPT desktop app shows under. */
const CHATGPT_START_NAME = "ChatGPT";

/** Exit code of the Windows script when no Start menu app has the name. */
const WINDOWS_MISSING = 3;

/**
 * Looks the app up in the Start menu by name and starts it the way the shell does. Browser-installed web apps (Edge,
 * Chrome PWAs) show up under the same name, so those AppIDs are skipped; the Store package (AppID has "!") wins over a
 * classic install. The name is a fixed string, never user input.
 */
const WINDOWS_START_SCRIPT = `$apps = @(Get-StartApps | Where-Object { $_.Name -eq '${CHATGPT_START_NAME}' -and $_.AppID -notmatch 'msedge|chrome|brave|vivaldi|opera|firefox' })
$app = $apps | Where-Object { $_.AppID -like '*!*' } | Select-Object -First 1
if (-not $app) { $app = $apps | Select-Object -First 1 }
if ($app) { Start-Process ('shell:AppsFolder\\' + $app.AppID); exit 0 }
exit ${WINDOWS_MISSING}`;

/** PowerShell `-EncodedCommand` takes the script as UTF-16LE base64. */
const encodePowerShell = (script: string) => Buffer.from(script, "utf16le").toString("base64");

/** Exit code of the macOS script when no ChatGPT app is installed. */
const MAC_MISSING = 1;

/**
 * Finds an application named ChatGPT and opens it, skipping browser-made web apps (Chrome Apps, Edge Apps folders)
 * that carry the same name.
 */
const MAC_START_SCRIPT = `app=$(mdfind 'kMDItemContentType == "com.apple.application-bundle" && kMDItemFSName == "ChatGPT.app"' | grep -v -i -E '/(Chrome|Edge|Brave|Arc) Apps|/Chrome Apps.localized/' | head -n 1)
[ -n "$app" ] || exit ${MAC_MISSING}
exec open "$app"`;

/**
 * How `id` starts on `platform`; null where the app does not exist. Claude Desktop registers the `claude:` URL
 * protocol. OpenAI documents no URL scheme for the ChatGPT desktop app, so it is started by its name: Start menu
 * on Windows, Spotlight lookup then `open` on macOS. It has no Linux build, so Linux has no plan.
 */
export function launchPlan(id: DesktopAppId, platform: NodeJS.Platform): LaunchPlan | null {
  if (id === "claude-desktop") return platform === "darwin" || platform === "win32" ? { kind: "url", url: "claude://" } : null;
  if (platform === "win32") {
    return {
      kind: "command",
      file: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(WINDOWS_START_SCRIPT)],
      wait: true,
      missing: WINDOWS_MISSING,
    };
  }
  if (platform === "darwin") return { kind: "command", file: "/bin/sh", args: ["-c", MAC_START_SCRIPT], wait: true, missing: MAC_MISSING };
  return null;
}

/** What starting a plan came to. */
export type LaunchResult = { ok: true } | { ok: false; problem: { kind: "not-found" } | { kind: "failed"; message: string } };

/** Starts plans; swapped for a recorder in e2e. */
export type Launcher = (plan: LaunchPlan) => Promise<LaunchResult>;

/** How long a waited-for command may take before it counts as failed, ms. */
const LAUNCH_TIMEOUT_MS = 20_000;

/**
 * The real launcher: `openExternal` for URLs, a detached child for commands. `handlerFor` names the app registered
 * for a URL (empty: none), checked first because `openExternal` can resolve without any app there.
 */
export function systemLauncher(openExternal: (url: string) => Promise<void>, handlerFor: (url: string) => string): Launcher {
  return async (plan) => {
    if (plan.kind === "url") {
      if (!handlerFor(plan.url)) return { ok: false, problem: { kind: "not-found" } };
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
