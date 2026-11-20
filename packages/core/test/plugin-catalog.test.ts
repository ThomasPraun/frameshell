import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type DaemonConnection, ErrorCode, OFFICIAL_PLUGINS, connectToDaemon } from "@frameshell/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BinaryManager, type Daemon, buildCandidates, startDaemon, CHROME_HEADLESS_SHELL_PACKAGE } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";

// Seam under test: `plugin.catalog` on a real daemon with a temp project and temp app dirs. Nothing is downloaded:
// every download state is read from the binary manager.
const KEY = "sk-proj-FAKEKEY-catalog-0123456789";

let daemon: Daemon;
let conn: DaemonConnection;
let binaries: BinaryManager;
let dir: string;
const savedKey = process.env.OPENAI_API_KEY;

beforeEach(async () => {
  // standardPaths off: the machine's own Blender must not be seen.
  binaries = new BinaryManager({ dataDir: tempDir(), configDir: tempDir(), standardPaths: false });
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), binaries });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
  dir = tempDir();
  await conn.request("project.init", { dir });
  delete process.env.OPENAI_API_KEY;
});

afterEach(async () => {
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedKey;
  conn.close();
  await daemon.close();
});

function patchConfig(patch: Record<string, unknown>): void {
  const path = join(dir, "frameshell.json");
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ...patch }));
}

describe("plugin.catalog", () => {
  it("lists every official plugin, none installed, in a project without plugins", async () => {
    const catalog = await conn.request("plugin.catalog", { cwd: dir });
    expect(catalog).toMatchObject({ dir, platform: binaries.platform, trust: "not-required" });
    expect(catalog.plugins.map((plugin) => plugin.name)).toEqual(OFFICIAL_PLUGINS.map((plugin) => plugin.name));
    for (const plugin of catalog.plugins) {
      expect(plugin).toMatchObject({ installed: false, pin: null, status: null, version: null, error: null });
    }
    const whisper = catalog.plugins.find((plugin) => plugin.name === "@frameshell/whisper-cpp")!;
    expect(whisper).toMatchObject({ kind: "transcription-provider", provides: ["whisper-cpp"], paid: false, cloud: false, need: { kind: "none", met: true } });
    expect(whisper.downloads.map((download) => [download.kind, download.id, download.onDisk])).toEqual([
      ["binary", "whisper-cpp", false],
      ["model", "ggml-large-v3-turbo-q5_0", false],
    ]);
    expect(whisper.downloads[1]!.bytes).toBe(574_041_195);
    expect(whisper.downloadBytes).toBe(whisper.downloads.reduce((total, download) => total + (download.bytes ?? 0), 0));
  });

  it("sizes a binary package from the build pinned for this platform, or null without one", async () => {
    const catalog = await conn.request("plugin.catalog", { cwd: dir });
    const chrome = catalog.plugins.find((plugin) => plugin.name === "@frameshell/remotion")!.downloads[0]!;
    const pinned = buildCandidates(CHROME_HEADLESS_SHELL_PACKAGE, binaries.platform).at(-1);
    expect(chrome.bytes).toBe(pinned ? pinned.archives.reduce((total, archive) => total + archive.size, 0) : null);
  });

  it("marks a download on disk and stops counting it", async () => {
    const model = await binaries.locateModel("ggml-large-v3-turbo-q5_0");
    mkdirSync(dirname(model.path), { recursive: true });
    writeFileSync(model.path, "x");
    const whisper = (await conn.request("plugin.catalog", { cwd: dir })).plugins.find((plugin) => plugin.name === "@frameshell/whisper-cpp")!;
    expect(whisper.downloads[1]).toMatchObject({ id: "ggml-large-v3-turbo-q5_0", onDisk: true });
    expect(whisper.downloadBytes).toBe(whisper.downloads[0]!.bytes ?? 0);
  });

  it("says whether an OpenAI key is set without returning it", async () => {
    const find = async () => (await conn.request("plugin.catalog", { cwd: dir })).plugins.find((plugin) => plugin.name === "@frameshell/openai-speech")!;
    expect(await find()).toMatchObject({ paid: true, cloud: true, need: { kind: "openai-key", met: false } });
    process.env.OPENAI_API_KEY = KEY;
    const catalog = await conn.request("plugin.catalog", { cwd: dir });
    expect(catalog.plugins.filter((plugin) => plugin.need.kind === "openai-key").map((plugin) => plugin.need.met)).toEqual([true, true]);
    expect(JSON.stringify(catalog)).not.toContain(KEY);
  });

  it("finds Blender through a binaries override, and reports it missing otherwise", async () => {
    const blender = () => conn.request("plugin.catalog", { cwd: dir }).then((catalog) => catalog.plugins.find((plugin) => plugin.name === "@frameshell/blender")!);
    expect((await blender()).need).toMatchObject({ kind: "blender", met: false });
    mkdirSync(join(dir, "tools"));
    writeFileSync(join(dir, "tools", "blender"), "");
    patchConfig({ binaries: { blender: "tools/blender" } });
    expect((await blender()).need.met).toBe(true);
  });

  it("reports a pinned plugin as untrusted without loading it, and the trust state", async () => {
    patchConfig({ plugins: { "@frameshell/hyperframes": "0.5.0" } });
    const catalog = await conn.request("plugin.catalog", { cwd: dir });
    expect(catalog.trust).toBe("unknown");
    expect(catalog.plugins.find((plugin) => plugin.name === "@frameshell/hyperframes")).toMatchObject({
      installed: true,
      pin: "0.5.0",
      status: "untrusted",
      version: null,
    });
    expect(catalog.plugins.filter((plugin) => plugin.installed)).toHaveLength(1);
  });

  it("fails with ProjectNotFound outside a project and InvalidParams for a relative cwd", async () => {
    await expect(conn.request("plugin.catalog", { cwd: tempDir() })).rejects.toMatchObject({ code: ErrorCode.ProjectNotFound });
    await expect(conn.request("plugin.catalog", { cwd: "relative" })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });
});
