import { describe, expect, it } from "vitest";
import type { ProposalChange } from "../src/shared/api.js";
import {
  INITIAL_REVIEW,
  type ReviewState,
  afterEdit,
  applyEvent,
  barOf,
  configLines,
  dismissStale,
  readStatus,
  viewOf,
  whoOf,
  withSide,
} from "../src/renderer/src/review/model.js";

const change = (state: ProposalChange["state"], extra: Partial<ProposalChange> = {}): { proposal: ProposalChange } => ({
  proposal: { tx: "tx_1", label: "Remove silences", author: "agent:claude:term-1", state, operations: 2, timelines: ["main"], config: [], conflicts: [], ...extra },
});

const ready: ReviewState = applyEvent(applyEvent(INITIAL_REVIEW, change("building")), change("ready"));

describe("review state", () => {
  it("shows a building proposal on Before and Accept-less, then After once it is ready", () => {
    const building = applyEvent(INITIAL_REVIEW, change("building"));
    expect(building.side).toBe("before");
    expect(barOf(building)).toMatchObject({ kind: "building" });
    expect(viewOf(building)).toBeUndefined();
    expect(barOf(ready)).toMatchObject({ kind: "ready", side: "after" });
    expect(viewOf(ready)).toBe("proposal");
  });

  it("keeps the side the person picked while the proposal only changes", () => {
    const before = withSide(ready, "before");
    expect(applyEvent(before, change("ready", { operations: 3 })).side).toBe("before");
    expect(applyEvent(before, change("ready"))).toMatchObject({ side: "before", proposal: { operations: 2 } });
  });

  it("starts on After when an already open ready proposal is found", () => {
    const opened = readStatus(INITIAL_REVIEW, {
      enabled: true,
      proposal: { tx: "tx_1", label: null, author: "cli:term-1", state: "ready", operations: 1, timelines: ["main"], config: [], openedAt: "", ageMs: 0 },
    });
    expect(opened).toMatchObject({ enabled: true, side: "after" });
  });

  it("lists the formats a proposal adds, removes or resizes (ADR 0036)", () => {
    const config = [
      { doc: "project" as const, key: "format:1x1", before: { id: "1x1", width: 1080, height: 1080, index: 1 }, after: null },
      { doc: "project" as const, key: "format:9x16", before: null, after: { id: "9x16", width: 1080, height: 1920, index: 1 } },
      { doc: "project" as const, key: "format:web", before: { id: "web", width: 1600, height: 900, index: 2 }, after: { id: "web", width: 1280, height: 720, index: 2 } },
    ];
    const open = applyEvent(INITIAL_REVIEW, change("ready", { timelines: [], operations: 3, config })).proposal!;
    expect(configLines(open)).toEqual([
      { kind: "removed", id: "1x1" },
      { kind: "added", id: "9x16", size: "1080x1920" },
      { kind: "resized", id: "web", from: "1600x900", to: "1280x720" },
    ]);
    expect(configLines(ready.proposal!)).toEqual([]);
  });

  it("returns to Before and drops the bar when the proposal is accepted, rejected or aborted", () => {
    for (const state of ["accepted", "rejected", "aborted"] as const) {
      const closed = applyEvent(ready, change(state));
      expect(closed).toMatchObject({ proposal: null, stale: null, side: "before" });
      expect(barOf(closed)).toBeNull();
    }
  });

  it("keeps a stale notice with the shared ids until dismissed", () => {
    const stale = applyEvent(ready, change("stale", { conflicts: ["c_two"] }));
    expect(stale.side).toBe("before");
    expect(barOf(stale)).toEqual({ kind: "stale", notice: expect.objectContaining({ tx: "tx_1", conflicts: ["c_two"] }) });
    expect(barOf(dismissStale(stale))).toBeNull();
  });

  it("replaces the stale notice with the next proposal", () => {
    const stale = applyEvent(ready, change("stale"));
    expect(barOf(applyEvent(stale, change("building", { tx: "tx_2" })))).toMatchObject({ kind: "building" });
  });

  it("ignores the closing of a proposal that is not the open one", () => {
    expect(applyEvent(ready, change("rejected", { tx: "tx_0" }))).toBe(ready);
  });

  it("returns to Before on the person's edit, only from After", () => {
    expect(afterEdit(ready).side).toBe("before");
    const before = withSide(ready, "before");
    expect(afterEdit(before)).toBe(before);
  });

  it("follows the switch, and cannot pick a side with no proposal", () => {
    expect(applyEvent(INITIAL_REVIEW, { enabled: true }).enabled).toBe(true);
    expect(withSide(INITIAL_REVIEW, "after")).toBe(INITIAL_REVIEW);
  });

  it("names the proposer by the agent's own label", () => {
    expect(whoOf("agent:claude:term-1")).toBe("claude");
    expect(whoOf("cli:term-1")).toBe("Terminal");
    expect(whoOf("file")).toBe("File");
  });
});
