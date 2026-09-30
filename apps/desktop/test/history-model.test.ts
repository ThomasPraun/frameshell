import type { HistoryTransaction } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";
import { authorOf, historySelection, newestFirst, transactionTitle } from "../src/renderer/src/history/model.js";

// Seam under test: the History panel's pure model (what rows say, what a click selects).

const op = (id: string, name: string, args: Record<string, unknown> = {}) => ({
  id,
  op: name,
  args,
  author: "ui",
  at: "2026-09-30T10:00:00.000Z",
  revisionBefore: 0,
  revision: 1,
  touched: [],
});

const tx = (id: string, label: string | null, ops: ReturnType<typeof op>[], author = "ui"): HistoryTransaction => ({
  tx: id,
  label,
  author,
  at: "2026-09-30T10:00:00.000Z",
  operations: ops,
});

describe("history rows", () => {
  it("names authors by who they are, keeping the session or plugin name", () => {
    expect(authorOf("ui")).toEqual({ kind: "ui", name: "You", detail: null });
    expect(authorOf("cli:term-1a2b")).toEqual({ kind: "cli", name: "Terminal", detail: "term-1a2b" });
    expect(authorOf("cli")).toEqual({ kind: "cli", name: "Terminal", detail: null });
    expect(authorOf("file")).toEqual({ kind: "file", name: "File", detail: null });
    expect(authorOf("plugin:titles")).toEqual({ kind: "plugin", name: "Plugin", detail: "titles" });
  });

  it("titles a transaction by its label, else by what its operations did", () => {
    expect(transactionTitle(tx("tx_00000001", "remove silences", [op("op_1", "cut")]))).toBe("remove silences");
    expect(transactionTitle(tx("tx_00000002", null, [op("op_1", "clip.move")]))).toBe("Move");
    expect(transactionTitle(tx("tx_00000003", null, [op("op_1", "cut"), op("op_2", "cut"), op("op_3", "clip.trim")]))).toBe(
      "Ripple delete ×2, trim",
    );
    expect(transactionTitle(tx("tx_00000004", null, [op("op_1", "revert", { target: "tx_00000002" })]))).toBe("Revert tx_00000002");
    expect(transactionTitle(tx("tx_00000005", null, [op("op_1", "timeline.patch")], "file"))).toBe("Direct edit");
    expect(transactionTitle(tx("tx_00000006", null, [op("op_1", "track.rename")]))).toBe("track.rename");
  });

  it("lists newest first, keeping a transaction split by others' operations as separate rows", () => {
    const runs = [tx("tx_0000000a", null, []), tx("tx_0000000b", null, []), tx("tx_0000000a", null, [])];
    expect(newestFirst(runs).map((row) => row.key)).toEqual(["tx_0000000a#2", "tx_0000000b#1", "tx_0000000a#0"]);
  });
});

describe("historySelection", () => {
  const place = (start: number, end: number | null) => ({ track: "v1", start, end });

  it("selects the clips the entry left on the timeline, revealing the first", () => {
    const diff = [
      { clip: "c_gone", change: "removed" as const, before: place(0, 2), after: null },
      { clip: "c_moved", change: "moved" as const, before: place(4, 6), after: place(8, 10) },
      { clip: "c_later", change: "added" as const, before: null, after: place(12, 14) },
    ];
    // c_later was removed again since: not on the timeline, not selected.
    expect(historySelection(diff, new Set(["c_moved", "c_other"]))).toEqual({
      clips: ["c_moved"],
      reveal: { clip: "c_moved", place: place(8, 10) },
    });
  });

  it("reveals where a clip was removed when the entry left nothing on the timeline", () => {
    const diff = [{ clip: "c_gone", change: "removed" as const, before: place(3, 5), after: null }];
    expect(historySelection(diff, new Set())).toEqual({ clips: [], reveal: { clip: "c_gone", place: place(3, 5) } });
    expect(historySelection([], new Set())).toEqual({ clips: [], reveal: null });
  });
});
