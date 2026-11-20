import { describe, expect, it } from "vitest";
import type { AiAppStatus } from "../src/shared/api.js";
import { DESKTOP_ROWS, DEVELOPER_ROWS, ROW_APP, cardView } from "../src/renderer/src/connect/model.js";

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
});
