import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHATGPT_MAC_BUNDLE_IDS, type LaunchPlan, type Launcher, launchPlan, openDesktopApp, standInLauncher, systemLauncher } from "../src/main/desktop-apps.js";

const recorder = (result: Awaited<ReturnType<Launcher>> = { ok: true }) => {
  const plans: LaunchPlan[] = [];
  const launch: Launcher = async (plan) => {
    plans.push(plan);
    return result;
  };
  return { plans, launch };
};

describe("launchPlan", () => {
  it("starts Claude Desktop through its claude: URL protocol on macOS and Windows, and has no plan on Linux", () => {
    expect(launchPlan("claude-desktop", "win32")).toEqual({ kind: "url", url: "claude://" });
    expect(launchPlan("claude-desktop", "darwin")).toEqual({ kind: "url", url: "claude://" });
    expect(launchPlan("claude-desktop", "linux")).toBeNull();
  });

  it("starts the ChatGPT desktop app by bundle id or name, since OpenAI documents no URL scheme", () => {
    const mac = launchPlan("chatgpt", "darwin") as Extract<LaunchPlan, { kind: "command" }>;
    expect(mac).toMatchObject({ kind: "command", file: "/bin/sh", wait: true, missing: 1 });
    expect(mac.args[1]).toContain("ChatGPT.app");
    expect(mac.args[1]).toContain("Chrome");
    const windows = launchPlan("chatgpt", "win32") as Extract<LaunchPlan, { kind: "command" }>;
    expect(windows).toMatchObject({ kind: "command", file: "powershell.exe", wait: true, missing: 3 });
    expect(windows.args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    const script = Buffer.from(windows.args[3] ?? "", "base64").toString("utf16le");
    expect(script).toContain("Get-StartApps");
    expect(script).toContain("'ChatGPT'");
    expect(script).toContain("shell:AppsFolder");
    expect(script).toContain("msedge");
    expect(script).toContain("'*!*'");
  });

  it.skipIf(process.platform === "win32")("finds ChatGPT on macOS by its bundle ids first, else by name, and says when there is none", async () => {
    expect(CHATGPT_MAC_BUNDLE_IDS).toEqual(["com.openai.codex", "com.openai.chat"]);
    const script = (launchPlan("chatgpt", "darwin") as Extract<LaunchPlan, { kind: "command" }>).args[1]!;
    const bin = await mkdtemp(join(tmpdir(), "chatgpt-mac-"));
    try {
      // Stand-ins: mdfind answers by query kind, open records what it was given.
      await writeFile(join(bin, "mdfind"), '#!/bin/sh\ncase "$1" in *kMDItemCFBundleIdentifier*) printf "%s" "$BY_ID";; *) printf "%s" "$BY_NAME";; esac\n');
      await writeFile(join(bin, "open"), '#!/bin/sh\nprintf "%s" "$1" > "$OPENED"\n');
      await chmod(join(bin, "mdfind"), 0o755);
      await chmod(join(bin, "open"), 0o755);
      const opened = join(bin, "opened");
      const run = (byId: string, byName: string) => {
        execFileSync("/bin/sh", ["-c", script], { env: { PATH: `${bin}:/usr/bin:/bin`, BY_ID: byId, BY_NAME: byName, OPENED: opened } });
        return readFile(opened, "utf8");
      };
      expect(script).toContain('kMDItemCFBundleIdentifier == "com.openai.codex" || kMDItemCFBundleIdentifier == "com.openai.chat"');
      expect(await run("/Applications/ChatGPT.app\n", "/Users/me/Applications/Chrome Apps/ChatGPT.app\n")).toBe("/Applications/ChatGPT.app");
      expect(await run("", "/Users/me/Applications/Chrome Apps.localized/ChatGPT.app\n/Applications/Tools/ChatGPT.app\n")).toBe("/Applications/Tools/ChatGPT.app");
      expect(() => run("", "/Users/me/Applications/Edge Apps/ChatGPT.app\n")).toThrow(expect.objectContaining({ status: 1 }));
    } finally {
      await rm(bin, { recursive: true, force: true });
    }
  });

  it("has no ChatGPT plan on Linux, where there is no desktop app", () => {
    expect(launchPlan("chatgpt", "linux")).toBeNull();
  });
});

describe("systemLauncher", () => {
  it("reports Claude Desktop as not found when no app handles claude:, without opening anything", async () => {
    const opened: string[] = [];
    const launch = systemLauncher(async (url) => void opened.push(url), () => "");
    expect(await launch({ kind: "url", url: "claude://" })).toEqual({ ok: false, problem: { kind: "not-found" } });
    expect(opened).toEqual([]);
  });

  it("opens the URL when an app handles it", async () => {
    const opened: string[] = [];
    const launch = systemLauncher(async (url) => void opened.push(url), () => "Claude");
    expect(await launch({ kind: "url", url: "claude://" })).toEqual({ ok: true });
    expect(opened).toEqual(["claude://"]);
  });
});

describe("openDesktopApp", () => {
  it("launches the app, then puts the starter phrase on the clipboard", async () => {
    const { plans, launch } = recorder();
    const copied: string[] = [];
    const result = await openDesktopApp("claude-desktop", "Work on my open Frameshell project: Demo.", {
      platform: "win32",
      launch,
      copy: (text) => copied.push(text),
    });
    expect(result).toEqual({ opened: true, copied: true });
    expect(plans).toEqual([{ kind: "url", url: "claude://" }]);
    expect(copied).toEqual(["Work on my open Frameshell project: Demo."]);
  });

  it("copies nothing when the app is not found or will not start", async () => {
    const copied: string[] = [];
    const copy = (text: string) => copied.push(text);
    expect(await openDesktopApp("chatgpt", "hi", { platform: "darwin", launch: recorder({ ok: false, problem: { kind: "not-found" } }).launch, copy })).toEqual({
      opened: false,
      problem: { kind: "not-found" },
    });
    const failed = { kind: "failed", message: "exit code 7" } as const;
    expect(await openDesktopApp("chatgpt", "hi", { platform: "darwin", launch: recorder({ ok: false, problem: failed }).launch, copy })).toEqual({ opened: false, problem: failed });
    const thrown: Launcher = async () => {
      throw new Error("spawn blew up");
    };
    expect(await openDesktopApp("chatgpt", "hi", { platform: "darwin", launch: thrown, copy })).toEqual({ opened: false, problem: { kind: "failed", message: "spawn blew up" } });
    expect(copied).toEqual([]);
  });

  it("reports an app that does not exist on the platform as not found, without launching", async () => {
    const { plans, launch } = recorder();
    expect(await openDesktopApp("chatgpt", "hi", { platform: "linux", launch, copy: () => {} })).toEqual({ opened: false, problem: { kind: "not-found" } });
    expect(await openDesktopApp("claude-desktop", "hi", { platform: "linux", launch, copy: () => {} })).toEqual({ opened: false, problem: { kind: "not-found" } });
    expect(plans).toEqual([]);
  });

  it("still opened when the clipboard fails or the phrase is empty, and caps a long phrase", async () => {
    const { launch } = recorder();
    const boom = () => {
      throw new Error("no clipboard");
    };
    expect(await openDesktopApp("chatgpt", "hi", { platform: "darwin", launch, copy: boom })).toEqual({ opened: true, copied: false });
    expect(await openDesktopApp("chatgpt", "  ", { platform: "darwin", launch, copy: boom })).toEqual({ opened: true, copied: false });
    const copied: string[] = [];
    await openDesktopApp("chatgpt", "x".repeat(2000), { platform: "darwin", launch, copy: (text) => copied.push(text) });
    expect(copied[0]).toHaveLength(500);
  });
});

describe("standInLauncher", () => {
  it("records each plan as a JSON line and launches nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "frameshell-stand-in-"));
    try {
      const file = join(dir, "launches.jsonl");
      const plan = launchPlan("claude-desktop", "win32") as LaunchPlan;
      expect(await standInLauncher(file, false)(plan)).toEqual({ ok: true });
      expect(await standInLauncher(file, true)(plan)).toEqual({ ok: false, problem: { kind: "not-found" } });
      expect((await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line))).toEqual([plan, plan]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
