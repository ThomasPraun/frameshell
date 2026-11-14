import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, type ReviewMetrics, connectToDaemon } from "@frameshell/protocol";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { mediaTools, run, testBinaryManager } from "./media-tools.js";

// The sound review list of `review` (#457) on a real managed ffmpeg: a timeline heard clip by clip from its assets'
// envelopes, and a file's decoded mix (its end and its clicks). Every fixture is synthetic and made per test run.
const MEDIA_TIMEOUT = 180_000;

let daemon: Daemon;
let conn: DaemonConnection;

/** `seconds` of 320x240 black picture with the sound of `aevalsrc` expression `sound`, PCM in Matroska (no AAC smearing a click). */
async function makeFilm(path: string, seconds: number, sound: string): Promise<void> {
  const { ffmpeg } = await mediaTools();
  await run(ffmpeg, [
    ...["-hide_banner", "-loglevel", "error", "-y"],
    ...["-f", "lavfi", "-i", `color=c=black:s=320x240:r=30:d=${seconds}`],
    ...["-f", "lavfi", "-i", `aevalsrc='${sound}':s=48000:d=${seconds}`],
    ...["-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", "-shortest", path],
  ]);
}

/** A mono WAV of `seconds` of `aevalsrc` expression `sound`. */
async function makeSound(path: string, seconds: number, sound: string): Promise<void> {
  const { ffmpeg } = await mediaTools();
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `aevalsrc='${sound}':s=48000:d=${seconds}`, "-c:a", "pcm_s16le", path]);
}

beforeAll(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), binaries: testBinaryManager(), idleTimeoutMs: Infinity, dirs: { dataDir: tempDir(), configDir: tempDir() } });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
}, MEDIA_TIMEOUT);

afterAll(async () => {
  conn.close();
  await daemon.close();
});

describe("review sound of a file", () => {
  it(
    "finds a click in the decoded sound, and reads the end and the loudest moment of the mix",
    async () => {
      const project = tempDir();
      await conn.request("project.init", { dir: project });
      // A soft tone with a jump at 1.0 s, loudest in its last second and still sounding at the end.
      const film = join(tempDir(), "clicky.mkv");
      // The swell is a 0.2 s ramp: a step in level would be a click of its own.
      await makeFilm(film, 4, "(0.1+0.4*min(1,max(0,(t-3.4)/0.2)))*sin(2*PI*440*t)+0.6*between(t,1,1.00003)");
      const result = await conn.request("review", { cwd: project, file: film, sheets: ["metrics"] });
      const sound = result.metrics!.sound!;
      expect(sound.source).toBe("file");
      expect(sound.clicks!.count).toBe(1);
      expect(sound.clicks!.at[0]!).toBeCloseTo(1, 2);
      expect(sound.ending!.measure).toBe("mix");
      expect(sound.ending!.level!).toBeGreaterThan(-45);
      expect(sound.ending!.loudestShare!).toBeGreaterThan(0.85);
      const checks = result.metrics!.craft.map((warning) => warning.check);
      expect(checks.filter((check) => check === "click")).toHaveLength(1);
      expect(checks.filter((check) => check === "ending")).toHaveLength(2);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "a tone that fades before the end has no click and no ending warning",
    async () => {
      const project = tempDir();
      await conn.request("project.init", { dir: project });
      const film = join(tempDir(), "clean.mkv");
      // Smooth throughout: a 50 ms fade in, a swell around 0.75 s, a 0.5 s fade out to silence at 2.5 s.
      await makeFilm(film, 3, "0.4*sin(2*PI*440*t)*max(0,min(1,(2.5-t)/0.5))*min(1,t/0.05)*(1+0.5*exp(-20*(t-0.75)*(t-0.75)))");
      const { metrics } = (await conn.request("review", { cwd: project, file: film, sheets: ["metrics"] })) as { metrics: ReviewMetrics };
      expect(metrics.sound!.clicks).toEqual({ count: 0, at: [] });
      expect(metrics.sound!.ending!.level).toBeNull();
      expect(metrics.craft.filter((warning) => ["click", "ending"].includes(warning.check))).toEqual([]);
    },
    MEDIA_TIMEOUT,
  );
});

describe("review sound of a timeline", () => {
  it(
    "hears each clip by role: the bed level with the voice, an effect three times, a voice cut while loud, the music cut on the last frame",
    async () => {
      const dir = tempDir();
      await conn.request("project.init", { dir });
      const source = tempDir();
      const picture = join(source, "picture.mp4");
      await makeFilm(picture, 3, "0");
      // The voice speaks for 2.5 s of 3; the clip below stops it at 2 s, mid-word.
      await makeSound(join(source, "vo.wav"), 3, "0.5*sin(2*PI*300*t)*lt(t,2.5)");
      await makeSound(join(source, "song.wav"), 4, "0.5*sin(2*PI*220*t)");
      await makeSound(join(source, "boom.wav"), 0.3, "0.8*sin(2*PI*90*t)*exp(-t*30)");
      const { imported } = await conn.request("asset.import", { cwd: dir, files: [picture, join(source, "vo.wav"), join(source, "song.wav"), join(source, "boom.wav")] });
      const [film, vo, song, boom] = imported.map((item) => item.asset);
      const add = async (kind: "video" | "audio", name?: string) => (await conn.request("track.add", { cwd: dir, kind, ...(name ? { name } : {}) })).changes.added[0]!;
      const video = await add("video");
      const voice = await add("audio", "Voiceover");
      const music = await add("audio", "Music");
      const effects = await add("audio", "SFX");
      await conn.request("clip.add", { cwd: dir, track: video, asset: film!, start: 0, in: 0, out: 3 });
      await conn.request("clip.add", { cwd: dir, track: voice, asset: vo!, start: 0, in: 0, out: 2 });
      await conn.request("clip.add", { cwd: dir, track: music, asset: song!, start: 0, in: 0, out: 3 });
      for (const at of [0.5, 1.2, 2.4]) await conn.request("clip.add", { cwd: dir, track: effects, asset: boom!, start: at, in: 0, out: 0.3 });

      const { metrics, warnings } = (await conn.request("review", { cwd: dir, sheets: ["metrics"] })) as { metrics: ReviewMetrics; warnings: string[] };
      const sound = metrics.sound!;
      expect(warnings.filter((warning) => warning.startsWith("sound:"))).toEqual([]);
      expect(sound).toMatchObject({ source: "timeline", clips: { voice: 1, music: 1, sfx: 3, other: 0 }, clicks: null });
      expect(sound.voice!.windows).toBe(4);
      expect(sound.voice!.minMargin!).toBeLessThan(1);
      expect(sound.voice!.low).toHaveLength(1);
      expect(sound.repeats).toEqual([{ file: boom, plays: 3, at: [0.5, 1.2, 2.4] }]);
      expect(sound.chopped!.map((entry) => [entry.track, entry.role, entry.at])).toEqual([[voice, "voice", 2]]);
      expect(sound.ending).toMatchObject({ measure: "music", musicEndsAt: 3 });
      expect(sound.ending!.level!).toBeGreaterThan(-3);
      const checks = new Set(metrics.craft.map((warning) => warning.check));
      for (const check of ["voice-bed", "sfx-repeat", "chopped", "ending"]) expect(checks.has(check as never), check).toBe(true);
      expect(checks.has("machine-gun")).toBe(false);
    },
    MEDIA_TIMEOUT,
  );
});
