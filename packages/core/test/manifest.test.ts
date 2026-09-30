import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BinaryManager,
  CHROME_HEADLESS_SHELL_PACKAGE,
  FFMPEG_PACKAGE,
  WHISPER_FRAMESHELL_BUILDS,
  WHISPER_FRAMESHELL_TAG,
  WHISPER_MODELS,
  WHISPER_PACKAGE,
  WHISPER_SOURCE,
  buildCandidates,
  frameshellWhisperUrl,
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
        expect(archive.sha256).not.toBe("0".repeat(64));
        expect(archive.size).toBeGreaterThan(1_000_000);
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
      const [archive] = build.archives;
      expect(archive!.urls).toEqual([expect.stringMatching(/^https:\/\/github\.com\/ggml-org\/whisper\.cpp\/releases\/download\/b5130\//)]);
      expect(Object.keys(archive!.files)).toEqual(["whisper-cli"]);
      expect(Object.keys(archive!.support ?? {}).some((name) => /whisper\.(dll|so\.1)$/.test(name))).toBe(true);
    },
  );

  it.each(["darwin-arm64", "darwin-x64"] as const)("%s downloads Frameshell's prebuilt Metal build of the pinned commit", (platform) => {
    const [build, ...others] = candidates(platform);
    expect(others).toEqual([]);
    expect(build!.accelerator).toBe("metal");
    expect(build!.requires).toBeUndefined();
    const [archive] = build!.archives;
    expect(archive!.urls).toEqual([
      `https://github.com/ThomasPraun/frameshell/releases/download/${WHISPER_FRAMESHELL_TAG}/whisper-cli-1.9.4-${platform}-metal.tar`,
    ]);
    expect(archive).toMatchObject({ files: { "whisper-cli": "whisper-cli" }, support: { LICENSE: "LICENSE" } });
    const recipe = WHISPER_FRAMESHELL_BUILDS.find((candidate) => candidate.platform === platform)!;
    expect(recipe.configure).toEqual(
      expect.arrayContaining(["-DGGML_METAL=ON", "-DGGML_METAL_EMBED_LIBRARY=ON", "-DBUILD_SHARED_LIBS=OFF"]),
    );
    expect(archive).toMatchObject({ sha256: recipe.sha256, size: recipe.size });
  });

  it("builds every Frameshell asset from the pinned v1.9.4 commit, with no machine-specific tuning", () => {
    expect(WHISPER_SOURCE.url).toContain("927cfce34f31707e17f2bff35c349632fb9e2c3a");
    expect(WHISPER_SOURCE.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(WHISPER_FRAMESHELL_BUILDS.map((build) => build.platform).sort()).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]);
    for (const build of WHISPER_FRAMESHELL_BUILDS) {
      expect(build.asset).toMatch(/^whisper-cli-1\.9\.4-.+\.tar$/);
      // Native tuning would make the bytes depend on the CI machine's CPU.
      if (build.platform !== "darwin-arm64") expect(build.configure).toContain("-DGGML_NATIVE=OFF");
      expect(frameshellWhisperUrl(build)).toMatch(/^https:\/\/github\.com\/ThomasPraun\/frameshell\/releases\/download\//);
    }
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

  it.each(["linux-x64", "linux-arm64"] as const)("%s downloads Frameshell's prebuilt Vulkan build when a Vulkan driver answers, else CPU", (platform) => {
    expect(candidates(platform).map((build) => build.accelerator ?? "cpu")).toEqual(["vulkan", "cpu"]);
    const vulkan = byAccelerator(platform, "vulkan")!;
    const probes = vulkan.requires!.map((probe) => [probe.command, ...probe.args]);
    expect(probes[0]).toEqual(["vulkaninfo", "--summary"]);
    // ggml's x64 build without native tuning uses AVX2.
    if (platform === "linux-x64") expect(probes).toContainEqual(["grep", "-qw", "avx2", "/proc/cpuinfo"]);
    expect(vulkan.archives[0]!.urls[0]).toBe(
      `https://github.com/ThomasPraun/frameshell/releases/download/${WHISPER_FRAMESHELL_TAG}/whisper-cli-1.9.4-${platform}-vulkan.tar`,
    );
    const recipe = WHISPER_FRAMESHELL_BUILDS.find((candidate) => candidate.platform === platform)!;
    expect(recipe.configure).toEqual(expect.arrayContaining(["-DGGML_VULKAN=ON", "-DBUILD_SHARED_LIBS=OFF"]));
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

describe("pinned headless Chrome manifest", () => {
  it.each(["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"] as const)(
    "%s pins Chrome for Testing 154 headless shell (ADR 0002), installed whole from Google's zip",
    (platform) => {
      const [build, ...others] = buildCandidates(CHROME_HEADLESS_SHELL_PACKAGE, platform);
      expect(others).toEqual([]);
      expect(build!.version).toBe("154.0.8037.57");
      const [archive] = build!.archives;
      expect(archive!.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(archive!.size).toBeGreaterThan(90_000_000);
      expect(archive!.urls).toEqual([expect.stringMatching(/^https:\/\/storage\.googleapis\.com\/chrome-for-testing-public\/154\.0\.8037\.57\/.+\.zip$/)]);
      // The executable loads .pak, ICU and SwiftShader files from its own directory.
      expect(archive!.files["chrome-headless-shell"]).toBe(`${archive!.tree}/chrome-headless-shell${platform === "win32-x64" ? ".exe" : ""}`);
    },
  );

  it("is installed by the first render, not by doctor --install, and is never mirrored", () => {
    expect(CHROME_HEADLESS_SHELL_PACKAGE).toMatchObject({ onDemand: true, tools: ["chrome-headless-shell"] });
    expect(CHROME_HEADLESS_SHELL_PACKAGE.mirror).toBeUndefined();
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

  it.runIf(buildCandidates(CHROME_HEADLESS_SHELL_PACKAGE, currentPlatform()).length > 0)(
    `installs the ${currentPlatform()} headless Chrome pin whole, verified, and runs it`,
    async () => {
      const binaries = new BinaryManager({ dataDir: tempDir(), configDir: tempDir() });
      const shell = await binaries.ensure("chrome-headless-shell");
      const version = await execProcess(shell, ["--version"], { timeoutMs: 60_000 });
      expect(version.code, version.stderr).toBe(0);
      expect(version.stdout).toContain("Chrome for Testing 154.0.8037.57");
    },
    600_000,
  );
});
