import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ErrorCode } from "@frameshell/protocol";
import { type BinaryPackage, BinaryManager, currentPlatform } from "../src/index.js";
import { tarGz, zip } from "./archives.js";
import { tempDir } from "./helpers.js";

// Local fixture server: real HTTP, real hashing, real `tar`; no network.
const files = new Map<string, Buffer>();
const hits = new Map<string, number>();
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const body = files.get(req.url ?? "");
    hits.set(req.url ?? "", (hits.get(req.url ?? "") ?? 0) + 1);
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    // Slow first byte so concurrent installs overlap.
    setTimeout(() => res.writeHead(200, { "content-length": body.length }).end(body), 50);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => hits.clear());

const exe = process.platform === "win32" ? ".exe" : "";
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** Serve `archive` at a fresh path and return a package pinned to it. */
function pinned(archive: Buffer, options: { sha256?: string; files?: Record<string, string>; urls?: string[] } = {}): BinaryPackage {
  const path = `/${Math.random().toString(36).slice(2)}/tools.tar.gz`;
  files.set(path, archive);
  return {
    name: "tools",
    tools: ["alpha", "beta"],
    builds: {
      [currentPlatform()]: {
        version: "1.2.3",
        origin: "https://example.test",
        license: "GPL-3.0-or-later",
        archives: [
          {
            urls: options.urls ?? [`${base}${path}`],
            sha256: options.sha256 ?? sha256(archive),
            size: archive.length,
            files: options.files ?? { alpha: `pkg/bin/alpha${exe}`, beta: `pkg/bin/beta${exe}` },
          },
        ],
      },
    },
  };
}

const goodArchive = () =>
  tarGz({ [`pkg/bin/alpha${exe}`]: { content: "alpha-bin" }, [`pkg/bin/beta${exe}`]: { content: "beta-bin" }, "pkg/README": { content: "big docs" } });

function manager(pkg: BinaryPackage, dirs = { dataDir: tempDir(), configDir: tempDir() }) {
  return new BinaryManager({ ...dirs, packages: [pkg] });
}

/** Paths of every file under `dir`, relative. */
function tree(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[]).filter((p) => statSync(join(dir, p)).isFile()).sort();
}

describe("BinaryManager managed install", () => {
  it("downloads on first use, verifies, and installs every tool of the package under the data dir", async () => {
    const pkg = pinned(goodArchive());
    const binaries = manager(pkg);
    const before = await binaries.locate("alpha");
    expect(before).toMatchObject({ source: "managed", installed: false, pinned: { version: "1.2.3" } });

    const alpha = await binaries.ensure("alpha");
    expect(alpha).toBe(before.path);
    expect(alpha.startsWith(binaries.dataDir)).toBe(true);
    expect(alpha).toContain(join("binaries", "tools", "1.2.3", currentPlatform()));
    expect(readFileSync(alpha, "utf8")).toBe("alpha-bin");
    expect(readFileSync((await binaries.locate("beta")).path!, "utf8")).toBe("beta-bin");
    if (process.platform !== "win32") expect(statSync(alpha).mode & 0o111).not.toBe(0);
    // Only the pinned members are kept, not the whole archive.
    expect(existsSync(join(alpha, "..", "README"))).toBe(false);
    expect(await binaries.locate("beta")).toMatchObject({ installed: true });
  });

  it("downloads once: later and concurrent calls reuse the install", async () => {
    const pkg = pinned(goodArchive());
    const binaries = manager(pkg);
    const [a, b] = await Promise.all([binaries.ensure("alpha"), binaries.ensure("beta")]);
    await binaries.ensure("alpha");
    expect(a).not.toBe(b);
    expect([...hits.values()]).toEqual([1]);
  });

  it("a fresh manager on the same data dir finds the existing install without downloading", async () => {
    const pkg = pinned(goodArchive());
    const dirs = { dataDir: tempDir(), configDir: tempDir() };
    await manager(pkg, dirs).ensure("alpha");
    hits.clear();
    expect(await manager(pkg, dirs).ensure("beta")).toMatch(/beta/);
    expect(hits.size).toBe(0);
  });

  it("aborts on checksum mismatch with a clear error and installs nothing", async () => {
    const pkg = pinned(goodArchive(), { sha256: "0".repeat(64) });
    const binaries = manager(pkg);
    const error = await binaries.ensure("alpha").catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: ErrorCode.BinaryChecksumMismatch,
      message: expect.stringMatching(/checksum/i),
      data: { binary: "alpha", expected: "0".repeat(64), actual: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
    expect((await binaries.locate("alpha")).installed).toBe(false);
    // No partial install and no leftover staging dir.
    expect(tree(binaries.dataDir)).toEqual([]);
    expect(readdirSync(join(binaries.dataDir, "binaries"))).toEqual([]);
  });

  it("falls back to the next mirror when one fails", async () => {
    const archive = goodArchive();
    const good = pinned(archive);
    const goodUrl = good.builds[currentPlatform()]!.archives[0]!.urls[0]!;
    const pkg = pinned(archive, { urls: [`${base}/missing.tar.gz`, goodUrl] });
    expect(readFileSync(await manager(pkg).ensure("alpha"), "utf8")).toBe("alpha-bin");
  });

  it("reports an unreachable download as BinaryInstallFailed naming the URL", async () => {
    const pkg = pinned(goodArchive(), { urls: [`${base}/missing.tar.gz`] });
    await expect(manager(pkg).ensure("alpha")).rejects.toMatchObject({
      code: ErrorCode.BinaryInstallFailed,
      message: expect.stringContaining("/missing.tar.gz"),
    });
  });

  it("reports an archive missing a pinned member instead of installing half a package", async () => {
    const pkg = pinned(goodArchive(), { files: { alpha: `pkg/bin/alpha${exe}`, beta: "pkg/bin/nope" } });
    const binaries = manager(pkg);
    await expect(binaries.ensure("alpha")).rejects.toMatchObject({ code: ErrorCode.BinaryInstallFailed });
    expect(tree(binaries.dataDir)).toEqual([]);
  });

  it.skipIf(process.platform === "linux")("extracts zip archives, the format of the macOS and Windows pins", async () => {
    const archive = zip({ [`alpha${exe}`]: { content: "zip-alpha" }, [`beta${exe}`]: { content: "zip-beta" } });
    const pkg = pinned(archive, { files: { alpha: `alpha${exe}`, beta: `beta${exe}` } });
    const alpha = await manager(pkg).ensure("alpha");
    expect(readFileSync(alpha, "utf8")).toBe("zip-alpha");
  });

  it("fails with BinaryUnavailable when nothing is pinned for this platform", async () => {
    const pkg: BinaryPackage = { name: "tools", tools: ["alpha"], builds: {} };
    const binaries = manager(pkg);
    expect(await binaries.locate("alpha")).toMatchObject({ source: "managed", path: null, pinned: null });
    await expect(binaries.ensure("alpha")).rejects.toMatchObject({
      code: ErrorCode.BinaryUnavailable,
      message: expect.stringContaining("binaries"),
      data: { binary: "alpha", platform: currentPlatform() },
    });
  });
});

describe("BinaryManager overrides", () => {
  /** Fake system install: an `alpha` and a `beta` side by side. */
  function systemInstall(): { dir: string; alpha: string; beta: string } {
    const dir = tempDir();
    for (const tool of ["alpha", "beta"]) writeFileSync(join(dir, `${tool}${exe}`), tool);
    return { dir, alpha: join(dir, `alpha${exe}`), beta: join(dir, `beta${exe}`) };
  }

  function withGlobalConfig(config: unknown) {
    const dirs = { dataDir: tempDir(), configDir: tempDir() };
    writeFileSync(join(dirs.configDir, "config.json"), JSON.stringify(config));
    return manager(pinned(goodArchive()), dirs);
  }

  it("uses a global config path instead of downloading", async () => {
    const system = systemInstall();
    const binaries = withGlobalConfig({ binaries: { alpha: system.alpha } });
    expect(await binaries.locate("alpha")).toMatchObject({ source: "global", path: system.alpha, installed: true });
    expect(await binaries.ensure("alpha")).toBe(system.alpha);
    expect(hits.size).toBe(0);
  });

  it("takes package siblings from the overridden tool's directory", async () => {
    const system = systemInstall();
    const binaries = withGlobalConfig({ binaries: { alpha: system.alpha } });
    expect(await binaries.locate("beta")).toMatchObject({ source: "global", path: system.beta });
  });

  it("lets the project override the global config, with paths relative to the project", async () => {
    const system = systemInstall();
    const other = systemInstall();
    const binaries = withGlobalConfig({ binaries: { alpha: other.alpha } });
    const project = { dir: system.dir, binaries: { alpha: `alpha${exe}` } };
    expect(await binaries.locate("alpha", project)).toMatchObject({ source: "project", path: system.alpha });
    expect(await binaries.ensure("beta", project)).toBe(system.beta);
  });

  it("treats \"managed\" in the project as opting out of a global override", async () => {
    const system = systemInstall();
    const binaries = withGlobalConfig({ binaries: { alpha: system.alpha } });
    const project = { dir: tempDir(), binaries: { alpha: "managed" } };
    expect(await binaries.locate("beta", project)).toMatchObject({ source: "managed", installed: false });
  });

  it("fails with BinaryNotFound when an override points at a missing file", async () => {
    const missing = join(tempDir(), `alpha${exe}`);
    const binaries = withGlobalConfig({ binaries: { alpha: missing } });
    expect(await binaries.locate("alpha")).toMatchObject({ source: "global", installed: false });
    await expect(binaries.ensure("alpha")).rejects.toMatchObject({
      code: ErrorCode.BinaryNotFound,
      data: { binary: "alpha", path: missing, source: "global" },
    });
  });

  it("rejects an invalid global config with its path", async () => {
    const dirs = { dataDir: tempDir(), configDir: tempDir() };
    mkdirSync(dirs.configDir, { recursive: true });
    writeFileSync(join(dirs.configDir, "config.json"), JSON.stringify({ binaries: { alpha: 7 } }));
    await expect(manager(pinned(goodArchive()), dirs).locate("alpha")).rejects.toMatchObject({
      code: ErrorCode.InvalidGlobalConfig,
      message: expect.stringContaining("config.json"),
    });
  });
});
