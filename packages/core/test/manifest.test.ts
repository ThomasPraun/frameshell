import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BinaryManager,
  CHROME_HEADLESS_SHELL_PACKAGE,
  DIARIZATION_MODELS,
  DIARIZATION_TOOL,
  SEGMENTATION_MODEL,
  SHERPA_ONNX_PACKAGE,
  SPEAKER_EMBEDDING_MODEL,
  FFMPEG_PACKAGE,
  WHISPER_FRAMESHELL_BUILDS,
  WHISPER_FRAMESHELL_TAG,
  WHISPER_MODELS,
  WHISPER_PACKAGE,
  WHISPER_SOURCE,
  FACE_DETECTION_MODEL,
  FACE_DETECTION_MODELS,
  FACE_RECOGNITION_MODEL,
  FACE_RECOGNITION_MODELS,
  FACE_EMBEDDING_DIMS,
  cosine,
  loadYunet,
  peopleScanWorker,
  PHOTO_SEGMENTATION_DECODER_MODEL,
  PHOTO_SEGMENTATION_ENCODER_MODEL,
  PHOTO_SEGMENTATION_MODELS,
  SegmentService,
  workerSegmentEngine,
  ONNX_RUNTIME_WEB,
  ONNX_RUNTIME_WEB_PACKAGE,
  yunetWorkerScanner,
  buildCandidates,
  frameshellWhisperUrl,
  currentPlatform,
  execProcess,
  runDoctor,
  sherpaDiarizer,
} from "../src/index.js";
import { tempDir } from "./helpers.js";
import { makeDiscPhoto, overlapWithDisc } from "./segment-fixture.js";
import { toneWav } from "./whisper-fixture.js";
import { drawFace, encodeFrames } from "./face-fixture.js";
import { mediaTools } from "./media-tools.js";

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

describe("pinned sherpa-onnx diarization manifest", () => {
  const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64", "win32-arm64"] as const;

  it.each(PLATFORMS)("%s pins one upstream 1.13.8 CPU archive with the diarization tool and ONNX Runtime beside it", (platform) => {
    const [build, ...others] = buildCandidates(SHERPA_ONNX_PACKAGE, platform);
    expect(others).toEqual([]);
    expect(build).toMatchObject({ version: "1.13.8", license: "Apache-2.0", origin: "https://github.com/k2-fsa/sherpa-onnx" });
    const [archive, ...more] = build!.archives;
    expect(more).toEqual([]);
    expect(archive!.urls).toEqual([expect.stringMatching(/^https:\/\/github\.com\/k2-fsa\/sherpa-onnx\/releases\/download\/v1\.13\.8\/sherpa-onnx-v1\.13\.8-.+\.tar\.bz2$/)]);
    expect(archive!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(archive!.size).toBeGreaterThan(10_000_000);
    expect(Object.keys(archive!.files)).toEqual([DIARIZATION_TOOL]);
    const runtime = platform.startsWith("win32") ? "onnxruntime.dll" : platform.startsWith("darwin") ? "libonnxruntime.dylib" : "libonnxruntime.so";
    expect(Object.keys(archive!.support!)).toContain(runtime);
  });

  it("is installed by the first diarization, never mirrored", () => {
    expect(SHERPA_ONNX_PACKAGE).toMatchObject({ onDemand: true, tools: [DIARIZATION_TOOL] });
    expect(SHERPA_ONNX_PACKAGE.mirror).toBeUndefined();
  });

  it("pins both models by revision and SHA-256 under permissive licences", () => {
    expect(DIARIZATION_MODELS.map((model) => [model.id, model.license])).toEqual([
      [SEGMENTATION_MODEL, "MIT"],
      [SPEAKER_EMBEDDING_MODEL, "Apache-2.0"],
    ]);
    for (const model of DIARIZATION_MODELS) {
      expect(model.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(model.urls[0]).toMatch(/^https:\/\/huggingface\.co\/csukuangfj\/[^/]+\/resolve\/[0-9a-f]{40}\//);
    }
  });
});

describe("pinned face detection manifest", () => {
  it("pins one ONNX Runtime Web tarball from npm for every platform, a module installed on first use, never mirrored", () => {
    expect(ONNX_RUNTIME_WEB_PACKAGE).toMatchObject({ onDemand: true, module: true, tools: [ONNX_RUNTIME_WEB] });
    expect(ONNX_RUNTIME_WEB_PACKAGE.mirror).toBeUndefined();
    const builds = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64", "win32-arm64"].map(
      (platform) => buildCandidates(ONNX_RUNTIME_WEB_PACKAGE, platform as never),
    );
    for (const candidates of builds) expect(candidates).toEqual([builds[0]![0]]);
    const [build] = builds[0]!;
    expect(build).toMatchObject({ version: "1.30.0", license: "MIT", origin: "https://github.com/microsoft/onnxruntime" });
    expect(build!.archives[0]!.urls).toEqual(["https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-1.30.0.tgz"]);
    expect(Object.keys(build!.archives[0]!.support!)).toEqual(["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm", "ort.wasm.min.mjs.map"]);
  });

  it("pins the YuNet model by commit and SHA-256 under MIT", () => {
    expect(FACE_DETECTION_MODELS.map((model) => [model.id, model.license])).toEqual([[FACE_DETECTION_MODEL, "MIT"]]);
    expect(FACE_DETECTION_MODELS[0]!.urls[0]).toMatch(/^https:\/\/media\.githubusercontent\.com\/media\/opencv\/opencv_zoo\/[0-9a-f]{40}\//);
  });

  it("pins the SFace model at the YuNet commit by SHA-256 under Apache-2.0", () => {
    expect(FACE_RECOGNITION_MODELS.map((model) => [model.id, model.license, model.size])).toEqual([[FACE_RECOGNITION_MODEL, "Apache-2.0", 38_696_353]]);
    expect(FACE_RECOGNITION_MODELS[0]!.sha256).toBe("0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79");
    expect(FACE_RECOGNITION_MODELS[0]!.urls[0]).toContain(`/${FACE_DETECTION_MODELS[0]!.urls[0]!.match(/[0-9a-f]{40}/)![0]}/`);
  });

  it("pins both MobileSAM files by Hugging Face revision and SHA-256 under Apache-2.0", () => {
    expect(PHOTO_SEGMENTATION_MODELS.map((model) => [model.id, model.license, model.size])).toEqual([
      [PHOTO_SEGMENTATION_ENCODER_MODEL, "Apache-2.0", 28_157_093],
      [PHOTO_SEGMENTATION_DECODER_MODEL, "Apache-2.0", 16_496_559],
    ]);
    for (const model of PHOTO_SEGMENTATION_MODELS) {
      expect(model.urls).toEqual([expect.stringMatching(/^https:\/\/huggingface\.co\/Acly\/MobileSAM\/resolve\/0d3b403339b4674a82493d5e97964dd78089ddc8\/[\w.]+\.onnx$/)]);
      expect(model.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(model.version).toBe("0d3b403339b4");
    }
  });

  it("reports an installed module at its pinned version without running it", async () => {
    const dataDir = tempDir();
    const binaries = new BinaryManager({ dataDir, configDir: tempDir() });
    const location = await binaries.locate(ONNX_RUNTIME_WEB);
    expect(location.path).toBe(join(dataDir, "binaries", "onnxruntime-web", "1.30.0", currentPlatform(), "onnxruntime-web.mjs"));
    mkdirSync(join(location.path!, ".."), { recursive: true });
    writeFileSync(location.path!, "export {};\n");
    const report = await runDoctor(binaries);
    expect(report.binaries.find((binary) => binary.name === ONNX_RUNTIME_WEB)).toMatchObject({ installed: true, version: "1.30.0" });
    expect(report.problems.filter((problem) => problem.includes("onnxruntime"))).toEqual([]);
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

  it(
    `installs the ${currentPlatform()} sherpa-onnx pin and its models, verified, and diarizes a WAV`,
    async () => {
      const binaries = new BinaryManager({ dataDir: tempDir(), configDir: tempDir() });
      const binary = await binaries.ensure(DIARIZATION_TOOL);
      const segmentation = await binaries.ensureModel(SEGMENTATION_MODEL);
      const embedding = await binaries.ensureModel(SPEAKER_EMBEDDING_MODEL);
      // Tones, not speech: the run must succeed; how many segments it finds does not matter.
      const audio = join(tempDir(), "tones.wav");
      writeFileSync(audio, toneWav(4, [[0.5, 1.5], [2.5, 3.5]]));
      const runtime = await binaries.ensure(ONNX_RUNTIME_WEB);
      const segments = await sherpaDiarizer({ binary, segmentation, embedding, runtime, audio, onProgress: () => {} });
      expect(Array.isArray(segments)).toBe(true);
    },
    600_000,
  );

  it(
    "installs ONNX Runtime Web and YuNet, verified, and keys a drawn face that moves, in a worker thread",
    async () => {
      const binaries = new BinaryManager({ dataDir: tempDir(), configDir: tempDir() });
      const scan = yunetWorkerScanner({ runtime: await binaries.ensure(ONNX_RUNTIME_WEB), model: await binaries.ensureModel(FACE_DETECTION_MODEL) });
      const { ffmpeg } = await mediaTools();
      const path = join(tempDir(), "face.mp4");
      // 16:9, 6 s at 10 fps: the face sits at x 0.25 for 3 s, then at 0.75.
      const left = drawFace(512, 288, [{ x: 0.25, y: 0.45, size: 0.4 }]);
      const right = drawFace(512, 288, [{ x: 0.75, y: 0.45, size: 0.4 }]);
      await encodeFrames(ffmpeg, path, 512, 288, 10, Array.from({ length: 60 }, (_, i) => (i < 30 ? left : right)));
      const found = await scan({ ffmpeg, path, width: 512, height: 288, duration: 6 });
      expect(found).toMatchObject({ samples: 12, faces: 12 });
      expect(found.keys.map((key) => key.time)).toEqual([2.5, 3]);
      expect(found.keys[0]!.x).toBeCloseTo(0.25, 1);
      expect(found.keys[1]!.x).toBeCloseTo(0.75, 1);
    },
    600_000,
  );

  it(
    "installs SFace, verified, and embeds a drawn face that moves: landmarks in place, one print per second, the same face alike",
    async () => {
      const binaries = new BinaryManager({ dataDir: tempDir(), configDir: tempDir() });
      const runtime = await binaries.ensure(ONNX_RUNTIME_WEB);
      const files = { runtime, detector: await binaries.ensureModel(FACE_DETECTION_MODEL), recognizer: await binaries.ensureModel(FACE_RECOGNITION_MODEL) };
      const detect = await loadYunet(runtime, files.detector);
      const [found] = await detect({ width: 512, height: 288, data: drawFace(512, 288, [{ x: 0.3, y: 0.45, size: 0.4 }]) });
      const [rightEye, leftEye, nose, rightMouth, leftMouth] = found!.landmarks!;
      // YuNet's order: the eye at image left first, mouth corners last; eyes above the nose above the mouth.
      expect(rightEye![0]).toBeLessThan(leftEye![0]);
      expect(Math.max(rightEye![1], leftEye![1])).toBeLessThan(nose![1]);
      expect(nose![1]).toBeLessThan(Math.min(rightMouth![1], leftMouth![1]));
      expect(rightMouth![0]).toBeLessThan(leftMouth![0]);
      expect(Math.abs(nose![0] - found!.x)).toBeLessThan(found!.width / 4);

      const { ffmpeg } = await mediaTools();
      const path = join(tempDir(), "face.mp4");
      // 16:9 at 1280×720, 6 s at 10 fps: the same face at x 0.25 for 3 s, then at 0.75.
      const left = drawFace(1280, 720, [{ x: 0.25, y: 0.45, size: 0.4 }]);
      const right = drawFace(1280, 720, [{ x: 0.75, y: 0.45, size: 0.4 }]);
      await encodeFrames(ffmpeg, path, 1280, 720, 10, Array.from({ length: 60 }, (_, i) => (i < 30 ? left : right)));
      const scan = await peopleScanWorker(files)({ ffmpeg, path, width: 1280, height: 720, duration: 6 });
      expect(scan).toMatchObject({ width: 1280, height: 720, samples: 12 });
      expect(scan.tracks.map((track) => [track.start, track.end, track.embeddings.length])).toEqual([
        [0, 2.5, 3],
        [3, 5.5, 3],
      ]);
      const [first, second] = scan.tracks.map((track) => track.embeddings[0]!.vector);
      expect(first).toHaveLength(FACE_EMBEDDING_DIMS);
      expect(cosine(first!, first!)).toBeCloseTo(1, 4);
      // SFace's own same-person line is 0.363; the very same drawing, moved, is far above it.
      expect(cosine(first!, second!)).toBeGreaterThan(0.8);
    },
    900_000,
  );

  it(
    "installs ONNX Runtime Web and MobileSAM, verified, and segments a drawn disc from one click, in a worker thread",
    async () => {
      const binaries = new BinaryManager({ dataDir: tempDir(), configDir: tempDir() });
      const engine = workerSegmentEngine({
        runtime: await binaries.ensure(ONNX_RUNTIME_WEB),
        encoder: await binaries.ensureModel(PHOTO_SEGMENTATION_ENCODER_MODEL),
        decoder: await binaries.ensureModel(PHOTO_SEGMENTATION_DECODER_MODEL),
      });
      try {
        const { ffmpeg } = await mediaTools();
        const dir = tempDir();
        const [width, height] = [640, 480];
        const disc = { cx: 400, cy: 220, r: 110 };
        await makeDiscPhoto(ffmpeg, join(dir, "disc.png"), width, height, disc);
        const service = new SegmentService({
          probe: async () => ({ video: { width, height, still: true } }),
          hash: async () => "sha256:disc",
          ffmpeg: async () => ffmpeg,
          engine: async () => engine,
        });
        const result = await service.segment(dir, "disc.png", { x: disc.cx, y: disc.cy });
        expect(result).toMatchObject({ width, height });
        expect(result.masks).toHaveLength(3);
        const best = result.masks[result.chosen]!;
        expect(overlapWithDisc(best, width, height, disc)).toBeGreaterThan(0.9);
        expect(best.bbox[0]).toBeGreaterThan(disc.cx - disc.r - 10);
        expect(best.score).toBeGreaterThan(0.5);
        expect((await service.segment(dir, "disc.png", { x: disc.cx + 20, y: disc.cy })).cached).toBe(true);
      } finally {
        await engine.close();
      }
    },
    600_000,
  );
});
