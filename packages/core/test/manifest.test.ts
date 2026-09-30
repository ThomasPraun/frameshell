import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BinaryManager,
  FFMPEG_PACKAGE,
  type PinnedBuild,
  WHISPER_MODELS,
  WHISPER_PACKAGE,
  buildCandidates,
  currentPlatform,
  execProcess,
  runDoctor,
} from "../src/index.js";
import { tempDir } from "./helpers.js";

describe("pinned ffmpeg manifest", () => {
  const platforms = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"] as const;

  it.each(platforms)("%s pins https archives with SHA-256 providing ffmpeg and ffprobe", (platform) => {
    const [build, ...others] = buildCandidates(FFMPEG_PACKAGE, platform);
    expect(others).toEqual([]);
    expect(build!.license).toMatch(/^GPL/);
    const provided = build!.archives.flatMap((archive) => {
      expect(archive.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(archive.size).toBeGreaterThan(1_000_000);
      for (const url of archive.urls) expect(url).toMatch(/^https:\/\//);
      return Object.keys(archive.files);
    });
    expect(provided.sort()).toEqual(["ffmpeg", "ffprobe"]);
  });

  it("uses tar archives on Linux, where the system tar cannot read zip", () => {
    for (const platform of ["linux-x64", "linux-arm64"] as const) {
      for (const archive of buildCandidates(FFMPEG_PACKAGE, platform)[0]!.archives) {
        for (const url of archive.urls) expect(url).toMatch(/\.tar\.(xz|gz)$/);
      }
    }
  });
});

describe("pinned whisper.cpp manifest", () => {
  const WHISPER_PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64", "win32-arm64"] as const;
  const candidates = (platform: (typeof WHISPER_PLATFORMS)[number]) => buildCandidates(WHISPER_PACKAGE, platform);
  const cpuOf = (platform: (typeof WHISPER_PLATFORMS)[number]) => candidates(platform).at(-1)!;
  const byAccelerator = (platform: (typeof WHISPER_PLATFORMS)[number], accelerator: string) =>
    candidates(platform).find((build) => build.accelerator === accelerator);

  it.each(WHISPER_PLATFORMS)("%s pins v1.9.4 candidates, GPU first, ending in one that needs no probe", (platform) => {
    const builds = candidates(platform);
    for (const build of builds) {
      expect(build).toMatchObject({ version: "1.9.4", license: "MIT" });
      // Optional candidates name their accelerator: it is their install directory.
      if (build.requires) expect(build.accelerator).toBeDefined();
      for (const archive of build.archives) {
        expect(archive.sha256).toMatch(/^[0-9a-f]{64}$/);
        for (const url of archive.urls) expect(url).toMatch(/^https:\/\//);
      }
    }
    expect(builds.at(-1)!.requires).toBeUndefined();
    expect(builds.slice(0, -1).every((build) => build.requires && build.requires.length > 0)).toBe(true);
  });

  it.each(["linux-x64", "linux-arm64", "win32-x64", "win32-arm64"] as const)(
    "%s falls back to an upstream CPU release archive providing whisper-cli and its libraries",
    (platform) => {
      const build = cpuOf(platform);
      expect(build.accelerator).toBeUndefined();
      expect(build.build).toBeUndefined();
      const [archive] = build.archives;
      expect(archive!.urls).toEqual([expect.stringMatching(/^https:\/\/github\.com\/ggml-org\/whisper\.cpp\/releases\/download\/b5130\//)]);
      expect(Object.keys(archive!.files)).toEqual(["whisper-cli"]);
      expect(Object.keys(archive!.support ?? {}).some((name) => /whisper\.(dll|so\.1)$/.test(name))).toBe(true);
    },
  );

  it.each(["darwin-arm64", "darwin-x64"] as const)("%s builds the same commit from source with Metal", (platform) => {
    const [build, ...others] = candidates(platform);
    expect(others).toEqual([]);
    expect(build!.accelerator).toBe("metal");
    expect(build!.archives[0]!.urls[0]).toContain("927cfce34f31707e17f2bff35c349632fb9e2c3a");
    expect(build!.build?.configure).toEqual(expect.arrayContaining(["-DGGML_METAL=ON", "-DGGML_METAL_EMBED_LIBRARY=ON", "-DBUILD_SHARED_LIBS=OFF"]));
    expect(build!.build?.files).toEqual({ "whisper-cli": "bin/whisper-cli" });
  });

  it("win32-x64 takes upstream's self-contained CUDA 12.4 build when an NVIDIA driver answers", () => {
    const cuda = byAccelerator("win32-x64", "cuda")!;
    expect(cuda.requires?.map((probe) => [probe.command, ...probe.args])).toEqual([["nvidia-smi", "-L"]]);
    const [archive] = cuda.archives;
    expect(archive!.urls).toEqual(["https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-cublas-12.4.0-bin-x64.zip"]);
    expect(archive).toMatchObject({ sha256: "af520ddd034d985b55dfeea3e465ed93653ba2aee1a55e865033edc548c272a7", size: 674_539_285 });
    // ggml-cuda.dll imports cudart64_12 and cublas64_12 (which loads cublasLt64_12): all shipped, only nvcuda.dll is the driver's.
    expect(Object.keys(archive!.support!)).toEqual(
      expect.arrayContaining(["ggml-cuda.dll", "cudart64_12.dll", "cublas64_12.dll", "cublasLt64_12.dll", "whisper.dll", "ggml-cpu-x64.dll"]),
    );
    // CPU backends ship too: ggml runs on CPU when CUDA does not initialise.
    const cpuDlls = Object.keys(cpuOf("win32-x64").archives[0]!.support!);
    expect(Object.keys(archive!.support!)).toEqual(expect.arrayContaining(cpuDlls));
  });

  it.each(["linux-x64", "linux-arm64"] as const)("%s builds the pinned commit with CUDA, else Vulkan, when GPU and toolchain answer", (platform) => {
    const probes = (build: PinnedBuild) => build.requires?.map((probe) => probe.command);
    expect(candidates(platform).map((build) => build.accelerator ?? "cpu")).toEqual(["cuda", "vulkan", "cpu"]);
    const cuda = byAccelerator(platform, "cuda")!;
    const vulkan = byAccelerator(platform, "vulkan")!;
    expect(probes(cuda)).toEqual(["nvidia-smi", "nvcc", "cmake"]);
    expect(probes(vulkan)).toEqual(["vulkaninfo", "glslc", "cmake"]);
    for (const [build, flag] of [[cuda, "-DGGML_CUDA=ON"], [vulkan, "-DGGML_VULKAN=ON"]] as const) {
      expect(build.archives[0]!.urls[0]).toContain("927cfce34f31707e17f2bff35c349632fb9e2c3a");
      expect(build.build?.configure).toEqual(expect.arrayContaining([flag, "-DBUILD_SHARED_LIBS=OFF"]));
      expect(build.build?.files).toEqual({ "whisper-cli": "bin/whisper-cli" });
    }
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
      const pinned = buildCandidates(FFMPEG_PACKAGE, currentPlatform())[0]!.version;
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
