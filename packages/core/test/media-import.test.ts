import { copyFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AssetInfo, type DaemonConnection, ErrorCode, type JobInfo, connectToDaemon } from "@frameshell/protocol";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import {
  SYNC_MARK_S,
  ffprobeJson,
  firstLoudSample,
  frameLuma,
  makeClip,
  makeVfrRecording,
  readS16le,
  topLevelBoxes,
} from "./media-fixtures.js";
import { testBinaryManager } from "./media-tools.js";

// Real managed ffmpeg on tiny synthetic media: the proxy recipe (ADR 0001) is only proven by decoding the output.
const MEDIA_TIMEOUT = 120_000;

let daemon: Daemon;
let conn: DaemonConnection;
let project: string;

async function openDaemon(idleTimeoutMs = Infinity) {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), binaries: testBinaryManager(), idleTimeoutMs });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
}

beforeEach(async () => {
  await openDaemon();
  project = tempDir();
  await conn.request("project.init", { dir: project });
});
afterEach(async () => {
  conn.close();
  await daemon.close();
});

async function waitFor<T>(probe: () => Promise<T | undefined>, what: string, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function waitForJob(id: string, c: DaemonConnection = conn): Promise<JobInfo> {
  return waitFor(async () => {
    const { jobs } = await c.request("job.list", { cwd: project });
    const job = jobs.find((j) => j.id === id);
    return job && (job.state === "done" || job.state === "failed") ? job : undefined;
  }, `job ${id}`);
}

async function assetInfo(path: string): Promise<AssetInfo> {
  const { assets } = await conn.request("asset.list", { cwd: project });
  const asset = assets.find((a) => a.path === path);
  if (!asset) throw new Error(`${path} not listed: ${JSON.stringify(assets)}`);
  return asset;
}

async function importOne(source: string): Promise<{ asset: string; job: JobInfo }> {
  const { imported } = await conn.request("asset.import", { cwd: project, files: [source] });
  const [entry] = imported;
  return { asset: entry!.asset, job: await waitForJob(entry!.job.id) };
}

describe("asset import", () => {
  it(
    "turns a VFR recording into a CFR proxy with fixed GOP 15, no B-frames, faststart and A/V in sync",
    async () => {
      const source = join(tempDir(), "phone.mp4");
      await makeVfrRecording(source);
      const sourceVideo = (await ffprobeJson(source, ["-select_streams", "v:0", "-show_entries", "stream=r_frame_rate,avg_frame_rate"]))
        .streams as { r_frame_rate: string; avg_frame_rate: string }[];
      expect(sourceVideo[0]!.r_frame_rate).not.toBe(sourceVideo[0]!.avg_frame_rate); // Really VFR.

      const { asset, job } = await importOne(source);
      expect(job).toMatchObject({ state: "done", error: null, cached: false, progress: 1 });
      expect(asset).toBe("assets/phone.mp4");
      expect(readFileSync(join(project, asset))).toEqual(readFileSync(source));

      const info = await assetInfo(asset);
      expect(info).toMatchObject({ state: "ready", hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });
      expect(info.media).toMatchObject({ video: { width: 160, height: 120, vfr: true }, audio: { sampleRate: 44100 } });
      const proxy = join(project, info.proxy!);

      // CFR at project fps (30): every packet lasts exactly one frame, pts = index / 30.
      const probed = {
        ...((await ffprobeJson(proxy, [
          ...["-select_streams", "v:0", "-show_entries"],
          "stream=codec_name,r_frame_rate,avg_frame_rate,has_b_frames,duration:packet=pts,duration,flags",
        ])) as {
          streams: { codec_name: string; r_frame_rate: string; avg_frame_rate: string; has_b_frames: number; duration: string }[];
          packets: { pts: number; duration: number; flags: string }[];
        }),
        ...((await ffprobeJson(proxy, ["-select_streams", "v:0", "-show_entries", "frame=pict_type"])) as {
          frames: { pict_type: string }[];
        }),
      };
      const stream = probed.streams[0]!;
      expect(stream).toMatchObject({ codec_name: "h264", r_frame_rate: "30/1", avg_frame_rate: "30/1", has_b_frames: 0 });
      const frameTicks = probed.packets[0]!.duration;
      probed.packets.forEach((packet, index) => {
        expect(packet.duration).toBe(frameTicks);
        expect(packet.pts).toBe(index * frameTicks);
      });
      // No B-frames: decode order = display order.
      expect(new Set(probed.frames.map((f) => f.pict_type))).not.toContain("B");
      // Fixed GOP 15: keyframes exactly at 0, 15, 30…
      const keyframes = probed.packets.flatMap((p, i) => (p.flags.startsWith("K") ? [i] : []));
      expect(keyframes).toEqual(Array.from({ length: Math.ceil(probed.packets.length / 15) }, (_, i) => i * 15));
      // Faststart: index before media data.
      const boxes = await topLevelBoxes(proxy);
      expect(boxes.indexOf("moov")).toBeLessThan(boxes.indexOf("mdat"));
      // Duration matches the source within one frame.
      const sourceDuration = Number(((await ffprobeJson(source, ["-show_entries", "format=duration"])).format as { duration: string }).duration);
      expect(Math.abs(Number(stream.duration) - sourceDuration)).toBeLessThanOrEqual(1 / 30);

      // A/V sync: the flash (frame index / fps) and the beep (sidecar sample / 48 kHz) agree within one frame.
      expect(info.sidecar).toMatchObject({ format: "s16le", sampleRate: 48000, channels: 1 });
      const samples = await readS16le(join(project, info.sidecar!.path));
      expect(Math.abs(samples.length / 48000 - sourceDuration)).toBeLessThanOrEqual(1 / 30);
      const beepS = firstLoudSample(samples) / 48000;
      const flashS = (await frameLuma(proxy)).findIndex((luma) => luma > 128) / 30;
      expect(Math.abs(beepS - SYNC_MARK_S)).toBeLessThanOrEqual(1 / 30);
      expect(Math.abs(flashS - SYNC_MARK_S)).toBeLessThanOrEqual(1 / 30);
      expect(Math.abs(flashS - beepS)).toBeLessThanOrEqual(1 / 30);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "writes a waveform and thumbnails, all under .frameshell/",
    async () => {
      const source = join(tempDir(), "phone.mp4");
      await makeVfrRecording(source);
      const { asset } = await importOne(source);
      const info = await assetInfo(asset);

      expect(info.waveform!.path).toMatch(/^\.frameshell\/waveforms\//);
      const waveform = JSON.parse(readFileSync(join(project, info.waveform!.path), "utf8")) as {
        peaksPerSecond: number;
        peaks: [number, number][];
      };
      expect(waveform.peaksPerSecond).toBe(info.waveform!.peaksPerSecond);
      const at = (s: number) => waveform.peaks[Math.floor(s * waveform.peaksPerSecond)]!;
      expect(Math.max(Math.abs(at(0.5)[0]), Math.abs(at(0.5)[1]))).toBeLessThan(3); // Silence.
      expect(at(SYNC_MARK_S + 0.1)[1]).toBeGreaterThan(40); // Beep at about half scale.

      const thumbs = info.thumbnails!;
      expect(thumbs.dir).toMatch(/^\.frameshell\/thumbs\//);
      expect(thumbs.count).toBeGreaterThanOrEqual(1);
      for (let n = 1; n <= thumbs.count; n++) {
        const file = readFileSync(join(project, thumbs.dir, `${String(n).padStart(4, "0")}.jpg`));
        expect(file.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8])); // JPEG.
      }
      expect(info.proxy).toMatch(/^\.frameshell\/proxies\//);
      expect(info.sidecar!.path).toMatch(/^\.frameshell\/proxies\//);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "reuses cached outputs when an unchanged asset is imported again, even under another name",
    async () => {
      const source = join(tempDir(), "phone.mp4");
      await makeVfrRecording(source);
      const first = await importOne(source);
      const proxy = join(project, (await assetInfo(first.asset)).proxy!);
      const builtAt = statSync(proxy).mtimeMs;

      const again = await importOne(source);
      expect(again.asset).toBe(first.asset); // Identical content, same name: no copy.
      expect(again.job).toMatchObject({ state: "done", cached: true });

      const renamed = join(tempDir(), "same-bytes.mp4");
      copyFileSync(source, renamed);
      const other = await importOne(renamed);
      expect(other.asset).toBe("assets/same-bytes.mp4");
      expect(other.job.cached).toBe(true);
      expect((await assetInfo(other.asset)).proxy).toBe((await assetInfo(first.asset)).proxy);
      expect(statSync(proxy).mtimeMs).toBe(builtAt);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "gives a clashing name with different content a suffix",
    async () => {
      const a = join(tempDir(), "clip.mp4");
      const b = join(tempDir(), "clip.mp4");
      await makeClip(a, { durationS: 0.5 });
      await makeClip(b, { durationS: 0.6 });
      const { imported } = await conn.request("asset.import", { cwd: project, files: [a, b] });
      expect(imported.map((i) => [i.asset, i.copied])).toEqual([
        ["assets/clip.mp4", true],
        ["assets/clip-2.mp4", true],
      ]);
      await Promise.all(imported.map((i) => waitForJob(i.job.id)));
    },
    MEDIA_TIMEOUT,
  );

  it(
    "scales the proxy so the short side is at most 540 px, at the project fps",
    async () => {
      const configPath = join(project, "frameshell.json");
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      await conn.request("file.write", { path: configPath, content: JSON.stringify({ ...config, fps: 25 }) });
      const source = join(tempDir(), "wide.mp4");
      await makeClip(source, { width: 1280, height: 720, durationS: 0.4 });
      const { asset, job } = await importOne(source);
      expect(job).toMatchObject({ state: "done", error: null });
      const proxy = join(project, (await assetInfo(asset)).proxy!);
      const { streams } = (await ffprobeJson(proxy, ["-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate"])) as {
        streams: { width: number; height: number; r_frame_rate: string }[];
      };
      expect(streams[0]).toEqual({ width: 960, height: 540, r_frame_rate: "25/1" });
    },
    MEDIA_TIMEOUT,
  );

  it(
    "ingests a file dropped straight into assets/ (watcher)",
    async () => {
      const source = join(tempDir(), "dropped.mp4");
      await makeClip(source, { durationS: 0.5 });
      copyFileSync(source, join(project, "assets", "dropped.mp4"));
      const ready = await waitFor(async () => {
        const { assets } = await conn.request("asset.list", { cwd: project });
        const asset = assets.find((a) => a.path === "assets/dropped.mp4");
        return asset?.state === "ready" ? asset : undefined;
      }, "watcher ingest");
      expect(ready.proxy).not.toBeNull();
    },
    MEDIA_TIMEOUT,
  );

  it(
    "finishes jobs after the client disconnects: the daemon stays up until they are done",
    async () => {
      conn.close();
      await daemon.close();
      await openDaemon(50);
      project = tempDir();
      await conn.request("project.init", { dir: project });
      const source = join(tempDir(), "phone.mp4");
      await makeVfrRecording(source, 6);

      const { imported } = await conn.request("asset.import", { cwd: project, files: [source] });
      expect(imported[0]!.job.state).not.toBe("done");
      conn.close();
      // Idle timeout is 50 ms: the daemon may exit only once the job has finished.
      await daemon.closed;
      await openDaemon();
      const info = await assetInfo(imported[0]!.asset);
      expect(info.state).toBe("ready");
    },
    MEDIA_TIMEOUT,
  );

  it(
    "reports job progress in status",
    async () => {
      const source = join(tempDir(), "clip.mp4");
      await makeClip(source, { durationS: 0.5 });
      const { job } = await importOne(source);
      const status = await conn.request("status", { cwd: project });
      expect(status.jobs).toEqual([expect.objectContaining({ id: job.id, state: "done", progress: 1, asset: "assets/clip.mp4" })]);
    },
    MEDIA_TIMEOUT,
  );

  it("fails the job, not the import, for a file ffprobe cannot read", async () => {
    const source = join(tempDir(), "notes.mp4");
    writeFileSync(source, "not really a video");
    const { job } = await importOne(source);
    expect(job.state).toBe("failed");
    expect(job.error).toMatch(/notes\.mp4.*(media|ffprobe)/i);
    expect((await assetInfo("assets/notes.mp4")).state).toBe("failed");
  });

  it("rejects a missing source with AssetNotFound and imports nothing", async () => {
    const missing = join(tempDir(), "nope.mp4");
    await expect(conn.request("asset.import", { cwd: project, files: [missing] })).rejects.toMatchObject({
      code: ErrorCode.AssetNotFound,
      data: { path: missing },
    });
    expect((await conn.request("asset.list", { cwd: project })).assets).toEqual([]);
  });
});
