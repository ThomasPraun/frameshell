import { describe, expect, it } from "vitest";
import { DropLog } from "../src/renderer/src/preview/drop-log.js";

describe("DropLog", () => {
  it("records nothing when every frame is wanted and shown in turn", () => {
    const log = new DropLog();
    log.start(0);
    for (let frame = 1; frame <= 5; frame++) {
      log.due(frame);
      log.shown(frame);
    }
    expect(log.drops).toEqual({ starved: [], cadence: [] });
  });

  it("calls a frame a tick wanted but never showed starved, and one no tick wanted cadence", () => {
    const log = new DropLog();
    log.start(10);
    log.due(11);
    log.shown(11);
    // A tick wants 12, its frame is not decoded; the next tick comes when 14 is due.
    log.due(12);
    log.due(14);
    log.shown(14);
    expect(log.drops).toEqual({ starved: [12], cadence: [13] });
  });

  it("keeps a frame starved over several ticks once, and forgets wants a shown frame passed", () => {
    const log = new DropLog();
    log.start(0);
    log.due(1);
    log.due(1);
    log.due(2);
    log.shown(3);
    log.due(5);
    log.shown(5);
    expect(log.drops).toEqual({ starved: [1, 2], cadence: [4] });
  });

  it("counts nothing while paused, and a new play starts a new log", () => {
    const log = new DropLog();
    log.due(3);
    log.shown(9);
    expect(log.drops).toEqual({ starved: [], cadence: [] });
    log.start(0);
    log.shown(3);
    log.stop();
    expect(log.drops).toEqual({ starved: [], cadence: [1, 2] });
    log.shown(8);
    expect(log.drops.cadence).toEqual([1, 2]);
    log.start(20);
    expect(log.drops).toEqual({ starved: [], cadence: [] });
  });
});
