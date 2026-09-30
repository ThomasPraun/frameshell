/** `<os>-<arch>` key of a pinned build, from `process.platform` and `process.arch`. */
export type PlatformKey = `${NodeJS.Platform}-${NodeJS.Architecture}`;

/** Key for the running process, e.g. `darwin-arm64`. */
export function currentPlatform(): PlatformKey {
  return `${process.platform}-${process.arch}`;
}

/** One downloadable archive of a pinned build. */
export interface PinnedArchive {
  /** Tried in order; later entries are mirrors of the same bytes. */
  readonly urls: readonly string[];
  /** Lowercase hex SHA-256 of the archive. Mismatch aborts the install. */
  readonly sha256: string;
  /** Bytes, for progress messages and a cheap sanity check. */
  readonly size: number;
  /**
   * Tool name to the `/`-separated path of its executable inside the archive.
   * Extracted by the system `tar`: zip needs bsdtar (macOS, Windows), so Linux
   * builds must be tar archives.
   */
  readonly files: Readonly<Record<string, string>>;
  /**
   * Install name to archive member for non-executables placed next to the
   * tools: shared libraries the tools load (renamed to their SONAME, so no
   * symlinks), licence files. Missing members fail the install.
   */
  readonly support?: Readonly<Record<string, string>>;
}

/**
 * Compile the tools on the user's machine from a pinned source archive
 * (`archives[0]`, `files` empty) with CMake. For platforms where upstream
 * ships no executable. Needs CMake and a C/C++ toolchain.
 */
export interface SourceBuild {
  /** `/`-separated source tree directory inside the archive. */
  readonly root: string;
  /** Extra `cmake` configure arguments; `CMAKE_BUILD_TYPE=Release` is always set. */
  readonly configure: readonly string[];
  readonly targets: readonly string[];
  /** Tool name to its built executable, `/`-separated, relative to the build directory. */
  readonly files: Readonly<Record<string, string>>;
  /** How to get the toolchain; shown when `cmake` is missing or the build fails. */
  readonly toolchainHint: string;
  /** Expected build time shown while building, e.g. "about a minute". */
  readonly duration?: string;
}

/** GPU backend a build is compiled with. */
export type Accelerator = "metal" | "cuda" | "vulkan";

/** Command that must exit 0 on this machine for an optional build to be chosen. */
export interface MachineProbe {
  readonly command: string;
  readonly args: readonly string[];
  /** What success proves, e.g. "an NVIDIA GPU and driver". Shown when the build is skipped. */
  readonly proves: string;
}

/** Exact build pinned for one platform. Never floating: tools change behaviour between versions. */
export interface PinnedBuild {
  readonly version: string;
  /** GPU backend compiled in. Omitted = CPU only. */
  readonly accelerator?: Accelerator;
  /**
   * Makes this an optional candidate: chosen only when every probe exits 0,
   * else the next candidate for the platform is tried. Needs `accelerator`,
   * which also names its install directory (`<platform>-<accelerator>`).
   */
  readonly requires?: readonly MachineProbe[];
  /** Who builds it (homepage), shown by `doctor`. */
  readonly origin: string;
  /** SPDX licence of the build as distributed. */
  readonly license: string;
  /** Together they provide every tool of the package; with `build`, the one source archive. */
  readonly archives: readonly PinnedArchive[];
  /** Set when this platform builds from source instead of downloading executables. */
  readonly build?: SourceBuild;
}

/** Set of executables installed and versioned together, e.g. ffmpeg + ffprobe. */
export interface BinaryPackage {
  /** Directory name under `<dataDir>/binaries/`. */
  readonly name: string;
  /** Executable names without `.exe`; the first is the one users override by default. */
  readonly tools: readonly string[];
  /**
   * Per platform: one build, or candidates in preference order (GPU first).
   * The first candidate whose `requires` all pass and whose install has not
   * failed on this machine is used; the last one must have no `requires`
   * (CPU fallback).
   */
  readonly builds: Readonly<Partial<Record<PlatformKey, PinnedBuild | readonly PinnedBuild[]>>>;
  /**
   * Installed by the feature that first needs it (whisper.cpp: first
   * transcription). `doctor` reports it but never lists it missing as a problem.
   */
  readonly onDemand?: boolean;
  /** Arguments that print the version, and a pattern capturing it. Default: ffmpeg's `-version`. */
  readonly versionProbe?: { readonly args: readonly string[]; readonly pattern: RegExp };
}

/** Data file (ML model) downloaded on first use, same for every platform. */
export interface ManagedModel {
  /** Id features ask for, e.g. `ggml-large-v3-turbo-q5_0`. */
  readonly id: string;
  /** Upstream revision; part of the install path, so a re-pin never reuses old bytes. */
  readonly version: string;
  /** Where it comes from (homepage). */
  readonly origin: string;
  /** SPDX licence of the file. */
  readonly license: string;
  /** Tried in order; later entries are mirrors. */
  readonly urls: readonly string[];
  /** Lowercase hex SHA-256. Mismatch aborts the install. */
  readonly sha256: string;
  readonly size: number;
  /** File name on disk. */
  readonly file: string;
}

const MARTIN_RIEDL = "https://ffmpeg.martin-riedl.de";
const BTBN = "https://github.com/BtbN/FFmpeg-Builds";
const BTBN_RELEASE = `${BTBN}/releases/download/autobuild-2026-08-31-13-27`;
const BTBN_BUILD = "ffmpeg-n9.0.1-11-ge47273f4d9";

function riedl(path: string, ffmpeg: [string, number], ffprobe: [string, number]): PinnedBuild {
  const archive = (tool: string, [sha256, size]: [string, number]): PinnedArchive => ({
    urls: [`${MARTIN_RIEDL}/download/macos/${path}/${tool}.zip`],
    sha256,
    size,
    files: { [tool]: tool },
  });
  return {
    version: "9.0.2",
    origin: MARTIN_RIEDL,
    license: "GPL-3.0-or-later",
    archives: [archive("ffmpeg", ffmpeg), archive("ffprobe", ffprobe)],
  };
}

function btbn(target: string, ext: "tar.xz" | "zip", sha256: string, size: number): PinnedBuild {
  const dir = `${BTBN_BUILD}-${target}-gpl-9.0`;
  const exe = target.startsWith("win") ? ".exe" : "";
  return {
    version: "9.0.1-11-ge47273f4d9",
    origin: BTBN,
    license: "GPL-3.0-or-later",
    archives: [
      {
        urls: [`${BTBN_RELEASE}/${dir}.${ext}`],
        sha256,
        size,
        files: { ffmpeg: `${dir}/bin/ffmpeg${exe}`, ffprobe: `${dir}/bin/ffprobe${exe}` },
      },
    ],
  };
}

/**
 * ffmpeg + ffprobe, GPL static builds with libx264 and libvpx (VP9 encoder and
 * decoder: ADR 0002). Sources, licences and how to re-pin: `docs/binaries.md`.
 */
export const FFMPEG_PACKAGE: BinaryPackage = {
  name: "ffmpeg",
  tools: ["ffmpeg", "ffprobe"],
  builds: {
    "darwin-arm64": riedl(
      "arm64/1789931890_9.0.2",
      ["c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924", 28_395_699],
      ["fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6", 28_317_701],
    ),
    "darwin-x64": riedl(
      "amd64/1789931006_9.0.2",
      ["7c6b4125b191cbf773832dc51f424cf2b6bb7da43007d1e066f95909e47cacd4", 33_816_391],
      ["2322438ed2f6319a691291b247d09c69dcaa3a982460d1f269a7e1af335cfdfd", 33_719_233],
    ),
    "linux-x64": btbn("linux64", "tar.xz", "182c1b509720e939bb47bfb47dc29cc0c298640401128e3dce8627d10707eb5a", 126_600_656),
    "linux-arm64": btbn(
      "linuxarm64",
      "tar.xz",
      "e2dd447c8a47849c5812d87e54a47b20ae0f3603d38989440f4a5fe1af8755b1",
      108_761_296,
    ),
    "win32-x64": btbn("win64", "zip", "ec9db2cda1f5894ab95446076ad8bf49379db4b53c02e778ad3b49adf91fec83", 169_202_846),
  },
};

const WHISPER_CPP = "https://github.com/ggml-org/whisper.cpp";
/** Tag v1.9.4 = release b5130. Same DTW/VAD code as the ADR 0003 spike commit `6e4ab854`. */
const WHISPER_COMMIT = "927cfce34f31707e17f2bff35c349632fb9e2c3a";
const WHISPER_RELEASE = `${WHISPER_CPP}/releases/download/b5130`;
const WHISPER_VERSION = "1.9.4";

function whisperLinux(arch: "x64" | "arm64", sha256: string, size: number, cpuLibs: readonly string[]): PinnedBuild {
  const dir = `whisper-bin-ubuntu-${arch}`;
  return {
    version: WHISPER_VERSION,
    origin: WHISPER_CPP,
    license: "MIT",
    archives: [
      {
        urls: [`${WHISPER_RELEASE}/${dir}.tar.gz`],
        sha256,
        size,
        files: { "whisper-cli": `${dir}/whisper-cli` },
        // RUNPATH is $ORIGIN: libraries sit next to the executable under their SONAME.
        support: {
          "libwhisper.so.1": `${dir}/libwhisper.so.1.9.4`,
          "libggml.so.0": `${dir}/libggml.so.0.23.0`,
          "libggml-base.so.0": `${dir}/libggml-base.so.0.23.0`,
          ...Object.fromEntries(cpuLibs.map((lib) => [lib, `${dir}/${lib}`])),
          LICENSE: `${dir}/LICENSE`,
        },
      },
    ],
  };
}

function whisperWindows(
  asset: string,
  sha256: string,
  size: number,
  dlls: readonly string[],
  gpu: Pick<PinnedBuild, "accelerator" | "requires"> = {},
): PinnedBuild {
  return {
    version: WHISPER_VERSION,
    origin: WHISPER_CPP,
    license: "MIT",
    ...gpu,
    archives: [
      {
        urls: [`${WHISPER_RELEASE}/${asset}`],
        sha256,
        size,
        files: { "whisper-cli": "Release/whisper-cli.exe" },
        // Windows loads DLLs from the executable's directory first.
        support: Object.fromEntries(dlls.map((dll) => [dll, `Release/${dll}`])),
      },
    ],
  };
}

const CMAKE_PROBE: MachineProbe = { command: "cmake", args: ["--version"], proves: "CMake" };
const NVIDIA_PROBE: MachineProbe = { command: "nvidia-smi", args: ["-L"], proves: "an NVIDIA GPU and driver" };

/** Only the `whisper-cli` target, statically linked: nothing to place next to it. */
const WHISPER_CLI_ONLY = ["-DBUILD_SHARED_LIBS=OFF", "-DWHISPER_BUILD_TESTS=OFF", "-DWHISPER_BUILD_SERVER=OFF", "-DWHISPER_SDL2=OFF"];

/** Local CMake build of the pinned commit (source tarball) with backend flags. */
function whisperSource(
  configure: readonly string[],
  recipe: Pick<SourceBuild, "toolchainHint" | "duration">,
  gpu: Pick<PinnedBuild, "accelerator" | "requires">,
): PinnedBuild {
  return {
    version: WHISPER_VERSION,
    origin: WHISPER_CPP,
    license: "MIT",
    ...gpu,
    archives: [
      {
        urls: [`https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/${WHISPER_COMMIT}`],
        sha256: "41b664fee09e79176ac277b5237debec34f8d74af3c7d71f333f1ec67989ecde",
        size: 9_357_755,
        files: {},
      },
    ],
    build: {
      root: `whisper.cpp-${WHISPER_COMMIT}`,
      configure: [...WHISPER_CLI_ONLY, ...configure],
      targets: ["whisper-cli"],
      files: { "whisper-cli": "bin/whisper-cli" },
      ...recipe,
    },
  };
}

/** Upstream publishes no macOS CLI: built locally with Metal, shaders embedded, one static executable. */
function whisperMacos(): PinnedBuild {
  return whisperSource(
    ["-DGGML_METAL=ON", "-DGGML_METAL_EMBED_LIBRARY=ON"],
    {
      toolchainHint:
        "Building whisper.cpp needs the Xcode Command Line Tools (`xcode-select --install`) and CMake " +
        "(`brew install cmake`, or https://cmake.org/download/)",
      duration: "about a minute",
    },
    { accelerator: "metal" },
  );
}

/**
 * Linux GPU candidates. Upstream publishes Linux CPU builds only, so the
 * pinned commit is built locally when the GPU and its toolchain are present.
 * `GGML_NATIVE=OFF`: `-march=native` breaks the CPU backend on some
 * compiler/CPU pairs (gcc 12 in an arm64 VM), and CUDA then covers ggml's
 * default architecture list, not only the GPU present at build time.
 * A failed build falls back to the next candidate.
 */
function whisperLinuxGpu(): PinnedBuild[] {
  return [
    whisperSource(
      ["-DGGML_NATIVE=OFF", "-DGGML_CUDA=ON"],
      {
        toolchainHint: "Building whisper.cpp with CUDA needs the NVIDIA driver, the CUDA toolkit (`nvcc`), a C++ compiler and CMake",
        duration: "10 to 30 minutes",
      },
      {
        accelerator: "cuda",
        requires: [NVIDIA_PROBE, { command: "nvcc", args: ["--version"], proves: "the CUDA toolkit (nvcc)" }, CMAKE_PROBE],
      },
    ),
    whisperSource(
      ["-DGGML_NATIVE=OFF", "-DGGML_VULKAN=ON"],
      {
        toolchainHint:
          "Building whisper.cpp with Vulkan needs a Vulkan driver, the Vulkan loader and headers (`libvulkan-dev`), " +
          "SPIR-V headers (`spirv-headers`), `glslc`, a C++ compiler and CMake",
        duration: "a few minutes",
      },
      {
        accelerator: "vulkan",
        requires: [
          { command: "vulkaninfo", args: ["--summary"], proves: "a Vulkan driver (vulkaninfo, from vulkan-tools)" },
          { command: "glslc", args: ["--version"], proves: "the Vulkan shader compiler (glslc)" },
          CMAKE_PROBE,
        ],
      },
    ),
  ];
}

const X64_CPU_LIBS = [
  "alderlake", "cannonlake", "cascadelake", "cooperlake", "haswell", "icelake", "ivybridge",
  "piledriver", "sandybridge", "sapphirerapids", "skylakex", "sse42", "x64", "zen4",
].map((variant) => `libggml-cpu-${variant}.so`);

const WIN_X64_CPU_DLLS = [
  "alderlake", "cannonlake", "cascadelake", "haswell", "icelake", "sandybridge", "skylakex", "sse42", "x64",
].map((variant) => `ggml-cpu-${variant}.dll`);

const WIN_X64_DLLS = ["whisper.dll", "ggml.dll", "ggml-base.dll", ...WIN_X64_CPU_DLLS];

/**
 * whisper.cpp `whisper-cli`, pinned: DTW and VAD behaviour change between
 * commits (ADR 0003). GPU first, CPU last: macOS builds the commit with
 * Metal; Windows x64 takes upstream's CUDA 12.4 build when an NVIDIA driver
 * is present; Linux builds the commit with CUDA or Vulkan when GPU and
 * toolchain are present; otherwise upstream CPU builds. ggml falls back to
 * CPU at run time when no GPU device initialises. Details: `docs/binaries.md`.
 */
export const WHISPER_PACKAGE: BinaryPackage = {
  name: "whisper-cpp",
  tools: ["whisper-cli"],
  onDemand: true,
  versionProbe: { args: ["--version"], pattern: /whisper\.cpp version: (\S+)/ },
  builds: {
    "darwin-arm64": whisperMacos(),
    "darwin-x64": whisperMacos(),
    "linux-x64": [
      ...whisperLinuxGpu(),
      whisperLinux("x64", "53e7fd8b5764edad916b8848dd0af6abb1ff1d3b86c899e79c78652412536c32", 9_793_438, X64_CPU_LIBS),
    ],
    "linux-arm64": [
      ...whisperLinuxGpu(),
      whisperLinux("arm64", "93532a0e3777f26f041ffa358ee77dd88b1a33a86847c1990745327ff335a5d6", 4_605_905, ["libggml-cpu.so"]),
    ],
    "win32-x64": [
      // Self-contained: ships cudart, cuBLAS and cuBLASLt 12. Only the driver (nvcuda.dll) comes from the system.
      whisperWindows(
        "whisper-cublas-12.4.0-bin-x64.zip",
        "af520ddd034d985b55dfeea3e465ed93653ba2aee1a55e865033edc548c272a7",
        674_539_285,
        [...WIN_X64_DLLS, "ggml-cuda.dll", "cudart64_12.dll", "cublas64_12.dll", "cublasLt64_12.dll"],
        { accelerator: "cuda", requires: [NVIDIA_PROBE] },
      ),
      whisperWindows("whisper-bin-x64.zip", "f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c", 8_573_270, WIN_X64_DLLS),
    ],
    "win32-arm64": whisperWindows(
      "whisper-bin-win-cpu-arm64.zip",
      "799543b926ab5b6c2d60cab269a2092e0ae8d27820e9e15429e59de3699546fc",
      4_361_895,
      ["whisper.dll", "ggml.dll", "ggml-base.dll", "ggml-cpu.dll", "libomp140.aarch64.dll"],
    ),
  },
};

const WHISPER_MODELS_REVISION = "5359861c739e955e79d9a303bcbc70fb988958b1";

function whisperModel(name: string, sha256: string, size: number): ManagedModel {
  const file = `ggml-${name}.bin`;
  return {
    id: `ggml-${name}`,
    version: WHISPER_MODELS_REVISION.slice(0, 12),
    origin: "https://huggingface.co/ggerganov/whisper.cpp",
    license: "MIT",
    urls: [`https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_MODELS_REVISION}/${file}`],
    sha256,
    size,
    file,
  };
}

/** whisper.cpp models (ADR 0003): q5_0 default, q8_0 and f16 selectable. */
export const WHISPER_MODELS: readonly ManagedModel[] = [
  whisperModel("large-v3-turbo-q5_0", "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2", 574_041_195),
  whisperModel("large-v3-turbo-q8_0", "317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1", 874_188_075),
  whisperModel("large-v3-turbo", "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69", 1_624_555_275),
];

/** Candidates for `platform`, in preference order; empty when nothing is pinned. */
export function buildCandidates(pkg: BinaryPackage, platform: PlatformKey): readonly PinnedBuild[] {
  const builds = pkg.builds[platform];
  if (!builds) return [];
  return isCandidateList(builds) ? builds : [builds];
}

function isCandidateList(builds: PinnedBuild | readonly PinnedBuild[]): builds is readonly PinnedBuild[] {
  return Array.isArray(builds);
}

/** Every package the daemon manages. Headless Chrome joins here. */
export const DEFAULT_PACKAGES: readonly BinaryPackage[] = [FFMPEG_PACKAGE, WHISPER_PACKAGE];

/** Every model the daemon manages. */
export const DEFAULT_MODELS: readonly ManagedModel[] = WHISPER_MODELS;
