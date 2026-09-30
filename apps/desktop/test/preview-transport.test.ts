import { beforeEach, describe, expect, it } from "vitest";
import { type TransportPlayer, createTransport } from "../src/renderer/src/preview/transport.js";

// Seam under test: the playhead store shared by the timeline panel, the preview controls and the player.

function fakePlayer(): TransportPlayer & { calls: string[]; clock: number } {
  const player = {
    calls: [] as string[],
    clock: 0,
    play(from: number) {
      player.calls.push(`play ${from}`);
    },
    pause() {
      player.calls.push("pause");
      return player.clock;
    },
    seek(time: number) {
      player.calls.push(`seek ${time}`);
    },
  };
  return player;
}

describe("transport", () => {
  let transport: ReturnType<typeof createTransport>;
  beforeEach(() => {
    transport = createTransport();
    transport.setProgram(300, 30);
  });

  it("starts paused at 0 and moves the playhead to the frame under a seek, within the program", () => {
    expect(transport.get()).toMatchObject({ time: 0, playing: false, frames: 300, fps: 30 });
    transport.seek(2.51);
    expect(transport.get().time).toBeCloseTo(75 / 30, 9);
    transport.seek(-4);
    expect(transport.get().time).toBe(0);
    transport.seek(99);
    expect(transport.get().time).toBe(10);
  });

  it("steps frame by frame", () => {
    transport.seek(1);
    transport.step(1);
    expect(transport.get().time).toBeCloseTo(31 / 30, 9);
    transport.step(-2);
    expect(transport.get().time).toBeCloseTo(29 / 30, 9);
  });

  it("drives the attached player: play from the playhead, pause where the clock is, seek while playing", () => {
    const player = fakePlayer();
    transport.attach(player);
    transport.seek(1);
    expect(player.calls).toEqual(["seek 1"]);
    transport.toggle();
    expect(transport.get().playing).toBe(true);
    player.clock = 1.5;
    transport.toggle();
    expect(transport.get()).toMatchObject({ playing: false, time: 1.5 });
    expect(player.calls).toEqual(["seek 1", "play 1", "pause"]);
  });

  it("restarts from the beginning when play is pressed at the end", () => {
    const player = fakePlayer();
    transport.attach(player);
    transport.seek(10);
    transport.play();
    expect(player.calls.at(-1)).toBe("play 0");
  });

  it("follows the player's clock while playing and stops at the end", () => {
    const player = fakePlayer();
    transport.attach(player);
    transport.play();
    transport.report(4.2);
    expect(transport.get()).toMatchObject({ playing: true, time: 4.2 });
    transport.report(10.4);
    expect(transport.get()).toMatchObject({ playing: false, time: 10 });
    expect(player.calls.at(-1)).toBe("pause");
  });

  it("keeps the playhead inside a program that got shorter", () => {
    transport.seek(9);
    transport.setProgram(150, 30);
    expect(transport.get().time).toBe(5);
  });

  it("notifies subscribers on every change, not on no-ops", () => {
    let changes = 0;
    transport.subscribe(() => changes++);
    transport.seek(1);
    transport.seek(1);
    transport.setProgram(300, 30);
    expect(changes).toBe(1);
  });
});
