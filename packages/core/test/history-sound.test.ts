import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, connectToDaemon } from "@frameshell/protocol";
import { soundDiff } from "../src/review/sound-diff.js";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { mediaTools, run, testBinaryManager } from "./media-tools.js";

// `history.sound`: what one transaction did to the sound, per track, measured from the assets' envelopes on a real
// managed ffmpeg. Fixtures are synthetic and made per run.
const MEDIA_TIMEOUT = 180_000;

/** A level series of `hops` 10 ms hops at `db`, with `[from, to)` hops set to `inside`. */
function series(hops: number, db: number, from = 0, to = 0, inside = db): Float64Array {
  return Float64Array.from({ length: hops }, (_, i) => (i >= from && i < to ? inside : db));
}

describe("soundDiff", () => {
  it("tells sound that came in, went and changed level, and joins hops closer than 0.1 s", () => {
    const names = new Map([
      ["a", "Music"],
      ["b", "SFX"],
      ["c", "Voice"],
    ]);
    const { tracks, unchanged } = soundDiff(
      new Map([
        ["a", series(300, -20)],
        ["b", series(300, -120)],
        ["c", series(300, -18)],
      ]),
      new Map([
        // 6 dB down from 1.0 to 1.5 s and from 1.55 to 2.0 s: one range, the 50 ms between them is under the gap.
        ["a", Float64Array.from(series(300, -20), (db, i) => ((i >= 100 && i < 150) || (i >= 155 && i < 200) ? -26 : db))],
        ["b", series(300, -120, 50, 80, -10)],
        // Half a dB: no change. Three hops: shorter than 50 ms, no change either.
        ["c", Float64Array.from(series(300, -18.5), (db, i) => (i >= 10 && i < 13 ? -40 : db))],
      ]),
      names,
    );
    expect(tracks).toEqual([
      { track: "a", name: "Music", ranges: [{ from: 1, to: 2, kind: "level", change: -6, largest: -6 }], more: 0 },
      { track: "b", name: "SFX", ranges: [{ from: 0.5, to: 0.8, kind: "added", change: 50, largest: 50 }], more: 0 },
    ]);
    expect(unchanged).toEqual(["c"]);
  });

  it("calls sound that went silent removed, and ignores moves under the -60 dBFS floor", () => {
    const { tracks } = soundDiff(
      new Map([["a", Float64Array.from(series(200, -20), (db, i) => (i >= 100 ? -70 : db))]]),
      new Map([["a", Float64Array.from(series(200, -120), (db, i) => (i >= 100 ? -90 : db))]]),
      new Map(),
    );
    expect(tracks).toEqual([{ track: "a", name: "a", ranges: [{ from: 0, to: 1, kind: "removed", change: -40, largest: -40 }], more: 0 }]);
  });
});

let daemon: Daemon;
let conn: DaemonConnection;

async function makeSound(path: string, seconds: number, sound: string): Promise<void> {
  const { ffmpeg } = await mediaTools();
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `aevalsrc='${sound}':s=48000:d=${seconds}`, "-c:a", "pcm_s16le", path]);
}

beforeAll(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), binaries: testBinaryManager(), idleTimeoutMs: Infinity, dirs: { dataDir: tempDir(), configDir: tempDir() } });
  conn = await connectToDaemon(daemon.socketPath, { client: "cli/test", session: "term-1" });
}, MEDIA_TIMEOUT);

afterAll(async () => {
  conn.close();
  await daemon.close();
});

describe("history.sound", () => {
  it(
    "names only the track a transaction changed, where and by how much, and nothing for a config-only one",
    async () => {
      const dir = tempDir();
      await conn.request("project.init", { dir });
      const source = tempDir();
      await makeSound(join(source, "vo.wav"), 4, "0.4*sin(2*PI*300*t)");
      await makeSound(join(source, "song.wav"), 4, "0.4*sin(2*PI*220*t)");
      const { imported } = await conn.request("asset.import", { cwd: dir, files: [join(source, "vo.wav"), join(source, "song.wav")] });
      const [vo, song] = imported.map((item) => item.asset);
      const voice = (await conn.request("track.add", { cwd: dir, kind: "audio", name: "Voiceover" })).changes.added[0]!;
      const music = (await conn.request("track.add", { cwd: dir, kind: "audio", name: "Music" })).changes.added[0]!;
      await conn.request("clip.add", { cwd: dir, track: voice, asset: vo!, start: 0, in: 0, out: 4 });
      const songClip = (await conn.request("clip.add", { cwd: dir, track: music, asset: song!, start: 0, in: 0, out: 4 })).changes.added[0]!;

      const { tx } = await conn.request("tx.begin", { label: "music down" });
      await conn.request("clip.set", { cwd: dir, clip: songClip, gain: -6 });
      await conn.request("tx.commit", {});

      const result = await conn.request("history.sound", { cwd: dir, timeline: "main", target: tx });
      expect(result.unheard).toEqual([]);
      expect(result.unchanged).toEqual([voice]);
      expect(result.tracks).toHaveLength(1);
      expect(result.tracks[0]).toMatchObject({ track: music, name: "Music", more: 0 });
      expect(result.tracks[0]!.ranges).toHaveLength(1);
      expect(result.tracks[0]!.ranges[0]).toMatchObject({ from: 0, to: 4, kind: "level", change: -6 });

      const format = await conn.request("format.add", { cwd: dir, id: "9x16" });
      const config = await conn.request("history.sound", { cwd: dir, timeline: "main", target: format.tx });
      expect(config).toEqual({ timeline: "main", target: format.tx, tracks: [], unchanged: [], unheard: [] });
    },
    MEDIA_TIMEOUT,
  );
});
