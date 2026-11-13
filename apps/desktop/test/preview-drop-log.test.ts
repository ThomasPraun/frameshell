import { describe, expect, it } from "vitest";
import { DROP_SAMPLE, DropLog } from "../src/renderer/src/preview/drop-log.js";

/** A play at 30 fps (33.3 ms frames) from `frame`. */
function play(frame = 0): DropLog {
  const log = new DropLog();
  log.start(frame, 30);
  return log;
}

/** One display tick: the due frame, shown when `decoded`, then the tick's own work time. */
function tick(log: DropLog, frame: number, decoded = true, busyMs = 2): void {
  log.due(frame);
  if (decoded) log.shown(frame);
  log.busy(busyMs);
}

describe("DropLog", () => {
  it("records nothing when every frame is wanted and shown in turn", () => {
    const log = play();
    for (let frame = 1; frame <= 5; frame++) tick(log, frame);
    expect(log.drops).toMatchObject({ starved: { count: 0, frames: [] }, cadence: { count: 0, frames: [] } });
  });

  it("calls a frame a tick wanted but never showed starved, and one no tick wanted cadence", () => {
    const log = play(10);
    tick(log, 11);
    // A tick wants 12, its frame is not decoded; the next tick comes when 14 is due.
    tick(log, 12, false);
    tick(log, 14);
    expect(log.drops).toMatchObject({ starved: { count: 1, frames: [12] }, cadence: { count: 1, frames: [13] } });
  });

  it("keeps a frame starved over several ticks once, and forgets wants a shown frame passed", () => {
    const log = play();
    tick(log, 1, false);
    tick(log, 1, false);
    tick(log, 2, false);
    tick(log, 3);
    tick(log, 5);
    expect(log.drops).toMatchObject({ starved: { count: 2, frames: [1, 2] }, cadence: { count: 1, frames: [4] } });
  });

  it("calls frames skipped after the engine's own tick overran a frame period starved, not cadence", () => {
    const log = play();
    tick(log, 1, true, 50);
    tick(log, 4);
    // An idle engine whose next tick comes late: the host's cadence.
    tick(log, 5, true, 30);
    tick(log, 7);
    expect(log.drops).toMatchObject({ starved: { count: 2, frames: [2, 3] }, cadence: { count: 1, frames: [6] } });
    expect(log.drops.busyMaxMs).toBe(50);
  });

  it("reports the tick times of the play: the longest and the 95th percentile", () => {
    const log = play();
    for (let frame = 1; frame <= 100; frame++) tick(log, frame, true, frame <= 95 ? 1.04 : 20);
    expect(log.drops).toMatchObject({ busyMaxMs: 20, busyP95Ms: 1.1 });
  });

  it("counts every drop but posts the first DROP_SAMPLE frames of each kind", () => {
    const log = play();
    tick(log, 200);
    const { cadence } = log.drops;
    expect(cadence.count).toBe(199);
    expect(cadence.frames).toHaveLength(DROP_SAMPLE);
    expect(cadence.frames.slice(0, 3)).toEqual([1, 2, 3]);
  });

  it("counts nothing while paused, and a new play starts a new log", () => {
    const log = new DropLog();
    log.due(3);
    log.shown(9);
    log.busy(80);
    expect(log.drops).toEqual({ starved: { count: 0, frames: [] }, cadence: { count: 0, frames: [] }, busyMaxMs: 0, busyP95Ms: 0 });
    log.start(0, 30);
    log.shown(3);
    log.stop();
    expect(log.drops.cadence.frames).toEqual([1, 2]);
    log.shown(8);
    expect(log.drops.cadence.frames).toEqual([1, 2]);
    log.start(20, 30);
    expect(log.drops.cadence.count).toBe(0);
  });
});
