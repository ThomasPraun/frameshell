import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BinaryManager, FFMPEG_PACKAGE, currentPlatform, execProcess, runDoctor } from "../src/index.js";
import { tempDir } from "./helpers.js";

describe("pinned ffmpeg manifest", () => {
  const platforms = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"] as const;

  it.each(platforms)("%s pins https archives with SHA-256 providing ffmpeg and ffprobe", (platform) => {
    const build = FFMPEG_PACKAGE.builds[platform]!;
    expect(build.license).toMatch(/^GPL/);
    const provided = build.archives.flatMap((archive) => {
      expect(archive.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(archive.size).toBeGreaterThan(1_000_000);
      for (const url of archive.urls) expect(url).toMatch(/^https:\/\//);
      return Object.keys(archive.files);
    });
    expect(provided.sort()).toEqual(["ffmpeg", "ffprobe"]);
  });

  it("uses tar archives on Linux, where the system tar cannot read zip", () => {
    for (const platform of ["linux-x64", "linux-arm64"] as const) {
      for (const archive of FFMPEG_PACKAGE.builds[platform]!.archives) {
        for (const url of archive.urls) expect(url).toMatch(/\.tar\.(xz|gz)$/);
      }
    }
  });
});

// Opt-in: downloads the real pinned build (~60-170 MB) for this platform, then runs it.
// Run with FRAMESHELL_TEST_REAL_DOWNLOAD=1 pnpm test; CI runs it weekly (.github/workflows/real-binaries.yml).
describe.runIf(process.env["FRAMESHELL_TEST_REAL_DOWNLOAD"] === "1")("real pinned ffmpeg download", () => {
  it(
    `installs the ${currentPlatform()} pin, verified, and encodes and probes H.264 and VP9 with alpha`,
    async () => {
      const binaries = new BinaryManager({ dataDir: tempDir(), configDir: tempDir() });
      const report = await runDoctor(binaries, { install: true });
      const pinned = FFMPEG_PACKAGE.builds[currentPlatform()]!.version;
      for (const binary of report.binaries) {
        expect(binary).toMatchObject({ source: "managed", installed: true });
        expect(binary.version).toContain(pinned.split("-")[0]);
      }
      const compiled = report.codecs.filter((c) => c.compiled).map((c) => `${c.name}:${c.kind}`);
      expect(compiled).toEqual(
        expect.arrayContaining(["libx264:encoder", "libvpx-vp9:encoder", "libvpx-vp9:decoder"]),
      );
      expect(report.problems).toEqual([]);

      // Run the binaries for real: encode through each required codec, read it back with ffprobe.
      const path = (name: string) => report.binaries.find((b) => b.name === name)!.path!;
      const out = tempDir();
      const cases = [
        { file: "h264.mp4", source: "testsrc2=size=64x64:rate=10:duration=1", args: ["-c:v", "libx264", "-pix_fmt", "yuv420p"], codec: "h264" },
        { file: "alpha.webm", source: "testsrc2=size=64x64:rate=10:duration=1,format=yuva420p", args: ["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p"], codec: "vp9" },
      ];
      for (const { file, source, args, codec } of cases) {
        const target = join(out, file);
        const encoded = await execProcess(path("ffmpeg"), ["-v", "error", "-f", "lavfi", "-i", source, ...args, "-y", target], { timeoutMs: 120_000 });
        expect(encoded, encoded.stderr).toMatchObject({ code: 0 });
        const probed = await execProcess(path("ffprobe"), ["-v", "error", "-show_streams", "-of", "json", target]);
        expect(probed.code, probed.stderr).toBe(0);
        const [stream] = (JSON.parse(probed.stdout) as { streams: { codec_name: string }[] }).streams;
        expect(stream?.codec_name).toBe(codec);
      }
      // Alpha survives only through the libvpx decoder (ADR 0002): a decoded PNG keeps it as rgba.
      const png = join(out, "alpha.png");
      const decoded = await execProcess(
        path("ffmpeg"),
        ["-v", "error", "-c:v", "libvpx-vp9", "-i", join(out, "alpha.webm"), "-frames:v", "1", "-y", png],
        { timeoutMs: 120_000 },
      );
      expect(decoded.code, decoded.stderr).toBe(0);
      const frame = await execProcess(path("ffprobe"), ["-v", "error", "-show_streams", "-of", "json", png]);
      expect((JSON.parse(frame.stdout) as { streams: { pix_fmt: string }[] }).streams[0]?.pix_fmt).toBe("rgba");
    },
    600_000,
  );
});
