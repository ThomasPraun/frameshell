import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type DaemonConnection, ErrorCode, RpcError, connectToDaemon } from "@frameshell/protocol";
import { SOUND_KEY_GAP_MS, SOUND_ROLE_OFFSETS, SOUND_TIER_OFFSETS_DB, type Timeline } from "@frameshell/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Daemon, type SoundItem, soundWarnings, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { makeClip } from "./media-fixtures.js";
import { testBinaryManager } from "./media-tools.js";

// Seams under test: the warnings of taste (`soundWarnings`, pure) and `sound.place` through a real in-process daemon:
// cue times, role offsets, whole frames, lanes, gains from the style, one transaction (ADR 0038).

const FPS = 30;
const HALF_FRAME = 0.5 / FPS + 1e-6;

describe("soundWarnings", () => {
  const item = (kind: SoundItem["kind"], at: number, fresh = true, file = `assets/sound/${kind}-${at}.wav`): SoundItem => ({ kind, file, at, fresh });
  const key = (at: number): SoundItem => ({ ...item("tick", at), from: "typing" });

  it("warns about more than two sounds on one frame, and not about two", () => {
    expect(soundWarnings([item("click", 2), item("pop", 2)], FPS)).toEqual([]);
    const three = soundWarnings([item("click", 2), item("pop", 2.005), item("impact", 2.01)], FPS);
    expect(three).toHaveLength(1);
    expect(three[0]).toContain("3 sounds land on frame 60");
  });

  it("warns when two ticks or two pops are closer than their gap, and when the gap is enough", () => {
    expect(soundWarnings([item("tick", 1), item("tick", 1.05)], FPS)[0]).toContain("tick at 1.050 s is 50 ms after the one at 1.000 s; ticks need 66 ms");
    expect(soundWarnings([item("tick", 1), item("tick", 1.07)], FPS)).toEqual([]);
    expect(soundWarnings([item("pop", 1), item("pop", 1.1)], FPS)[0]).toContain("pops need 114 ms");
    expect(soundWarnings([item("click", 1), item("click", 1.01)], FPS)).toEqual([]);
  });

  it("warns about two keys of a run closer than the key gap on their anchors, and not about 87 ms or more", () => {
    // Cues 0.050 and 0.137 round to frames 0 and 2 at 30 fps: 66.7 ms apart, though the run spaced them 87 ms.
    const closer = soundWarnings([key(0), key(2 / FPS)], FPS);
    expect(closer).toHaveLength(1);
    expect(closer[0]).toContain("keys at 0.000 s and 0.067 s are 67 ms apart");
    expect(soundWarnings([key(0), key(3 / FPS)], FPS)).toEqual([]);
    // A tick key is held to the key gap, not also to the tick gap.
    expect(soundWarnings([key(0), key(0.05)], FPS)).toHaveLength(1);
    // Ticks of a cue, not of a run, only get the tick gap.
    expect(soundWarnings([item("tick", 0), item("tick", 0.07)], FPS)).toEqual([]);
  });

  it("warns about one take twice in a row, only when the later sound is new, and not when another sits between", () => {
    const same = (at: number, fresh: boolean) => item("whoosh", at, fresh, "assets/sound/whoosh-aaaa.wav");
    expect(soundWarnings([same(1, true), same(3, true)], FPS)[0]).toContain("assets/sound/whoosh-aaaa.wav plays twice in a row (1.000 s and 3.000 s)");
    expect(soundWarnings([same(1, false), same(3, false)], FPS)).toEqual([]);
    expect(soundWarnings([same(1, true), item("click", 2), same(3, true)], FPS)).toEqual([]);
  });
});

let daemon: Daemon;
let conn: DaemonConnection;
let root: string;

beforeEach(async () => {
  daemon = await startDaemon({
    socketPath: uniqueSocketPath(),
    idleTimeoutMs: Number.POSITIVE_INFINITY,
    dirs: { dataDir: tempDir(), configDir: tempDir() },
    binaries: testBinaryManager(),
  });
  conn = await connectToDaemon(daemon.socketPath, { client: "cli/test", session: "term-1" });
  root = join(tempDir(), "promo");
  await conn.request("project.init", { dir: root });
}, 60_000);

afterEach(async () => {
  conn.close();
  await daemon.close();
});

const place = (params: Record<string, unknown>) => conn.request("sound.place", { cwd: root, ...params } as never);
const timeline = async (): Promise<Timeline> => JSON.parse(readFileSync(join(root, "timelines", "main.json"), "utf8")) as Timeline;
const rejection = async (promise: Promise<unknown>): Promise<RpcError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
};
const MEDIA_TIMEOUT = 120_000;

/** A video track with three one-second clips starting at 0, 2 and 5. */
async function withCuts(): Promise<string> {
  const footage = join(tempDir(), "cam.mp4");
  await makeClip(footage, { durationS: 1, fps: FPS });
  const { imported } = await conn.request("asset.import", { cwd: root, files: [footage] });
  const track = (await conn.request("track.add", { cwd: root, kind: "video", name: "Camera" })).changes.added[0]!;
  for (const start of [0, 2, 5]) await conn.request("clip.add", { cwd: root, track, asset: imported[0]!.asset, start });
  return track;
}

describe("sound.place cues", () => {
  it("puts the anchor of each take on its cue plus the offset of its role, on a new SFX track", async () => {
    await conn.request("marker.add", { cwd: root, at: 4, label: "hook" });
    const result = await place({
      cues: [
        { at: "hook", kind: "whoosh" },
        { at: 8.5, kind: "click", seed: 3 },
        { at: "hook+3", kind: "riser", length: 1.5 },
      ],
    });
    // In the order the clips start: the riser builds before its cue, so it comes before the click.
    expect(result.placed.map((sound) => [sound.kind, sound.cue, sound.role, sound.offset])).toEqual([
      ["whoosh", 4, "whoosh", SOUND_ROLE_OFFSETS.whoosh],
      ["riser", 7, null, -75],
      ["click", 8.5, "click", SOUND_ROLE_OFFSETS.click],
    ]);
    for (const sound of result.placed) {
      expect(Math.abs(sound.anchorAt - (sound.cue + sound.offset / 1000))).toBeLessThanOrEqual(1 / FPS + 1e-6);
    }
    const [whoosh, riser, click] = result.placed;
    expect(Math.abs(whoosh!.anchorAt - 4.037)).toBeLessThanOrEqual(HALF_FRAME);
    expect(Math.abs(click!.anchorAt - 8.489)).toBeLessThanOrEqual(HALF_FRAME);
    // The engine keeps whole frames of a take, so a riser's last partial frame is gone and its anchor may be up to a frame early.
    expect(riser!.anchorAt).toBeLessThanOrEqual(6.925 + HALF_FRAME);
    expect(riser!.anchorAt).toBeGreaterThan(6.925 - 1.5 / FPS);

    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0]).toMatchObject({ name: "SFX", created: true });
    const saved = await timeline();
    const sfx = saved.tracks.find((track) => track.id === result.tracks[0]!.id)!;
    expect(sfx.kind).toBe("audio");
    expect(sfx.kind === "audio" && sfx.clips.map((clip) => clip.id)).toEqual(result.placed.map((sound) => sound.clip));
    expect(result.generated).toBe(3);
    expect(result.tx).toMatch(/^tx_/);
  }, MEDIA_TIMEOUT);

  it("takes the gain from the style's distance under the voice and the tier, and lets gain replace it", async () => {
    const result = await place({
      cues: [
        { at: 1, kind: "click" },
        { at: 3, kind: "shutter" },
        { at: 5, kind: "tick" },
        { at: 7, kind: "pop", tier: "secondary", gain: -6 },
      ],
    });
    expect(result.placed.map((sound) => [sound.tier, sound.gain])).toEqual([
      ["primary", -20 + SOUND_TIER_OFFSETS_DB.primary],
      ["secondary", -20 + SOUND_TIER_OFFSETS_DB.secondary],
      ["texture", -20 + SOUND_TIER_OFFSETS_DB.texture],
      ["secondary", -6],
    ]);
    const clip = (await timeline()).tracks.flatMap((track) => (track.kind === "audio" ? track.clips : [])).find((candidate) => candidate.id === result.placed[0]!.clip)!;
    expect("audio" in clip && clip.audio?.gain).toBe(-20);

    writeFileSync(join(root, "style.json"), JSON.stringify({ schemaVersion: 1, sound: { sfxUnderVoice: 14 } }));
    const quieter = await place({ cues: [{ at: 9, kind: "click", seed: 8 }] });
    expect(quieter.placed[0]!.gain).toBe(-14);
  }, MEDIA_TIMEOUT);

  it("rotates the variants of one kind along the timeline, and keeps rotating in the next call", async () => {
    const first = await place({
      cues: [
        { at: 1, kind: "whoosh" },
        { at: 3, kind: "whoosh" },
        { at: 5, kind: "whoosh" },
        { at: 7, kind: "whoosh" },
      ],
    });
    const files = first.placed.map((sound) => sound.file);
    expect(new Set(files.slice(0, 3)).size).toBe(3);
    expect(files[3]).toBe(files[0]);
    expect(first.warnings.filter((warning) => warning.includes("twice in a row"))).toEqual([]);
    // Four whooshes are there, so the next one is variant 2: made already, and not the one that played last.
    const next = await place({ cues: [{ at: 9, kind: "whoosh" }] });
    expect(next.placed[0]!.file).toBe(files[1]);
    expect(next.generated).toBe(0);
  }, MEDIA_TIMEOUT);

  it("puts sounds that overlap in time on further tracks and reuses those tracks", async () => {
    const result = await place({ cues: [{ at: 2, kind: "whoosh" }, { at: 2.2, kind: "whoosh" }] });
    expect(result.tracks.map((track) => track.name)).toEqual(["SFX", "SFX 2"]);
    const lanes = result.placed.map((sound) => sound.track);
    expect(lanes[0]).toBe(result.tracks[0]!.id);
    expect(lanes[1]).toBe(result.tracks[1]!.id);
    // Later calls count what is there: a click fits the first track again, a third overlapping whoosh needs a third.
    const fits = await place({ cues: [{ at: 9, kind: "click" }] });
    expect(fits.tracks).toEqual([{ id: result.tracks[0]!.id, name: "SFX", created: false }]);
    const third = await place({ cues: [{ at: 2.1, kind: "whoosh", seed: 5 }] });
    expect(third.tracks.map((track) => [track.name, track.created])).toEqual([["SFX 3", true]]);
  }, MEDIA_TIMEOUT);

  it("trims the head of a sound that would start before the timeline, and skips one with nothing left", async () => {
    const result = await place({ cues: [{ at: 0.1, kind: "whoosh" }, { at: 0, kind: "tick" }] });
    const [whoosh] = result.placed;
    expect(result.placed).toHaveLength(1);
    expect(whoosh).toMatchObject({ start: 0 });
    expect(whoosh!.in).toBeGreaterThan(0);
    expect(result.warnings.some((warning) => warning.includes("starts before the timeline does"))).toBe(true);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ kind: "tick", cue: 0 });
    expect(result.skipped[0]!.reason).toContain("before the timeline");
  }, MEDIA_TIMEOUT);

  it("lets an explicit role or offset replace the kind's own", async () => {
    const result = await place({
      cues: [
        { at: 3, kind: "click", role: "knock" },
        { at: 6, kind: "click", offset: 0, seed: 2 },
      ],
    });
    expect(result.placed.map((sound) => [sound.role, sound.offset])).toEqual([["knock", -40], [null, 0]]);
    expect(Math.abs(result.placed[1]!.anchorAt - 6)).toBeLessThanOrEqual(HALF_FRAME);
  }, MEDIA_TIMEOUT);

  it("warns about crowded frames and a take twice in a row, and still places everything", async () => {
    const result = await place({
      cues: [
        { at: 2, kind: "click", offset: 0 },
        { at: 2, kind: "pop", offset: 0 },
        { at: 2, kind: "impact", offset: 0 },
        { at: 8, kind: "click", variant: 1, seed: 7 },
        { at: 9, kind: "click", variant: 1, seed: 7 },
      ],
    });
    expect(result.placed).toHaveLength(5);
    expect(result.warnings.some((warning) => warning.includes("3 sounds land on frame 60"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("plays twice in a row"))).toBe(true);
  }, MEDIA_TIMEOUT);

  it("is one transaction that revert undoes whole, the track it made included", async () => {
    const before = await timeline();
    const result = await place({ cues: [{ at: 1, kind: "pop" }, { at: 4, kind: "click" }] });
    const { transactions } = await conn.request("history", { cwd: root, timeline: "main" });
    const last = transactions[transactions.length - 1]!;
    expect(last).toMatchObject({ tx: result.tx, label: "Sound: 1 pop, 1 click" });
    expect(last.operations.map((operation) => operation.op)).toEqual(["track.add", "clip.add", "clip.add"]);
    await conn.request("revert", { cwd: root, timeline: "main", target: result.tx! });
    expect((await timeline()).tracks).toEqual(before.tracks);
  }, MEDIA_TIMEOUT);
});

describe("sound.place cuts and typing", () => {
  it("puts a sound on every edit point of a track, or on the numbered ones", async () => {
    const track = await withCuts();
    const all = await place({ cuts: { track, kind: "whoosh" } });
    expect(all.placed.map((sound) => [sound.from, sound.cue])).toEqual([["cut", 2], ["cut", 5]]);
    const one = await place({ cuts: { track, kind: "click", which: [2], seed: 4 } });
    expect(one.placed.map((sound) => sound.cue)).toEqual([5]);
    const error = await rejection(place({ cuts: { track, kind: "click", which: [3] } }));
    expect(error).toMatchObject({ code: ErrorCode.InvalidOperation });
    expect(error.message).toContain("has 2 cuts, not 3");
  }, MEDIA_TIMEOUT);

  it("makes a run of keys no closer than the key gap, with rotating takes", async () => {
    const result = await place({ typing: { from: 1, to: 3, rate: 10, kind: "tick" } });
    const keys = result.placed;
    expect(keys.length).toBeGreaterThanOrEqual(17);
    expect(keys.length).toBeLessThanOrEqual(21);
    expect(keys.every((key) => key.from === "typing" && key.tier === "texture" && key.cue >= 1 && key.cue < 3)).toBe(true);
    let tight = 0;
    for (let i = 1; i < keys.length; i++) {
      expect(keys[i]!.cue - keys[i - 1]!.cue).toBeGreaterThanOrEqual(SOUND_KEY_GAP_MS / 1000);
      expect(keys[i]!.file).not.toBe(keys[i - 1]!.file);
      // Whole frames can bring two anchors closer than their cues; the call says so.
      if ((keys[i]!.anchorAt - keys[i - 1]!.anchorAt) * 1000 < SOUND_KEY_GAP_MS - 0.5) tight += 1;
    }
    expect(result.warnings.filter((warning) => warning.includes("apart on the frame grid"))).toHaveLength(tight);
    expect(new Set(keys.map((key) => key.file)).size).toBeLessThanOrEqual(6);
    expect(result.warnings.filter((warning) => warning.includes("land on frame"))).toEqual([]);
    expect(result.tracks).toHaveLength(1);
    expect(await place({ typing: { from: 1, to: 3, rate: 10, kind: "tick" } })).toMatchObject({ generated: 0 });
  }, MEDIA_TIMEOUT);
});

describe("sound.place refusals", () => {
  it("refuses an empty call, and one with too many sounds", async () => {
    expect(await rejection(place({}))).toMatchObject({ code: ErrorCode.InvalidParams });
    const error = await rejection(place({ typing: { from: 0, to: 60, rate: 10, kind: "tick" } }));
    expect(error).toMatchObject({ code: ErrorCode.InvalidOperation });
    expect(error.message).toContain("at most 200 sounds");
  });

  it("names an unknown marker, places nothing and writes no take", async () => {
    const before = await timeline();
    const error = await rejection(place({ cues: [{ at: 1, kind: "click" }, { at: "nowhere", kind: "click" }] }));
    expect(error).toMatchObject({ code: ErrorCode.InvalidOperation });
    expect(error.message).toContain("cues[1].at");
    expect(await timeline()).toEqual(before);
    expect((await conn.request("asset.list", { cwd: root })).assets).toEqual([]);
  });

  it("refuses a track that is not an audio track, and an unknown one", async () => {
    const video = await withCuts();
    const notAudio = await rejection(place({ cues: [{ at: 1, kind: "click" }], track: video }));
    expect(notAudio.message).toContain("sounds go on an audio track");
    expect(await rejection(place({ cues: [{ at: 1, kind: "click" }], track: "t_none" }))).toMatchObject({ code: ErrorCode.InvalidOperation });
    const audio = (await conn.request("track.add", { cwd: root, kind: "audio", name: "Effects" })).changes.added[0]!;
    const result = await place({ cues: [{ at: 1, kind: "click" }], track: audio });
    expect(result.tracks).toEqual([{ id: audio, name: "Effects", created: false }]);
  }, MEDIA_TIMEOUT);

  const setFps = (fps: number) => {
    const path = join(root, "frameshell.json");
    const config = JSON.parse(readFileSync(path, "utf8")) as { fps: number };
    config.fps = fps;
    writeFileSync(path, JSON.stringify(config));
  };

  it.each([24, 25])("places a tick and a run of keys at %d fps", async (fps) => {
    setFps(fps);
    const result = await place({ cues: [{ at: 2, kind: "tick" }], typing: { from: 8, to: 10.5, rate: 6 } });
    expect(result.skipped).toEqual([]);
    expect(result.placed.filter((sound) => sound.kind === "tick").length).toBeGreaterThanOrEqual(10);
  }, MEDIA_TIMEOUT);

  it("skips a sound shorter than one frame at a very low frame rate instead of failing the call", async () => {
    setFps(10);
    const result = await place({ cues: [{ at: 2, kind: "tick" }, { at: 4, kind: "click" }] });
    expect(result.placed.map((sound) => sound.kind)).toEqual(["click"]);
    expect(result.skipped).toEqual([expect.objectContaining({ kind: "tick", reason: expect.stringContaining("shorter than one frame at 10 fps") })]);
  }, MEDIA_TIMEOUT);

  it("keeps the anchor at the start of the clip when the head with it is cut off, and says so", async () => {
    const result = await place({ cues: [{ at: 0.02, kind: "click", role: "tap" }] });
    expect(result.placed[0]).toMatchObject({ start: 0 });
    expect(result.placed[0]!.anchorAt).toBeGreaterThanOrEqual(0);
    expect(result.warnings.join("\n")).toContain("loses its anchor");
  }, MEDIA_TIMEOUT);
});

describe("sound.place in review mode", () => {
  it("is one proposal and changes the timeline only once accepted", async () => {
    const ui = await connectToDaemon(daemon.socketPath, { client: "desktop/test" });
    try {
      await ui.request("review.set", { cwd: root, enabled: true });
      const before = readFileSync(join(root, "timelines", "main.json"), "utf8");
      const result = await place({ cues: [{ at: 1, kind: "click" }, { at: 3, kind: "pop" }] });
      expect(result.placed).toHaveLength(2);
      expect(readFileSync(join(root, "timelines", "main.json"), "utf8")).toBe(before);
      const { proposal } = await conn.request("proposal.status", { cwd: root });
      expect(proposal).toMatchObject({ tx: result.tx, label: "Sound: 1 click, 1 pop", operations: 3, state: "ready" });
      await ui.request("proposal.accept", { cwd: root, tx: result.tx! });
      const accepted = await timeline();
      expect(accepted.tracks.flatMap((track) => (track.kind === "audio" ? track.clips : [])).map((clip) => clip.id)).toEqual(result.placed.map((sound) => sound.clip));
    } finally {
      ui.close();
    }
  }, MEDIA_TIMEOUT);
});
