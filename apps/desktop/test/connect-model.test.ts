import { describe, expect, it } from "vitest";
import type { AiAppStatus } from "../src/shared/api.js";
import { DESKTOP_ROWS, DEVELOPER_ROWS, ROW_APP, cardView, starterPhrase } from "../src/renderer/src/connect/model.js";

const status = (fields: Partial<AiAppStatus> = {}): AiAppStatus => ({
  id: "claude-desktop",
  available: true,
  installed: true,
  connected: false,
  different: false,
  files: ["/home/ana/claude.json"],
  problem: null,
  ...fields,
});

describe("Connect your AI rows", () => {
  it("lists the desktop apps first and the developer tools after, ChatGPT and Codex CLI on one settings file", () => {
    expect(DESKTOP_ROWS).toEqual(["claude-desktop", "chatgpt"]);
    expect(DEVELOPER_ROWS).toEqual(["claude-code", "codex-cli", "gemini"]);
    expect(ROW_APP.chatgpt).toBe("codex");
    expect(ROW_APP["codex-cli"]).toBe("codex");
  });
});

describe("starterPhrase", () => {
  const said = { project: (name: string) => `Work on ${name}.`, general: "Help me edit." };
  it("names the open project, or asks in general with none", () => {
    expect(starterPhrase("Demo", said)).toBe("Work on Demo.");
    expect(starterPhrase(null, said)).toBe("Help me edit.");
  });
});

describe("cardView", () => {
  it("offers nothing while reading, while a change runs, or where the app does not exist", () => {
    expect(cardView(undefined, false)).toMatchObject({ kind: "loading", connect: null, disconnect: false });
    expect(cardView(status(), true)).toMatchObject({ kind: "working", connect: null, disconnect: false });
    expect(cardView(status({ available: false, installed: false }), false)).toMatchObject({ kind: "unavailable", connect: null, disconnect: false });
  });

  it("offers Connect only once the app is installed", () => {
    expect(cardView(status({ installed: false }), false)).toMatchObject({ kind: "not-installed", connect: null, disconnect: false });
    expect(cardView(status(), false)).toMatchObject({ kind: "ready", connect: "connect", disconnect: false, restart: null });
  });

  it("offers Disconnect when connected, and Connect again with Disconnect for an entry that runs another command", () => {
    expect(cardView(status({ connected: true }), false)).toMatchObject({ kind: "connected", connect: null, disconnect: true });
    expect(cardView(status({ different: true }), false)).toMatchObject({ kind: "different", connect: "again", disconnect: true });
  });

  it("offers Open once connected, Connect first while installed but not connected", () => {
    expect(cardView(status({ connected: true }), false)).toMatchObject({ open: true, download: false });
    expect(cardView(status(), false)).toMatchObject({ kind: "ready", open: false, download: false });
    expect(cardView(status({ different: true }), false)).toMatchObject({ open: false, download: false });
  });

  it("offers Download, and Open for an app that may be installed but never ran, when it looks not installed", () => {
    expect(cardView(status({ installed: false }), false)).toMatchObject({ kind: "not-installed", open: true, download: true });
  });

  it("never says not installed once Open found the app; it waits for its settings instead (#735)", () => {
    const opened = { kind: "opened", copied: true } as const;
    expect(cardView(status({ installed: false }), false, undefined, opened)).toMatchObject({ kind: "no-settings", open: true, download: false, connect: null, checkAgain: true });
    expect(cardView(status({ installed: false }), false, undefined, { kind: "not-found" })).toMatchObject({ kind: "not-installed", download: true });
  });

  it("puts Check again in the card of an app that looks not installed, and only there", () => {
    expect(cardView(status({ installed: false }), false)).toMatchObject({ checkAgain: true });
    for (const view of [cardView(status(), false), cardView(status({ connected: true }), false), cardView(undefined, false)]) expect(view.checkAgain).toBe(false);
  });

  it("offers nothing to open while reading, working, or where the app does not exist", () => {
    for (const view of [cardView(undefined, false), cardView(status(), true), cardView(status({ available: false, installed: false }), false)]) {
      expect(view).toMatchObject({ open: false, download: false, launch: null });
    }
  });

  it("adds Download after an Open that did not find the app, and keeps the note of the last Open", () => {
    const connected = status({ connected: true });
    expect(cardView(connected, false, undefined, { kind: "not-found" })).toMatchObject({ open: true, download: true, launch: { kind: "not-found" } });
    expect(cardView(connected, false, undefined, { kind: "opened", copied: true })).toMatchObject({ open: true, download: false, launch: { kind: "opened", copied: true } });
    expect(cardView(connected, false, undefined, { kind: "failed", message: "x" })).toMatchObject({ download: false, launch: { kind: "failed" } });
  });

  it("says to restart the app after a change that worked, with the backups it made", () => {
    const connected = status({ connected: true });
    const view = cardView(connected, false, { connect: true, change: { status: connected, backups: ["/b"], problem: null } });
    expect(view).toMatchObject({ kind: "connected", restart: "connected", backups: ["/b"], problem: null });
    const removed = cardView(status(), false, { connect: false, change: { status: status(), backups: [], problem: null } });
    expect(removed).toMatchObject({ kind: "ready", restart: "disconnected" });
  });

  it("shows why a change failed instead of the restart note, and a settings file that cannot be read", () => {
    const problem = { kind: "invalid", file: "/home/ana/claude.json" } as const;
    const failed = cardView(status(), false, { connect: true, change: { status: status(), backups: [], problem } });
    expect(failed).toMatchObject({ kind: "ready", restart: null, problem });
    expect(cardView(status({ problem }), false)).toMatchObject({ kind: "ready", problem });
  });

  it("blocks Connect and offers the file while a settings file does not parse", () => {
    const problem = { kind: "invalid", file: "/home/ana/claude.json" } as const;
    expect(cardView(status({ problem }), false)).toMatchObject({ connect: "connect", connectBlocked: true, showFile: "/home/ana/claude.json" });
    const failed = { kind: "failed", message: "disk full" } as const;
    expect(cardView(status({ problem: failed }), false)).toMatchObject({ connect: "connect", connectBlocked: false, showFile: null });
  });
});
