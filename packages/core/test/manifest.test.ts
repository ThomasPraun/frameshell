import { describe, expect, it } from "vitest";
import { BinaryManager, FFMPEG_PACKAGE, currentPlatform, runDoctor } from "../src/index.js";
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

// Opt-in: downloads the real pinned build (~60-170 MB) for this platform.
// Run with FRAMESHELL_TEST_REAL_DOWNLOAD=1 pnpm test.
describe.runIf(process.env["FRAMESHELL_TEST_REAL_DOWNLOAD"] === "1")("real pinned ffmpeg download", () => {
  it(
    `installs the ${currentPlatform()} pin, verified, with x264 and libvpx encode and decode`,
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
    },
    600_000,
  );
});
