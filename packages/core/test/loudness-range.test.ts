import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { LOUDNESS_DIR, LoudnessStore } from "../src/index.js";
import { classifyLoudness } from "../src/media/loudness-store.js";
import { wavOf } from "./beat-fixture.js";
import { tempDir } from "./helpers.js";
import { mediaTools } from "./media-tools.js";

// A 10 s tone that is quiet for 5 s and 20 dB louder for the next 5: the reading of a part of the file is of that part.
const RATE = 16_000;
const HASH = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef";
const MEDIA_TIMEOUT = 120_000;

let project: string;
let ffmpeg: string;

const store = (options: { fail?: boolean } = {}) =>
  new LoudnessStore({
    derivedAudio: async () => ({ hash: HASH }),
    ffmpeg: async () => {
      if (options.fail) throw new Error("ffmpeg must not run: the reading is cached");
      return ffmpeg;
    },
    duration: async () => 10,
  });
const cached = () => readdirSync(join(project, ...LOUDNESS_DIR.split("/"))).sort();

beforeAll(async () => {
  ffmpeg = (await mediaTools()).ffmpeg;
  project = tempDir();
  mkdirSync(join(project, "assets"), { recursive: true });
  const samples = new Float32Array(10 * RATE);
  for (let i = 0; i < samples.length; i++) samples[i] = (i < 5 * RATE ? 0.05 : 0.5) * Math.sin((2 * Math.PI * 440 * i) / RATE);
  writeFileSync(join(project, "assets", "halves.wav"), wavOf(samples, RATE));
}, MEDIA_TIMEOUT);

describe("LoudnessStore over a part of a file", () => {
  it(
    "reads the part asked, keeps it beside the whole-file reading and does not measure it twice",
    async () => {
      const first = store();
      const quiet = await first.reading(project, "assets/halves.wav", { start: 0.5, end: 4.5 });
      const loud = await first.reading(project, "assets/halves.wav", { start: 5.5, end: 9.5 });
      const whole = await first.reading(project, "assets/halves.wav");
      // 20 dB between the halves; the average of the whole file sits near the louder half.
      expect(loud.integrated! - quiet.integrated!).toBeGreaterThan(18);
      expect(loud.integrated! - quiet.integrated!).toBeLessThan(22);
      expect(whole.integrated!).toBeGreaterThan(quiet.integrated! + 10);
      expect(whole.integrated!).toBeLessThan(loud.integrated! + 0.1);
      const key = "0123456789abcdef0123-l1";
      expect(cached()).toEqual([`${key}-r500-4500.json`, `${key}-r5500-9500.json`, `${key}.json`].sort());

      // A second store, as after a restart, reads the files: ffmpeg is not asked.
      const again = store({ fail: true });
      expect(await again.reading(project, "assets/halves.wav", { start: 0.5, end: 4.5 })).toEqual(quiet);
      expect(await again.reading(project, "assets/halves.wav", { start: 5.5, end: 9.5 })).toEqual(loud);
      expect(await again.reading(project, "assets/halves.wav")).toEqual(whole);
      expect(cached()).toHaveLength(3);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "takes a part that spans the file, or is shorter than a gating block, as the whole-file reading",
    async () => {
      const reader = store({ fail: true });
      const whole = await store().reading(project, "assets/halves.wav");
      expect(await reader.reading(project, "assets/halves.wav", { start: 0, end: 10 })).toEqual(whole);
      expect(await reader.reading(project, "assets/halves.wav", { start: 0.02, end: 9.99 })).toEqual(whole);
      expect(await reader.reading(project, "assets/halves.wav", { start: 6, end: 6.2 })).toEqual(whole);
      expect(cached().filter((name) => name.includes("-r"))).toHaveLength(2);
    },
    MEDIA_TIMEOUT,
  );

  it("keeps every reading of a file with the file for gc, and sweeps only what no content has", () => {
    for (const name of cached()) {
      expect(classifyLoudness(name, false)).toEqual({ kind: "loudness", key: "0123456789abcdef0123-l1" });
    }
  });
});
