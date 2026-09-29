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
}

/** Exact build pinned for one platform. Never floating: tools change behaviour between versions. */
export interface PinnedBuild {
  readonly version: string;
  /** Who builds it (homepage), shown by `doctor`. */
  readonly origin: string;
  /** SPDX licence of the build as distributed. */
  readonly license: string;
  /** Together they provide every tool of the package. */
  readonly archives: readonly PinnedArchive[];
}

/** Set of executables installed and versioned together, e.g. ffmpeg + ffprobe. */
export interface BinaryPackage {
  /** Directory name under `<dataDir>/binaries/`. */
  readonly name: string;
  /** Executable names without `.exe`; the first is the one users override by default. */
  readonly tools: readonly string[];
  readonly builds: Readonly<Partial<Record<PlatformKey, PinnedBuild>>>;
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

/** Every package the daemon manages. whisper.cpp and headless Chrome join here. */
export const DEFAULT_PACKAGES: readonly BinaryPackage[] = [FFMPEG_PACKAGE];
