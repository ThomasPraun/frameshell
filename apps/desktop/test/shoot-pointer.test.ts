import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parsePointerTrack } from "@frameshell/schema";
import { PointerRecorder, pointerTrack, writePointerTrack } from "../src/main/shoot-pointer.js";

const BOUNDS = { x: 1920, y: 0, width: 1600, height: 900 };

describe("pointerTrack", () => {
  it("puts readings on the screen file's clock as fractions of the captured display", () => {
    const track = pointerTrack(
      [
        { at: 999.5, x: 1920, y: 0 },
        { at: 1000, x: 1920, y: 0 },
        { at: 1050, x: 2720, y: 450 },
        { at: 1050, x: 2720, y: 450 },
        { at: 1100.4, x: 100, y: 1000 },
      ],
      1000,
      BOUNDS,
    );
    // Before the start: dropped; a reading in the same millisecond: dropped; off the display: kept outside 0 to 1.
    expect(track).toEqual({
      version: 1,
      width: 1600,
      height: 900,
      samples: [
        [0, 0, 0],
        [0.05, 0.5, 0.5],
        [0.1, -1.1375, 1.1111],
      ],
    });
    expect(parsePointerTrack(track).ok).toBe(true);
  });
});

describe("PointerRecorder", () => {
  it("polls 20 times a second until stopped, and the track lands next to the screen file", async () => {
    vi.useFakeTimers();
    try {
      let now = 5000;
      const recorder = new PointerRecorder(BOUNDS, () => ({ x: 2720, y: 450 }), () => now);
      for (let i = 0; i < 10; i++) {
        now += 50;
        vi.advanceTimersByTime(50);
      }
      recorder.stop();
      vi.advanceTimersByTime(500);
      expect(recorder.readings).toHaveLength(11);
      const root = realpathSync(mkdtempSync(join(tmpdir(), "fs-pointer-")));
      const rel = await writePointerTrack(root, "assets/shoot/20261121-101500", "screen.webm", pointerTrack(recorder.readings, 5000, recorder.bounds));
      expect(rel).toBe("assets/shoot/20261121-101500/.screen.pointer.json");
      const written = JSON.parse(readFileSync(join(root, rel), "utf8"));
      expect(written.samples.at(-1)).toEqual([0.5, 0.5, 0.5]);
    } finally {
      vi.useRealTimers();
    }
  });
});
