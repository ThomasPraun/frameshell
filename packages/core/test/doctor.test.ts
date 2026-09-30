import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ErrorCode } from "@frameshell/protocol";
import { type BinaryPackage, BinaryManager, type Exec, currentPlatform, runDoctor } from "../src/index.js";
import { tempDir } from "./helpers.js";

const exe = process.platform === "win32" ? ".exe" : "";
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/ffmpeg-9.0.2-darwin-arm64/${name}.txt`, import.meta.url), "utf8");

/** Fake ffmpeg and ffprobe: answers by binary name, test encodes always succeed. */
const exec: Exec = async (file, args) => {
  const tool = file.includes("ffprobe") ? "ffprobe" : "ffmpeg";
  if (args.includes("-version")) return { code: 0, stdout: `${tool} version 7.1-system Copyright\n`, stderr: "" };
  if (args.includes("-encoders")) return { code: 0, stdout: fixture("encoders"), stderr: "" };
  if (args.includes("-decoders")) return { code: 0, stdout: fixture("decoders"), stderr: "" };
  return { code: 0, stdout: "", stderr: "" };
};

const ffmpegLike = (urls: string[] = ["http://127.0.0.1:9/never.zip"]): BinaryPackage => ({
  name: "ffmpeg",
  tools: ["ffmpeg", "ffprobe"],
  builds: {
    [currentPlatform()]: {
      version: "9.0.2",
      origin: "https://example.test",
      license: "GPL-3.0-or-later",
      archives: [{ urls, sha256: "a".repeat(64), size: 1, files: { ffmpeg: "ffmpeg", ffprobe: "ffprobe" } }],
    },
  },
});

function setup(globalConfig?: unknown) {
  const dirs = { dataDir: tempDir(), configDir: tempDir() };
  if (globalConfig) writeFileSync(join(dirs.configDir, "config.json"), JSON.stringify(globalConfig));
  return new BinaryManager({ ...dirs, packages: [ffmpegLike()] });
}

function systemFfmpeg() {
  const dir = tempDir();
  for (const tool of ["ffmpeg", "ffprobe"]) writeFileSync(join(dir, `${tool}${exe}`), "");
  return { dir, ffmpeg: join(dir, `ffmpeg${exe}`), ffprobe: join(dir, `ffprobe${exe}`) };
}

describe("runDoctor", () => {
  it("reports managed binaries not yet downloaded, with the pin and how to install, without downloading", async () => {
    const binaries = setup();
    const report = await runDoctor(binaries, { exec });
    expect(report).toMatchObject({ platform: currentPlatform(), dataDir: binaries.dataDir, codecs: [] });
    expect(report.binaries).toEqual([
      expect.objectContaining({ name: "ffmpeg", source: "managed", installed: false, version: null, pinned: expect.objectContaining({ version: "9.0.2", license: "GPL-3.0-or-later" }) }),
      expect.objectContaining({ name: "ffprobe", source: "managed", installed: false }),
    ]);
    expect(report.problems).toEqual([expect.stringMatching(/ffmpeg 9\.0\.2 is not installed.*doctor --install/)]);
  });

  it("probes an overridden system ffmpeg: versions, sources and codecs", async () => {
    const system = systemFfmpeg();
    const report = await runDoctor(setup({ binaries: { ffmpeg: system.ffmpeg } }), { exec });
    expect(report.binaries).toEqual([
      expect.objectContaining({ name: "ffmpeg", source: "global", path: system.ffmpeg, installed: true, version: "7.1-system" }),
      expect.objectContaining({ name: "ffprobe", source: "global", path: system.ffprobe, version: "7.1-system" }),
    ]);
    expect(report.codecs).toContainEqual(expect.objectContaining({ name: "libvpx-vp9", kind: "decoder", compiled: true }));
    expect(report.codecs).toContainEqual(expect.objectContaining({ name: "h264_videotoolbox", works: true }));
    expect(report.problems).toEqual([]);
  });

  it("applies the enclosing project's overrides", async () => {
    const system = systemFfmpeg();
    const report = await runDoctor(setup(), { exec, project: { dir: system.dir, binaries: { ffmpeg: `ffmpeg${exe}` } } });
    expect(report.binaries[0]).toMatchObject({ source: "project", path: system.ffmpeg });
  });

  it("names an override pointing at a missing file", async () => {
    const missing = join(tempDir(), "nope", `ffmpeg${exe}`);
    const report = await runDoctor(setup({ binaries: { ffmpeg: missing } }), { exec });
    expect(report.binaries[0]).toMatchObject({ source: "global", installed: false });
    expect(report.problems).toContainEqual(expect.stringContaining(missing));
  });

  it("with install, surfaces install failures instead of reporting", async () => {
    await expect(runDoctor(setup(), { exec, install: true })).rejects.toMatchObject({
      code: ErrorCode.BinaryInstallFailed,
    });
  });
});

describe("runDoctor with an on-demand package (whisper.cpp)", () => {
  const whisperLike = (): BinaryPackage => ({
    name: "whisper-cpp",
    tools: ["whisper-cli"],
    onDemand: true,
    versionProbe: { args: ["--version"], pattern: /whisper\.cpp version: (\S+)/ },
    builds: {
      [currentPlatform()]: {
        version: "1.9.4",
        origin: "https://example.test",
        license: "MIT",
        archives: [{ urls: ["http://127.0.0.1:9/never.tar.gz"], sha256: "b".repeat(64), size: 1, files: { "whisper-cli": "whisper-cli" } }],
      },
    },
  });
  const whisperExec: Exec = async (file, args) =>
    file.includes("whisper-cli") && args.includes("--version")
      ? { code: 0, stdout: "whisper.cpp version: 1.9.4\n", stderr: "" }
      : exec(file, args);

  it("lists it but does not call it a problem when not installed yet, and --install leaves it for first use", async () => {
    const system = systemFfmpeg();
    const binaries = new BinaryManager({ dataDir: tempDir(), configDir: tempDir(), packages: [ffmpegLike(), whisperLike()] });
    const project = { dir: system.dir, binaries: { ffmpeg: `ffmpeg${exe}` } };
    // Would reject if it tried to download whisper-cli from the unreachable pin.
    const report = await runDoctor(binaries, { exec: whisperExec, project, install: true });
    expect(report.binaries.at(-1)).toMatchObject({ name: "whisper-cli", source: "managed", installed: false, pinned: { version: "1.9.4" } });
    expect(report.problems).toEqual([]);
  });

  it("reads its version with the package's own probe", async () => {
    const system = systemFfmpeg();
    const whisper = join(system.dir, `whisper-cli${exe}`);
    writeFileSync(whisper, "");
    const binaries = new BinaryManager({ dataDir: tempDir(), configDir: tempDir(), packages: [ffmpegLike(), whisperLike()] });
    const project = { dir: system.dir, binaries: { ffmpeg: `ffmpeg${exe}`, "whisper-cli": `whisper-cli${exe}` } };
    const report = await runDoctor(binaries, { exec: whisperExec, project });
    expect(report.binaries.at(-1)).toMatchObject({ name: "whisper-cli", source: "project", version: "1.9.4" });
    expect(report.problems).toEqual([]);
  });
});
