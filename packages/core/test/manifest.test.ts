import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BinaryManager, FFMPEG_PACKAGE, WHISPER_MODELS, WHISPER_PACKAGE, currentPlatform, execProcess, runDoctor } from "../src/index.js";
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

describe("pinned whisper.cpp manifest", () => {
  it.each(["linux-x64", "linux-arm64", "win32-x64", "win32-arm64"] as const)(
    "%s pins an upstream v1.9.4 release archive providing whisper-cli and its libraries",
    (platform) => {
      const build = WHISPER_PACKAGE.builds[platform]!;
      expect(build).toMatchObject({ version: "1.9.4", license: "MIT" });
      expect(build.build).toBeUndefined();
      const [archive] = build.archives;
      expect(archive!.urls).toEqual([expect.stringMatching(/^https:\/\/github\.com\/ggml-org\/whisper\.cpp\/releases\/download\/b5130\//)]);
      expect(archive!.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(Object.keys(archive!.files)).toEqual(["whisper-cli"]);
      expect(Object.keys(archive!.support ?? {}).some((name) => /whisper\.(dll|so\.1)$/.test(name))).toBe(true);
    },
  );

  it.each(["darwin-arm64", "darwin-x64"] as const)("%s builds the same commit from source with Metal", (platform) => {
    const build = WHISPER_PACKAGE.builds[platform]!;
    expect(build.archives[0]!.urls[0]).toContain("927cfce34f31707e17f2bff35c349632fb9e2c3a");
    expect(build.build?.configure).toEqual(expect.arrayContaining(["-DGGML_METAL=ON", "-DGGML_METAL_EMBED_LIBRARY=ON", "-DBUILD_SHARED_LIBS=OFF"]));
    expect(build.build?.files).toEqual({ "whisper-cli": "bin/whisper-cli" });
  });

  it("is installed on demand, not by doctor --install", () => {
    expect(WHISPER_PACKAGE.onDemand).toBe(true);
  });

  it("pins the ADR 0003 default model large-v3-turbo-q5_0 (574 MB) by revision and SHA-256", () => {
    const q5 = WHISPER_MODELS.find((model) => model.id === "ggml-large-v3-turbo-q5_0")!;
    expect(q5).toMatchObject({ size: 574_041_195, license: "MIT", file: "ggml-large-v3-turbo-q5_0.bin" });
    expect(q5.urls[0]).toMatch(/^https:\/\/huggingface\.co\/ggerganov\/whisper\.cpp\/resolve\/[0-9a-f]{40}\//);
    expect(WHISPER_MODELS.map((model) => model.id).sort()).toEqual([
      "ggml-large-v3-turbo",
      "ggml-large-v3-turbo-q5_0",
      "ggml-large-v3-turbo-q8_0",
    ]);
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
      for (const binary of report.binaries.filter((b) => b.package === "ffmpeg")) {
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
