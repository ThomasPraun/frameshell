import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type DaemonConnection, ErrorCode, connectToDaemon } from "@frameshell/protocol";
import { CREDITS_FILE, SFX_JITTER, SFX_KINDS, SFX_LENGTH_RANGE, SFX_PEAK_DBFS, SFX_VARIANTS, SOUND_SAMPLE_RATE, createCreditsFile } from "@frameshell/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Daemon, type SfxRender, type SfxSpec, SOUND_DIR, sfxFile, sfxKey, sfxWavBytes, soundMarkOf, startDaemon, synthesizeSfx } from "../src/index.js";
import { wavBytes } from "../src/transcripts/window.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { testBinaryManager } from "./media-tools.js";

// Seams under test: the synth (`synthesizeSfx`), the take file (`sfxWavBytes`, `soundMarkOf`) and `sound.sfx`
// through a real in-process daemon (ADR 0038).

const hashOf = (render: SfxRender) => {
  const hash = createHash("sha256");
  for (const channel of render.channels) hash.update(Buffer.from(channel.buffer, channel.byteOffset, channel.byteLength));
  return hash.digest("hex").slice(0, 16);
};

/** RMS of `channel` over [from, to) seconds. */
const rms = (render: SfxRender, from: number, to: number) => {
  const channel = render.channels[0]!;
  const first = Math.floor(from * render.sampleRate);
  const last = Math.min(channel.length, Math.ceil(to * render.sampleRate));
  let sum = 0;
  for (let i = first; i < last; i++) sum += channel[i]! * channel[i]!;
  return Math.sqrt(sum / Math.max(1, last - first));
};

// PCM hashes at seed 7: a recipe or primitive that changes a sample fails here, and so does a machine whose Math functions differ.
const HASHES: Record<string, string> = {
  "click 1": "aa204b2461264448",
  "click 2": "3413b62473d54ffc",
  "click 3": "6f137e040e303457",
  "tick 1": "946be528da7af1a6",
  "tick 2": "558d2e9db34cf3ef",
  "tick 3": "3d477e11e852d728",
  "pop 1": "01184a265793f32a",
  "pop 2": "4cb31dcfd89fbee8",
  "pop 3": "50b7f3d447875c94",
  "whoosh 1": "e9c64897c097241e",
  "whoosh 2": "b89e06618e9898c6",
  "whoosh 3": "6715343cd28e2442",
  "riser 1": "de36573ad527fe1b",
  "riser 2": "3cea3a018ad08907",
  "riser 3": "9632034e11dbaf5c",
  "thump 1": "e31ae0e3cfd0c586",
  "thump 2": "d6fde0b32a5cda73",
  "thump 3": "3ed53763527041ab",
  "impact 1": "b1d847c737037e2c",
  "impact 2": "a16d3406837d9556",
  "impact 3": "aec7e5db3fb95032",
  "shutter 1": "edd9de71d38e2c2e",
  "shutter 2": "5b009d03986cd139",
  "shutter 3": "0747d87192a665dc",
};

const cases = SFX_KINDS.flatMap((kind) => Array.from({ length: SFX_VARIANTS }, (_, i) => ({ kind, variant: i + 1 })));

describe("synthesizeSfx", () => {
  it.each(cases)("$kind $variant is the same samples for the same seed", ({ kind, variant }) => {
    const render = synthesizeSfx({ kind, variant, seed: 7 });
    expect(hashOf(render)).toBe(HASHES[`${kind} ${variant}`]);
    expect(hashOf(synthesizeSfx({ kind, variant, seed: 7 }))).toBe(hashOf(render));
  });

  it.each(cases)("$kind $variant is audible, peaks near the fixed level and keeps head-room", ({ kind, variant }) => {
    const render = synthesizeSfx({ kind, variant, seed: 3 });
    expect(render.channels).toHaveLength(kind === "whoosh" ? 2 : 1);
    expect(render.sampleRate).toBe(SOUND_SAMPLE_RATE);
    expect(render.peakDb).toBeGreaterThanOrEqual(SFX_PEAK_DBFS - SFX_JITTER.levelDb - 0.05);
    expect(render.peakDb).toBeLessThanOrEqual(SFX_PEAK_DBFS + SFX_JITTER.levelDb + 0.05);
    expect(render.peakDb).toBeLessThan(-1);
    expect(render.rmsDb).toBeGreaterThan(-40);
    expect(render.pitch).toBeGreaterThanOrEqual(SFX_JITTER.pitch.min);
    expect(render.pitch).toBeLessThanOrEqual(SFX_JITTER.pitch.max);
    expect(Math.abs(render.levelDb)).toBeLessThanOrEqual(SFX_JITTER.levelDb);
    // The tail is faded out, never cut.
    for (const channel of render.channels) expect(Math.abs(channel[channel.length - 1]!)).toBeLessThan(40);
  });

  it("gives other samples for another seed, variant or kind, and the family keeps one timbre", () => {
    const base = hashOf(synthesizeSfx({ kind: "pop", variant: 1, seed: 1 }));
    expect(hashOf(synthesizeSfx({ kind: "pop", variant: 1, seed: 2 }))).not.toBe(base);
    expect(hashOf(synthesizeSfx({ kind: "pop", variant: 2, seed: 1 }))).not.toBe(base);
    expect(hashOf(synthesizeSfx({ kind: "click", variant: 1, seed: 1 }))).not.toBe(base);
  });

  it("scales every frequency by an explicit pitch and ignores the seeded jitter then", () => {
    const low = synthesizeSfx({ kind: "pop", variant: 1, seed: 5, pitch: 0.8 });
    const high = synthesizeSfx({ kind: "pop", variant: 1, seed: 5, pitch: 1.6 });
    expect(low.pitch).toBe(0.8);
    expect(high.pitch).toBe(1.6);
    expect(hashOf(low)).not.toBe(hashOf(high));
    // Same seed: the level jitter does not move with the pitch.
    expect(low.levelDb).toBe(high.levelDb);
  });

  it("puts the anchor on the transient of a hit, the peak of a whoosh and the end of a riser", () => {
    for (const kind of ["click", "tick", "thump", "impact", "shutter"] as const) expect(synthesizeSfx({ kind, variant: 1, seed: 1 }).anchor).toBe(0);
    expect(synthesizeSfx({ kind: "pop", variant: 1, seed: 1 }).anchor).toBe(Math.round(0.002 * SOUND_SAMPLE_RATE));
    const whoosh = synthesizeSfx({ kind: "whoosh", variant: 1, seed: 1 });
    expect(whoosh.anchor / SOUND_SAMPLE_RATE).toBeCloseTo(0.45 * 0.85, 2);
    const riser = synthesizeSfx({ kind: "riser", variant: 2, seed: 1 });
    expect(riser.anchor).toBe(riser.channels[0]!.length);
  });

  it("swells a whoosh to its anchor, and builds a riser to its end", () => {
    const whoosh = synthesizeSfx({ kind: "whoosh", variant: 1, seed: 1 });
    const at = whoosh.anchor / SOUND_SAMPLE_RATE;
    const length = whoosh.channels[0]!.length / SOUND_SAMPLE_RATE;
    expect(rms(whoosh, at - 0.04, at + 0.04)).toBeGreaterThan(rms(whoosh, 0, 0.08) * 3);
    expect(rms(whoosh, at - 0.04, at + 0.04)).toBeGreaterThan(rms(whoosh, length - 0.1, length) * 3);
    const riser = synthesizeSfx({ kind: "riser", variant: 1, seed: 1 });
    const end = riser.channels[0]!.length / SOUND_SAMPLE_RATE;
    expect(rms(riser, end - 0.4, end - 0.02)).toBeGreaterThan(rms(riser, 0, 0.4) * 10);
  });

  it("pans a whoosh from left to right", () => {
    const { channels } = synthesizeSfx({ kind: "whoosh", variant: 2, seed: 1 });
    const energy = (channel: Int16Array, from: number, to: number) => channel.slice(from, to).reduce((sum, x) => sum + x * x, 0);
    const n = channels[0]!.length;
    expect(energy(channels[0]!, 0, n / 4)).toBeGreaterThan(energy(channels[1]!, 0, n / 4));
    expect(energy(channels[1]!, (3 * n) / 4, n)).toBeGreaterThan(energy(channels[0]!, (3 * n) / 4, n));
  });

  it("takes a length for a whoosh and a riser", () => {
    expect(synthesizeSfx({ kind: "whoosh", variant: 1, seed: 1, length: 1.5 }).channels[0]!.length).toBe(1.5 * SOUND_SAMPLE_RATE);
    expect(synthesizeSfx({ kind: "riser", variant: 1, seed: 1, length: 3 }).channels[0]!.length).toBe(3 * SOUND_SAMPLE_RATE);
  });

  it("refuses a variant outside 1 to 3", () => {
    expect(() => synthesizeSfx({ kind: "pop", variant: 4, seed: 1 })).toThrow(RangeError);
  });
});

describe("sound takes", () => {
  const spec: SfxSpec = { kind: "pop", variant: 2, seed: 9 };

  it("key every parameter that changes the samples, and name the file by kind and key", () => {
    const key = sfxKey(spec);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    for (const other of [{ kind: "click" }, { variant: 3 }, { seed: 10 }, { pitch: 1.1 }, { length: 2 }] as Partial<SfxSpec>[]) expect(sfxKey({ ...spec, ...other })).not.toBe(key);
    expect(sfxFile("pop", key)).toBe(`assets/sound/pop-${key.slice(0, 8)}.wav`);
  });

  it("carry their mark in a WAV that is plain 16-bit PCM at 48 kHz", () => {
    const render = synthesizeSfx(spec);
    const mark = { key: sfxKey(spec), kind: spec.kind, variant: 2, seed: 9, pitch: render.pitch, levelDb: render.levelDb, peakAt: 0.002 };
    const bytes = sfxWavBytes(render, mark);
    expect(soundMarkOf(bytes)).toEqual(mark);
    expect(bytes.readUInt16LE(20)).toBe(1);
    expect(bytes.readUInt16LE(22)).toBe(1);
    expect(bytes.readUInt32LE(24)).toBe(SOUND_SAMPLE_RATE);
    expect(bytes.readUInt16LE(34)).toBe(16);
    expect(bytes.readInt16LE(bytes.length - 2)).toBe(render.channels[0]![render.channels[0]!.length - 1]);
  });

  it("are not recognised in WAVs written elsewhere, or with a damaged mark", () => {
    expect(soundMarkOf(wavBytes({ sampleRate: 48000, bits: 16, channels: [new Int16Array(4)] }))).toBeNull();
    expect(soundMarkOf(wavBytes({ sampleRate: 48000, bits: 16, channels: [new Int16Array(4)] }, [{ id: "fssd", body: Buffer.from("{nope") }]))).toBeNull();
    expect(soundMarkOf(wavBytes({ sampleRate: 48000, bits: 16, channels: [new Int16Array(4)] }, [{ id: "fssd", body: Buffer.from('{"key":"a","kind":"gong"}') }]))).toBeNull();
  });
});

describe("wavBytes", () => {
  it("writes interleaved 24-bit stereo", () => {
    const bytes = wavBytes({ sampleRate: 48000, bits: 24, channels: [Int32Array.of(1, -2, 8_388_607), Int32Array.of(-8_388_608, 5, 0)] });
    expect(bytes.readUInt16LE(22)).toBe(2);
    expect(bytes.readUInt32LE(28)).toBe(48000 * 2 * 3);
    expect(bytes.readUInt16LE(32)).toBe(6);
    expect(bytes.readUInt16LE(34)).toBe(24);
    expect(bytes.readUInt32LE(40)).toBe(3 * 2 * 3);
    const samples = Array.from({ length: 6 }, (_, i) => bytes.readIntLE(44 + i * 3, 3));
    expect(samples).toEqual([1, -8_388_608, -2, 5, 8_388_607, 0]);
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
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
  root = join(tempDir(), "promo");
  await conn.request("project.init", { dir: root });
});

afterEach(async () => {
  conn.close();
  await daemon.close();
});

const sfx = (params: Record<string, unknown> = {}, options = {}) => conn.request("sound.sfx", { cwd: root, kind: "pop", ...params }, options);

describe("sound.sfx", () => {
  it("writes a marked take into assets/sound and imports it", async () => {
    const result = await sfx({ kind: "whoosh", variant: 2, seed: 4 });
    const key = sfxKey({ kind: "whoosh", variant: 2, seed: 4 });
    expect(result).toMatchObject({
      kind: "whoosh",
      variant: 2,
      seed: 4,
      file: `assets/sound/whoosh-${key.slice(0, 8)}.wav`,
      state: "generated",
      channels: 2,
      duration: 0.7,
      peakAt: 0.315,
      credited: false,
    });
    expect(result.imported.map((entry) => entry.asset)).toEqual([result.file]);
    const bytes = readFileSync(join(root, result.file));
    expect(soundMarkOf(bytes)).toMatchObject({ key, kind: "whoosh", variant: 2, seed: 4, peakAt: 0.315 });
    expect(bytes.readUInt16LE(22)).toBe(2);
    expect(SOUND_DIR).toBe("assets/sound");
  });

  it("writes the same file for the same parameters and reuses it", async () => {
    const first = await sfx({ seed: 3 });
    const bytes = readFileSync(join(root, first.file));
    const again = await sfx({ seed: 3 });
    expect(again).toMatchObject({ file: first.file, state: "cached", imported: [], peakAt: first.peakAt, peakDb: first.peakDb, duration: first.duration });
    expect(readFileSync(join(root, first.file))).toEqual(bytes);
    const other = await sfx({ seed: 4 });
    expect(other.file).not.toBe(first.file);
    expect(other.state).toBe("generated");
  });

  it("makes concurrent identical calls write the take once", async () => {
    const results = await Promise.all([sfx({ seed: 11 }), sfx({ seed: 11 })]);
    expect(results.map((result) => result.state).sort()).toEqual(["cached", "generated"]);
  });

  it("writes takes the managed ffmpeg ingests", async () => {
    const { imported, file } = await sfx({ kind: "whoosh" });
    const id = imported[0]!.job.id;
    const deadline = Date.now() + 90_000;
    let job;
    do {
      await new Promise((resolve) => setTimeout(resolve, 100));
      job = (await conn.request("job.list", { cwd: root })).jobs.find((entry) => entry.id === id);
    } while (job && job.state !== "done" && job.state !== "failed" && Date.now() < deadline);
    expect(job).toMatchObject({ state: "done", error: null });
    expect((await conn.request("asset.list", { cwd: root })).assets.map((asset) => asset.path)).toContain(file);
  }, 120_000);

  it("never overwrites a file of that name that it did not write", async () => {
    const key = sfxKey({ kind: "pop", variant: 1, seed: 0 });
    const path = join(root, "assets", "sound", `pop-${key.slice(0, 8)}.wav`);
    mkdirSync(join(root, "assets", "sound"), { recursive: true });
    writeFileSync(path, "mine");
    await expect(sfx()).rejects.toMatchObject({ code: ErrorCode.InvalidOperation, message: expect.stringContaining("never overwritten") });
    expect(readFileSync(path, "utf8")).toBe("mine");
  });

  it("refuses a length for a kind that has none, and one out of range", async () => {
    await expect(sfx({ kind: "click", length: 1 })).rejects.toMatchObject({ code: ErrorCode.InvalidParams, message: expect.stringContaining("fixed length") });
    const range = SFX_LENGTH_RANGE.riser!;
    await expect(sfx({ kind: "riser", length: range.max + 1 })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    expect((await sfx({ kind: "riser", length: 1.5 })).duration).toBe(1.5);
  });

  it("refuses a variant, seed or pitch out of range", async () => {
    await expect(sfx({ variant: 4 })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(sfx({ seed: -1 })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(sfx({ pitch: 5 })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(sfx({ kind: "gong" })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it("records the take as own work only when the project already keeps a ledger", async () => {
    const without = await sfx({ seed: 1 });
    expect(without.credited).toBe(false);
    expect(existsSync(join(root, CREDITS_FILE))).toBe(false);

    writeFileSync(join(root, CREDITS_FILE), `${JSON.stringify(createCreditsFile(), null, 2)}\n`);
    const withLedger = await sfx({ seed: 2 });
    expect(withLedger.credited).toBe(true);
    const ledger = JSON.parse(readFileSync(join(root, CREDITS_FILE), "utf8")) as { assets: { asset: string; licence: string; author: string; hash: string }[] };
    expect(ledger.assets).toEqual([expect.objectContaining({ asset: withLedger.file, licence: "own", author: "Frameshell sound synth", hash: expect.stringMatching(/^sha256:/) })]);

    // A take made before the ledger existed is recorded the next time it is asked for; an entry is not written twice.
    const earlier = await sfx({ seed: 1 });
    expect(earlier).toMatchObject({ state: "cached", credited: true });
    const before = readFileSync(join(root, CREDITS_FILE), "utf8");
    expect(await sfx({ seed: 1 })).toMatchObject({ credited: true });
    expect(readFileSync(join(root, CREDITS_FILE), "utf8")).toBe(before);
    expect(JSON.parse(before).assets).toHaveLength(2);
  });

  it("replays a retried request from its idempotency key", async () => {
    const key = "sound-retry-0001";
    const first = await sfx({ seed: 21 }, { idempotencyKey: key });
    const replay = await sfx({ seed: 21 }, { idempotencyKey: key });
    expect(replay).toEqual(first);
    expect(first.state).toBe("generated");
  });
});
