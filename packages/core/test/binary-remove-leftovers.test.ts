import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorCode } from "@frameshell/protocol";
import { BinaryManager, currentPlatform } from "../src/index.js";
import { tempDir } from "./helpers.js";

// What the system lets `remove` do to the files it already moved away, and a hook inside the directory read.
const fsHooks = vi.hoisted(() => ({
  /** `all`: deleting a `.removing-*` directory fails; `partial`: it deletes `gone.bin` only, then fails. */
  rm: "off" as "off" | "all" | "partial",
  onStat: undefined as undefined | (() => Promise<void>),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    rm: async (path: string, options?: Parameters<typeof original.rm>[1]) => {
      if (fsHooks.rm !== "off" && String(path).includes(".removing-")) {
        if (fsHooks.rm === "partial") await original.rm(join(String(path), "1.0.0", "gone.bin"), { force: true });
        throw Object.assign(new Error("resource busy"), { code: "EBUSY" });
      }
      return original.rm(path, options);
    },
    stat: async (...args: Parameters<typeof original.stat>) => {
      const hook = fsHooks.onStat;
      fsHooks.onStat = undefined;
      await hook?.();
      return original.stat(...args);
    },
  };
});

// A pinned model that never answers: an install that stays in flight.
const hanging = createServer(() => undefined);
const listening = new Promise<void>((resolve) => hanging.listen(0, "127.0.0.1", resolve));

afterEach(() => {
  fsHooks.rm = "off";
  fsHooks.onStat = undefined;
});

const pin = (id: string, url = "http://127.0.0.1:1/model.bin") => ({
  id,
  version: "2.0.0",
  origin: "https://example.test",
  license: "MIT",
  urls: [url],
  sha256: "0".repeat(64),
  size: 10,
  file: `${id}.bin`,
});

/** A manager with an installed model `m` (version 1.0.0, two files) and an installed package `tools`. */
function setup() {
  const dataDir = tempDir();
  const binaries = new BinaryManager({
    dataDir,
    configDir: tempDir(),
    packages: [{ name: "tools", tools: ["alpha"], builds: { [currentPlatform()]: { version: "1.2.3", origin: "https://example.test", license: "MIT", archives: [] } } }],
    models: [pin("m")],
  });
  const model = join(dataDir, "models", "m", "1.0.0");
  mkdirSync(model, { recursive: true });
  writeFileSync(join(model, "gone.bin"), Buffer.alloc(1000));
  writeFileSync(join(model, "stuck.bin"), Buffer.alloc(300));
  const tools = join(dataDir, "binaries", "tools", "1.2.3");
  mkdirSync(tools, { recursive: true });
  writeFileSync(join(tools, "alpha"), "alpha");
  return { dataDir, binaries };
}

describe("BinaryManager.remove leftovers and byte accounting", () => {
  it("reports no bytes freed when nothing could be deleted, and a later removal sweeps the leftover", async () => {
    const { dataDir, binaries } = setup();
    fsHooks.rm = "all";
    expect(await binaries.remove("m")).toMatchObject({ removed: true, versions: ["1.0.0"], bytes: 0 });
    expect(readdirSync(join(dataDir, "models")).filter((name) => name.startsWith(".removing-m-"))).toHaveLength(1);
    expect(existsSync(join(dataDir, "models", "m"))).toBe(false);

    fsHooks.rm = "off";
    expect(await binaries.remove("tools")).toMatchObject({ removed: true });
    expect(readdirSync(join(dataDir, "models"))).toEqual([]);
  });

  it("counts only the bytes that really went away", async () => {
    const { binaries } = setup();
    fsHooks.rm = "partial";
    expect(await binaries.remove("m")).toMatchObject({ removed: true, bytes: 1000 });
  });

  it("sweeps leftovers of any name in binaries/ and models/, and never touches anything else", async () => {
    const { dataDir, binaries } = setup();
    const stale = [join(dataDir, "binaries", ".removing-old-1"), join(dataDir, "models", ".removing-other-2")];
    for (const dir of stale) {
      mkdirSync(dir);
      writeFileSync(join(dir, "file"), "x");
    }
    const keep = [join(dataDir, "binaries", ".staging"), join(dataDir, "binaries", "removing-plain"), join(dataDir, ".removing-outside")];
    for (const dir of keep) mkdirSync(dir);

    expect(await binaries.remove("tools")).toMatchObject({ removed: true });
    for (const dir of stale) expect(existsSync(dir)).toBe(false);
    for (const dir of keep) expect(existsSync(dir)).toBe(true);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("surfaces a permission error, not files-open, when the rename is denied off Windows", async () => {
    const { dataDir, binaries } = setup();
    const denied = join(dataDir, "binaries");
    chmodSync(denied, 0o555);
    try {
      const error = await binaries.remove("tools").catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as { code?: number }).code).not.toBe(ErrorCode.BinaryInUse);
      expect((error as Error).message).toContain("data directory");
      expect(existsSync(join(denied, "tools", "1.2.3", "alpha"))).toBe(true);
    } finally {
      chmodSync(denied, 0o755);
    }
  });

  it("refuses when an install starts while the directory is being read", async () => {
    await listening;
    const url = `http://127.0.0.1:${(hanging.address() as AddressInfo).port}/model.bin`;
    const dataDir = tempDir();
    const binaries = new BinaryManager({ dataDir, configDir: tempDir(), packages: [], models: [pin("m", url)] });
    mkdirSync(join(dataDir, "models", "m", "1.0.0"), { recursive: true });
    writeFileSync(join(dataDir, "models", "m", "1.0.0", "old.bin"), "old");

    let install: Promise<unknown> = Promise.resolve();
    fsHooks.onStat = async () => {
      install = binaries.ensureModel("m").catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 150));
    };
    await expect(binaries.remove("m")).rejects.toMatchObject({ code: ErrorCode.BinaryInUse, data: { name: "m", reason: "installing" } });
    expect(existsSync(join(dataDir, "models", "m", "1.0.0", "old.bin"))).toBe(true);
    hanging.closeAllConnections();
    await install;
  });
});
