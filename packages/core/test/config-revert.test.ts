import { type ConfigJournalEntry, ErrorCode } from "@frameshell/protocol";
import type { FormatEntry } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import { type ConfigState, FORMAT_RULES, configHash, diffConfig, formatState, formatsFromState, planConfigRevert } from "../src/index.js";

const PRIMARY: FormatEntry = { id: "16x9", width: 1920, height: 1080 };
const F = {
  "9x16": { id: "9x16", width: 1080, height: 1920 },
  "1x1": { id: "1x1", width: 1080, height: 1080 },
  "4x5": { id: "4x5", width: 1080, height: 1350 },
} satisfies Record<string, FormatEntry>;

/** Journal of the format lists in `steps`, one op each (`tx_` + index), from a project with only the primary. */
function journal(steps: { op: string; list: FormatEntry[] }[]): { entries: ConfigJournalEntry[]; current: ConfigState } {
  let before = formatState(null);
  const entries = steps.map(({ op, list }, index) => {
    const after = formatState([PRIMARY, ...list]);
    const hex = index.toString(16).padStart(8, "0");
    const entry: ConfigJournalEntry = {
      id: `op_${hex}`,
      op,
      args: {},
      author: index % 2 === 0 ? "ui" : "cli:agent",
      tx: `tx_${hex}`,
      txLabel: null,
      at: `2026-11-11T10:00:0${index}.000Z`,
      doc: "project",
      patch: diffConfig(before, after, FORMAT_RULES),
      hashBefore: configHash(before),
      hash: configHash(after),
    };
    before = after;
    return entry;
  });
  return { entries, current: before };
}

const ids = (state: ConfigState) => formatsFromState(PRIMARY, state).map((format) => format.id);

describe("planConfigRevert over formats", () => {
  it("puts a removed format back at its position after a later unrelated add", () => {
    const { entries, current } = journal([
      { op: "format.add", list: [F["9x16"]] },
      { op: "format.add", list: [F["9x16"], F["1x1"]] },
      { op: "format.remove", list: [F["1x1"]] },
      { op: "format.add", list: [F["1x1"], F["4x5"]] },
    ]);
    expect(entries[2]!.patch.map((change) => change.key)).toEqual(["format:9x16"]);
    expect(ids(planConfigRevert(current, entries, "op_00000002", "project", FORMAT_RULES))).toEqual(["16x9", "9x16", "1x1", "4x5"]);
  });

  it("blames only the later operation that changed the same format", () => {
    const { entries, current } = journal([
      { op: "format.add", list: [F["9x16"]] },
      { op: "format.add", list: [F["9x16"], F["1x1"]] },
      { op: "format.remove", list: [F["1x1"]] },
    ]);
    expect(() => planConfigRevert(current, entries, "tx_00000000", "project", FORMAT_RULES)).toThrow(
      expect.objectContaining({ code: ErrorCode.RevertConflict, data: expect.objectContaining({ conflicts: [expect.objectContaining({ id: "op_00000002", ids: ["format:9x16"] })] }) }),
    );
  });

  it("refuses when the state is not what the journal last wrote", () => {
    const { entries } = journal([{ op: "format.add", list: [F["9x16"]] }]);
    const edited = formatState([PRIMARY, F["9x16"], F["4x5"]]);
    expect(() => planConfigRevert(edited, entries, "op_00000000", "project", FORMAT_RULES)).toThrow(/changed outside the journal after op_00000000/);
  });
});
