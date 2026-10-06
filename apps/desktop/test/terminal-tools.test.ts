import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { BinaryManager } from "@frameshell/core/binaries";
import { terminalLaunch } from "../src/main/terminal-launch.js";
import { terminalToolPaths } from "../src/main/terminal-tools.js";

const exe = process.platform === "win32" ? ".exe" : "";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "frameshell-tools-"));
  const dataDir = join(root, "data");
  const configDir = join(root, "config");
  const projectDir = join(root, "project");
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, "frameshell.json"), "{}");
  // Optional GPU builds are never chosen: their machine probes fail here.
  const manager = new BinaryManager({ dataDir, configDir, commandRunner: () => Promise.reject(new Error("no gpu")) });
  /** Put a fake executable where the manager expects `tool`; returns its path. */
  const install = async (tool: string) => {
    const { path } = await manager.locate(tool);
    if (!path) throw new Error(`no managed ${tool} pinned for this platform`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "");
    await chmod(path, 0o755);
    return path;
  };
  return { dataDir, configDir, projectDir, manager, install };
}

describe("terminalToolPaths", () => {
  it("lists only the managed tools that are installed", async () => {
    const { manager, projectDir, install, dataDir } = await fixture();
    const ffmpeg = await install("ffmpeg");
    const ffprobe = await install("ffprobe");
    expect(await terminalToolPaths(manager, projectDir)).toEqual({
      ffmpeg: { path: ffmpeg, managed: true },
      ffprobe: { path: ffprobe, managed: true },
    });
    expect(ffmpeg.startsWith(join(dataDir, "binaries"))).toBe(true);
  });

  it("is empty when nothing is installed yet", async () => {
    const { manager, projectDir } = await fixture();
    expect(await terminalToolPaths(manager, projectDir)).toEqual({});
  });

  it("follows the project's binaries override, like the daemon", async () => {
    const { manager, projectDir } = await fixture();
    const own = join(projectDir, "tools", `ffmpeg${exe}`);
    await mkdir(dirname(own), { recursive: true });
    await writeFile(own, "");
    await writeFile(join(projectDir, "frameshell.json"), JSON.stringify({ binaries: { ffmpeg: `tools/ffmpeg${exe}` } }));
    expect((await terminalToolPaths(manager, projectDir))["ffmpeg"]).toEqual({ path: own, managed: false });
  });

  it("leaves tools out instead of failing when the global config is malformed", async () => {
    const { manager, projectDir, configDir, install } = await fixture();
    await install("ffmpeg");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "config.json"), "{ not json");
    expect(await terminalToolPaths(manager, projectDir)).toEqual({});
  });
});

describe("terminalLaunch with tools", () => {
  const base = { projectDir: "/videos/talk", socketPath: "/tmp/s.sock", session: "term-1", binDir: "/app-data/bin" };

  it("puts each tool's directory on PATH after the CLI shim, once per directory, and names each tool", () => {
    const { env } = terminalLaunch({
      ...base,
      platform: "linux",
      env: { PATH: "/usr/bin" },
      tools: {
        ffmpeg: { path: "/data/binaries/ffmpeg/7.1/linux-x64/ffmpeg", managed: true },
        ffprobe: { path: "/data/binaries/ffmpeg/7.1/linux-x64/ffprobe", managed: true },
        "whisper-cli": { path: "/data/binaries/whisper-cpp/1.7/linux-x64/whisper-cli", managed: true },
      },
    });
    expect(env["PATH"]).toBe(
      "/app-data/bin:/data/binaries/ffmpeg/7.1/linux-x64:/data/binaries/whisper-cpp/1.7/linux-x64:/usr/bin",
    );
    expect(env).toMatchObject({
      FRAMESHELL_FFMPEG: "/data/binaries/ffmpeg/7.1/linux-x64/ffmpeg",
      FRAMESHELL_FFPROBE: "/data/binaries/ffmpeg/7.1/linux-x64/ffprobe",
      FRAMESHELL_WHISPER_CLI: "/data/binaries/whisper-cpp/1.7/linux-x64/whisper-cli",
    });
  });

  it("uses Windows paths and delimiter on Windows", () => {
    const { env } = terminalLaunch({
      ...base,
      platform: "win32",
      binDir: "C:\\bin",
      env: { Path: "C:\\Windows" },
      tools: { ffmpeg: { path: "C:\\Data\\binaries\\ffmpeg\\7.1\\win32-x64\\ffmpeg.exe", managed: true } },
    });
    expect(env["Path"]).toBe("C:\\bin;C:\\Data\\binaries\\ffmpeg\\7.1\\win32-x64;C:\\Windows");
    expect(env["FRAMESHELL_FFMPEG"]).toBe("C:\\Data\\binaries\\ffmpeg\\7.1\\win32-x64\\ffmpeg.exe");
  });

  it("names override tools but never reorders PATH for them", () => {
    const { env } = terminalLaunch({
      ...base,
      platform: "linux",
      env: { PATH: "/opt/homebrew/bin:/usr/bin" },
      tools: {
        ffmpeg: { path: "/usr/bin/ffmpeg", managed: false },
        ffprobe: { path: "/videos/talk/bin/ffprobe", managed: false },
        "whisper-cli": { path: "/data/binaries/whisper-cpp/1.7/linux-x64/whisper-cli", managed: true },
      },
    });
    expect(env["PATH"]).toBe("/app-data/bin:/data/binaries/whisper-cpp/1.7/linux-x64:/opt/homebrew/bin:/usr/bin");
    expect(env).toMatchObject({
      FRAMESHELL_FFMPEG: "/usr/bin/ffmpeg",
      FRAMESHELL_FFPROBE: "/videos/talk/bin/ffprobe",
    });
  });

  it("sets no tool variables when none are installed", () => {
    const { env } = terminalLaunch({ ...base, platform: "linux", env: { PATH: "/usr/bin" } });
    expect(env["PATH"]).toBe("/app-data/bin:/usr/bin");
    expect(env["FRAMESHELL_FFMPEG"]).toBeUndefined();
  });
});
