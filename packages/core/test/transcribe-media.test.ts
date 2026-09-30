import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TranscriptionProvider } from "@frameshell/plugin-api";
import type { AssetInfo } from "@frameshell/protocol";
import { readWav } from "../../../plugins/whisper-cpp/src/audio.js";
import { TRANSCRIPTION_SAMPLE_RATE, transcribeAsset } from "../src/index.js";
import { JobQueue } from "../src/jobs/queue.js";
import { MediaService } from "../src/media/service.js";
import { ProjectRegistry } from "../src/projects.js";
import { tempDir } from "./helpers.js";
import { SYNC_MARK_S, makeVfrRecording } from "./media-fixtures.js";
import { testBinaryManager } from "./media-tools.js";

// Real managed ffmpeg: ingest writes the sidecar, the default extractor resamples it; only the engine is fake.
const MEDIA_TIMEOUT = 120_000;
/** One 10 ms energy frame: whisper.cpp's timestamp resolution. */
const TOLERANCE_S = 0.02;

const services: MediaService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

/** Fresh project and a media service over it (no watcher: ingest only on import). */
async function setup() {
  const root = tempDir();
  await new ProjectRegistry().init(root);
  const jobs = new JobQueue();
  const media = new MediaService({ binaries: testBinaryManager(), jobs, watch: false });
  services.push(media);
  return { root, jobs, media };
}

async function waitReady(media: MediaService, root: string, rel: string): Promise<AssetInfo> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const asset = (await media.list(root)).find((a) => a.path === rel);
    if (asset?.state === "ready") return asset;
    if (asset?.state === "failed" || Date.now() > deadline) throw new Error(`ingest of ${rel}: ${JSON.stringify(asset)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Provider that decodes the WAV it gets with the whisper-cpp plugin's reader and reports the first loud sample. */
function onsetProbe() {
  const seen: { sampleRate: number; onset: number }[] = [];
  const provider: TranscriptionProvider = {
    id: "probe",
    async transcribe(audio) {
      const { sampleRate, samples } = readWav(readFileSync(audio));
      seen.push({ sampleRate, onset: samples.findIndex((s) => Math.abs(s) > 3000) / sampleRate });
      return { model: "probe", words: [] };
    },
  };
  return { provider, seen };
}

function transcribe(root: string, media: MediaService, provider: TranscriptionProvider, rel: string) {
  const binaries = testBinaryManager();
  return transcribeAsset({
    projectDir: root,
    asset: join(root, ...rel.split("/")),
    providerId: provider.id,
    provider,
    tools: { ensureBinary: (name) => binaries.ensure(name), ensureModel: async (id) => id },
    media: { derivedAudio: (assetRel, onProgress) => media.derivedAudio(root, assetRel, onProgress) },
  });
}

describe("transcription audio from the media store", () => {
  it(
    "after import, reads the PCM sidecar the ingest produced, resampled to 16 kHz mono",
    async () => {
      const { root, media } = await setup();
      const source = join(tempDir(), "phone.mp4");
      await makeVfrRecording(source);
      const { imported } = await media.import(root, [source], "copy");
      const asset = await waitReady(media, root, imported[0]!.asset);
      expect(asset.sidecar).toMatchObject({ format: "s16le", sampleRate: 48_000, channels: 1 });

      const probe = onsetProbe();
      const result = await transcribe(root, media, probe.provider, asset.path);
      expect(result.audioSource).toBe(asset.sidecar!.path);
      expect(result.assetHash).toBe(asset.hash);
      expect(probe.seen[0]!.sampleRate).toBe(TRANSCRIPTION_SAMPLE_RATE);
      expect(Math.abs(probe.seen[0]!.onset - SYNC_MARK_S)).toBeLessThan(TOLERANCE_S);

      // Proof the sidecar is the input: move its beep to 2 s, drop the cached WAV, transcribe again.
      const sidecar = join(root, ...asset.sidecar!.path.split("/"));
      const pcm = Buffer.alloc(readFileSync(sidecar).length);
      for (let i = 2 * 48_000; i < 2.2 * 48_000; i++) pcm.writeInt16LE(Math.round(16_000 * Math.sin((2 * Math.PI * 1000 * i) / 48_000)), i * 2);
      writeFileSync(sidecar, pcm);
      rmSync(join(root, ".frameshell", "cache", "audio"), { recursive: true });
      await transcribe(root, media, probe.provider, asset.path);
      expect(Math.abs(probe.seen[1]!.onset - 2)).toBeLessThan(TOLERANCE_S);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "without a complete ingest, reads the asset itself on the same clock as the sidecar",
    async () => {
      const { root, media } = await setup();
      await makeVfrRecording(join(root, "assets", "phone.mp4"));
      expect((await media.list(root))[0]).toMatchObject({ state: "pending", sidecar: null });

      const probe = onsetProbe();
      const result = await transcribe(root, media, probe.provider, "assets/phone.mp4");
      expect(result.audioSource).toBe("assets/phone.mp4");
      expect(probe.seen[0]!.sampleRate).toBe(TRANSCRIPTION_SAMPLE_RATE);
      expect(Math.abs(probe.seen[0]!.onset - SYNC_MARK_S)).toBeLessThan(TOLERANCE_S);
      expect((await media.list(root))[0]!.state).toBe("pending"); // Never queued ingest.
    },
    MEDIA_TIMEOUT,
  );
});
