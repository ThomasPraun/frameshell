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
   * Its executables must answer the package's version probe before the
   * install is published; if they do not, the next candidate installs.
   */
  readonly requires?: readonly MachineProbe[];
  /** Who builds it (homepage), shown by `doctor`. */
  readonly origin: string;
  /** SPDX licence of the build as distributed. */
  readonly license: string;
  /** Together they provide every tool of the package. */
  readonly archives: readonly PinnedArchive[];
  /**
   * Corresponding source published next to the mirrored binaries (GPL-3.0 §6).
   * Required when the package has a `mirror`: `planMirror` rejects a mirrored build without it.
   */
  readonly sources?: readonly SourceArchive[];
}

/** Source archive the mirror republishes byte for byte. Never fetched by the daemon. */
export interface SourceArchive {
  /** Asset name in the mirror release. Builds sharing a source use the same name. */
  readonly name: string;
  readonly url: string;
  /** Lowercase hex SHA-256; the mirror job aborts on mismatch. */
  readonly sha256: string;
  readonly size: number;
  /** One line for the release notes and the written offer. */
  readonly description: string;
}

/** GitHub release that republishes every pinned archive of a package, with its source. */
export interface BinaryMirror {
  /** `owner/name` of the repository hosting the release. */
  readonly repo: string;
  /** Release tag. Assets are immutable: a re-pin needs a new tag. */
  readonly tag: string;
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
  /** Fallback copy of every archive. Each archive then lists its mirror URL after the canonical one. */
  readonly mirror?: BinaryMirror;
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

/** Download URL of `asset` in the mirror release. */
export function mirrorUrl(mirror: BinaryMirror, asset: string): string {
  return `https://github.com/${mirror.repo}/releases/download/${mirror.tag}/${asset}`;
}

const MARTIN_RIEDL = "https://ffmpeg.martin-riedl.de";
const BTBN = "https://github.com/BtbN/FFmpeg-Builds";
const BTBN_RELEASE = `${BTBN}/releases/download/autobuild-2026-08-31-13-27`;
const BTBN_BUILD = "ffmpeg-n9.0.1-11-ge47273f4d9";

/** Frameshell's copy of every ffmpeg archive below, with source. Published by `.github/workflows/binaries-mirror.yml`. */
const FFMPEG_MIRROR: BinaryMirror = { repo: "ThomasPraun/frameshell", tag: "ffmpeg-mirror-2026-09-29" };

/** Canonical URL first, mirror second: the manager falls back on network error or checksum mismatch. */
function mirrored(canonical: string, asset: string): readonly string[] {
  return [canonical, mirrorUrl(FFMPEG_MIRROR, asset)];
}

// Revisions checked against the builds: Riedl's `versions.txt` matches the `version/` pins of
// build-script 6a611e1 (develop head when 9.0.2 was built); BtbN tag `autobuild-2026-08-31-13-27`
// points at FFmpeg-Builds 8267213, and the binaries report FFmpeg e47273f4d9 (release/9.0).
const RIEDL_SOURCES: readonly SourceArchive[] = [
  {
    name: "source-ffmpeg-9.0.2.tar.xz",
    url: "https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz",
    sha256: "8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e",
    size: 12_040_788,
    description: "FFmpeg 9.0.2 release source (macOS builds)",
  },
  {
    name: "source-martin-riedl-build-script-6a611e1.tar.gz",
    url: "https://git.martin-riedl.de/ffmpeg/build-script/archive/6a611e19870e197bc37c6e4c7fccddebd3715466.tar.gz",
    sha256: "467803813ab9f090052b0913bd12f984dcee888b154eb3644f7b1cbf04b57887",
    size: 2_610_328,
    description: "Martin Riedl build scripts at 6a611e1: configure flags and every library version (`version/`)",
  },
];

const BTBN_SOURCES: readonly SourceArchive[] = [
  {
    name: "source-ffmpeg-e47273f4d9.tar.gz",
    url: "https://github.com/FFmpeg/FFmpeg/archive/e47273f4d9227152dcbf543cebaf9e2430ddbcc4.tar.gz",
    sha256: "6491dae95e3cf3cdbac02933b55860e782b0c4f0a6bd8f37cef30fded259283c",
    size: 17_323_649,
    description: "FFmpeg source at e47273f4d9 (n9.0.1-11; Linux and Windows builds)",
  },
  {
    name: "source-btbn-ffmpeg-builds-8267213.tar.gz",
    url: "https://github.com/BtbN/FFmpeg-Builds/archive/8267213e26c1031621e6e1210fe3aa4867214f6a.tar.gz",
    sha256: "08279484656a586c149e119a20d3853f2596ee08192d97595edd2a5ba3b4fd51",
    size: 103_067,
    description: "BtbN FFmpeg-Builds scripts at 8267213: every library repository and commit (`scripts.d/`)",
  },
];

function riedl(
  path: string,
  platform: PlatformKey,
  ffmpeg: [string, number],
  ffprobe: [string, number],
): PinnedBuild {
  const archive = (tool: string, [sha256, size]: [string, number]): PinnedArchive => ({
    // Both macOS builds name their zips `<tool>.zip`: the mirror asset name adds version and platform.
    urls: mirrored(`${MARTIN_RIEDL}/download/macos/${path}/${tool}.zip`, `ffmpeg-9.0.2-${platform}-${tool}.zip`),
    sha256,
    size,
    files: { [tool]: tool },
  });
  return {
    version: "9.0.2",
    origin: MARTIN_RIEDL,
    license: "GPL-3.0-or-later",
    archives: [archive("ffmpeg", ffmpeg), archive("ffprobe", ffprobe)],
    sources: RIEDL_SOURCES,
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
        urls: mirrored(`${BTBN_RELEASE}/${dir}.${ext}`, `${dir}.${ext}`),
        sha256,
        size,
        files: { ffmpeg: `${dir}/bin/ffmpeg${exe}`, ffprobe: `${dir}/bin/ffprobe${exe}` },
      },
    ],
    sources: BTBN_SOURCES,
  };
}

/**
 * ffmpeg + ffprobe, GPL static builds with libx264 and libvpx (VP9 encoder and
 * decoder: ADR 0002). Sources, licences, mirror and how to re-pin: `docs/binaries.md`.
 */
export const FFMPEG_PACKAGE: BinaryPackage = {
  name: "ffmpeg",
  tools: ["ffmpeg", "ffprobe"],
  mirror: FFMPEG_MIRROR,
  builds: {
    "darwin-arm64": riedl(
      "arm64/1789931890_9.0.2",
      "darwin-arm64",
      ["c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924", 28_395_699],
      ["fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6", 28_317_701],
    ),
    "darwin-x64": riedl(
      "amd64/1789931006_9.0.2",
      "darwin-x64",
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

const NVIDIA_PROBE: MachineProbe = { command: "nvidia-smi", args: ["-L"], proves: "an NVIDIA GPU and driver" };

/** Pinned whisper.cpp source: tag v1.9.4 as GitHub's generated tarball. Input of every Frameshell build. */
export const WHISPER_SOURCE = {
  url: `https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/${WHISPER_COMMIT}`,
  sha256: "41b664fee09e79176ac277b5237debec34f8d74af3c7d71f333f1ec67989ecde",
  size: 9_357_755,
  /** Top directory of the tarball. */
  root: `whisper.cpp-${WHISPER_COMMIT}`,
} as const;

/**
 * whisper.cpp build Frameshell compiles in CI from {@link WHISPER_SOURCE} and
 * publishes on its GitHub release {@link WHISPER_FRAMESHELL_TAG}, for targets
 * upstream ships no executable for. The build is reproducible: CI rebuilds it
 * and refuses to publish bytes that differ from the pin
 * (`packages/core/scripts/whisper-cpp-build.mjs`).
 */
export interface FrameshellWhisperBuild {
  readonly platform: PlatformKey;
  readonly accelerator: Accelerator;
  /** Release asset: uncompressed tar holding `whisper-cli` and `LICENSE`. */
  readonly asset: string;
  readonly sha256: string;
  readonly size: number;
  /** CMake configure arguments; `CMAKE_BUILD_TYPE=Release` and path remapping are added by the build script. */
  readonly configure: readonly string[];
  /** GitHub Actions runner that builds it; a toolchain change changes the bytes. */
  readonly runner: string;
}

/** Frameshell release holding the {@link WHISPER_FRAMESHELL_BUILDS}. A published release is never changed: a re-pin takes a new tag. */
export const WHISPER_FRAMESHELL_TAG = "whisper-cpp-1.9.4-fs1";

/** Only the `whisper-cli` target, statically linked: nothing to place next to it. */
const WHISPER_CLI_ONLY = ["-DBUILD_SHARED_LIBS=OFF", "-DWHISPER_BUILD_TESTS=OFF", "-DWHISPER_BUILD_SERVER=OFF", "-DWHISPER_SDL2=OFF"];

/** Metal with its shader source embedded: one static executable. */
const MACOS_METAL = [...WHISPER_CLI_ONLY, "-DGGML_METAL=ON", "-DGGML_METAL_EMBED_LIBRARY=ON", "-DCMAKE_OSX_DEPLOYMENT_TARGET=13.3"];

/**
 * `GGML_NATIVE=OFF`: never tune for the build machine (not reproducible, and
 * `-march=native` breaks the CPU backend with some compiler/CPU pairs). On
 * x64 ggml then targets AVX2/FMA/F16C, hence the AVX2 probe. OpenMP off: no
 * `libgomp` needed at run time.
 */
const LINUX_VULKAN = [...WHISPER_CLI_ONLY, "-DGGML_NATIVE=OFF", "-DGGML_OPENMP=OFF", "-DGGML_VULKAN=ON"];

/** Every Frameshell-built whisper.cpp asset. Hashes come from CI; `docs/binaries.md` says how to re-pin. */
export const WHISPER_FRAMESHELL_BUILDS: readonly FrameshellWhisperBuild[] = [
  {
    platform: "darwin-arm64",
    accelerator: "metal",
    asset: `whisper-cli-${WHISPER_VERSION}-darwin-arm64-metal.tar`,
    sha256: "cb53212783b46b6c4d02fea56bc9040a08363c0e056f6299090cb53180dd7cd9",
    size: 4_587_520,
    configure: [...MACOS_METAL, "-DCMAKE_OSX_ARCHITECTURES=arm64"],
    runner: "macos-15",
  },
  {
    platform: "darwin-x64",
    accelerator: "metal",
    asset: `whisper-cli-${WHISPER_VERSION}-darwin-x64-metal.tar`,
    sha256: "49dfaaebde59cb00e91946bca501c3a183e8d016cfc1cad310c3494af2465be8",
    size: 5_062_656,
    // Cross-compiled on Apple silicon. Every Intel Mac that runs macOS 13 has AVX2.
    configure: [
      ...MACOS_METAL,
      "-DCMAKE_OSX_ARCHITECTURES=x86_64",
      "-DGGML_NATIVE=OFF",
      "-DGGML_AVX=ON",
      "-DGGML_AVX2=ON",
      "-DGGML_FMA=ON",
      "-DGGML_F16C=ON",
    ],
    runner: "macos-15",
  },
  {
    platform: "linux-x64",
    accelerator: "vulkan",
    asset: `whisper-cli-${WHISPER_VERSION}-linux-x64-vulkan.tar`,
    sha256: "d87263b1e62a1b6a29c50c676d80b0ba82b3083f9f4ae865ec0ce9a9bc715a05",
    size: 47_318_016,
    configure: LINUX_VULKAN,
    runner: "ubuntu-24.04",
  },
  {
    platform: "linux-arm64",
    accelerator: "vulkan",
    asset: `whisper-cli-${WHISPER_VERSION}-linux-arm64-vulkan.tar`,
    sha256: "fecf9cd0b0e1cdd2efe5504e98955c69a2e349ced7cc90658b85bca623cc3a38",
    size: 46_953_472,
    configure: LINUX_VULKAN,
    runner: "ubuntu-24.04-arm",
  },
];

/** Download URL of a Frameshell-built asset. */
export function frameshellWhisperUrl(build: Pick<FrameshellWhisperBuild, "asset">): string {
  return `https://github.com/ThomasPraun/frameshell/releases/download/${WHISPER_FRAMESHELL_TAG}/${build.asset}`;
}

function frameshellWhisper(platform: PlatformKey, gpu: Pick<PinnedBuild, "requires"> = {}): PinnedBuild {
  const build = WHISPER_FRAMESHELL_BUILDS.find((candidate) => candidate.platform === platform);
  if (!build) throw new Error(`No Frameshell whisper.cpp build for ${platform}`);
  return {
    version: WHISPER_VERSION,
    accelerator: build.accelerator,
    ...gpu,
    origin: "https://github.com/ThomasPraun/frameshell",
    license: "MIT",
    archives: [
      {
        urls: [frameshellWhisperUrl(build)],
        sha256: build.sha256,
        size: build.size,
        files: { "whisper-cli": "whisper-cli" },
        support: { LICENSE: "LICENSE" },
      },
    ],
  };
}

const VULKAN_PROBE: MachineProbe = {
  command: "vulkaninfo",
  args: ["--summary"],
  proves: "a Vulkan driver and loader (vulkaninfo, from vulkan-tools)",
};

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
 * commits (ADR 0003). Prebuilt for every platform, GPU first, CPU last:
 * macOS takes Frameshell's Metal build (upstream ships no macOS CLI);
 * Windows x64 takes upstream's CUDA 12.4 build when an NVIDIA driver answers;
 * Linux takes Frameshell's Vulkan build when a Vulkan driver answers;
 * otherwise upstream CPU builds. ggml falls back to CPU at run time when no
 * GPU device initialises. Details: `docs/binaries.md`.
 */
export const WHISPER_PACKAGE: BinaryPackage = {
  name: "whisper-cpp",
  tools: ["whisper-cli"],
  onDemand: true,
  versionProbe: { args: ["--version"], pattern: /whisper\.cpp version: (\S+)/ },
  builds: {
    // Metal builds also carry ggml's CPU backend: the provider's `-ng` retry runs on CPU.
    "darwin-arm64": frameshellWhisper("darwin-arm64"),
    "darwin-x64": frameshellWhisper("darwin-x64"),
    "linux-x64": [
      frameshellWhisper("linux-x64", {
        requires: [VULKAN_PROBE, { command: "grep", args: ["-qw", "avx2", "/proc/cpuinfo"], proves: "an AVX2 CPU" }],
      }),
      whisperLinux("x64", "53e7fd8b5764edad916b8848dd0af6abb1ff1d3b86c899e79c78652412536c32", 9_793_438, X64_CPU_LIBS),
    ],
    "linux-arm64": [
      frameshellWhisper("linux-arm64", { requires: [VULKAN_PROBE] }),
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
