import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EnergyStore, FrameGrid, profileLevel, snapToPause, type EnergyProfile } from "../src/index.js";
import { mediaTools } from "./media-tools.js";
import { speechLike, speechLikeWav } from "./speech-fixture.js";

// Seam under test: EnergyStore.profile(root, asset). Real managed ffmpeg for the
// no-sidecar path; the sidecar path reads raw PCM without ffmpeg.

const HASH = `sha256:${"ab".repeat(32)}`;
const noFfmpeg = async (): Promise<string> => {
  throw new Error("ffmpeg must not run");
};

function project(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-energy-")));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "assets", "speech.wav"), speechLikeWav(16_000));
  return root;
}

/** Snap 0.7 s (inside the first word, 0.1-0.8) with the store's profile. */
function snapNearFirstPause(profile: EnergyProfile) {
  return snapToPause({ time: 0.7, window: 0.5, grid: new FrameGrid(30), level: (t) => profileLevel(profile, t), min: 0 });
}

describe("EnergyStore", () => {
  it("decodes an asset without sidecar through ffmpeg and caches the envelope under .frameshell/energy", async () => {
    const root = project();
    const { ffmpeg } = await mediaTools();
    const store = new EnergyStore({ derivedAudio: async () => ({ hash: HASH, sidecar: null }), ffmpeg: async () => ffmpeg });
    const profile = await store.profile(root, "assets/speech.wav");
    expect(profile.db.length).toBeGreaterThanOrEqual(829);
    const snapped = snapNearFirstPause(profile);
    expect(snapped.clean).toBe(true);
    expect(snapped.time).toBeGreaterThan(0.8);
    expect(snapped.time).toBeLessThan(1.1);

    const cached = readdirSync(join(root, ".frameshell", "energy"));
    expect(cached).toEqual([expect.stringMatching(/^abab.*\.f32$/)]);
    // A fresh store (new daemon) reads the cache: no decode.
    const again = await new EnergyStore({ derivedAudio: async () => ({ hash: HASH, sidecar: null }), ffmpeg: noFfmpeg }).profile(
      root,
      "assets/speech.wav",
    );
    expect(Array.from(again.db)).toEqual(Array.from(profile.db));
    expect(again.threshold).toBe(profile.threshold);
  });

  it("reads the PCM sidecar when ingest made one", async () => {
    const root = project();
    // Stereo 48 kHz sidecar, same content on both channels.
    const mono = speechLike(48_000);
    const stereo = new Int16Array(mono.length * 2);
    mono.forEach((sample, i) => stereo.set([sample, sample], i * 2));
    mkdirSync(join(root, ".frameshell", "proxies"), { recursive: true });
    writeFileSync(join(root, ".frameshell", "proxies", "side.pcm"), Buffer.from(stereo.buffer));
    const sidecar = { path: ".frameshell/proxies/side.pcm", format: "s16le" as const, sampleRate: 48_000, channels: 2 };
    const store = new EnergyStore({ derivedAudio: async () => ({ hash: HASH, sidecar }), ffmpeg: noFfmpeg });
    const profile = await store.profile(root, "assets/speech.wav");
    expect(snapNearFirstPause(profile).clean).toBe(true);
    expect(existsSync(join(root, ".frameshell", "energy"))).toBe(true);
  });
});
