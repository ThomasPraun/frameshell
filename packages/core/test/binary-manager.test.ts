import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { isAbsolute, join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ErrorCode } from "@frameshell/protocol";
import { type BinaryPackage, BinaryManager, type PinnedBuild, buildCandidates, currentPlatform } from "../src/index.js";
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
    const goodUrl = buildCandidates(good, currentPlatform())[0]!.archives[0]!.urls[0]!;
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

describe("BinaryManager support files", () => {
  it("places pinned libraries and licences next to the tools under their install names", async () => {
    const archive = tarGz({
      [`pkg/bin/alpha${exe}`]: { content: "alpha-bin" },
      [`pkg/bin/beta${exe}`]: { content: "beta-bin" },
      "pkg/lib/libalpha.so.1.2.3": { content: "lib-bytes" },
      "pkg/LICENSE": { content: "MIT" },
    });
    const pkg = pinned(archive);
    const build = buildCandidates(pkg, currentPlatform())[0]!;
    const withSupport: BinaryPackage = {
      ...pkg,
      builds: {
        [currentPlatform()]: {
          ...build,
          archives: [{ ...build.archives[0]!, support: { "libalpha.so.1": "pkg/lib/libalpha.so.1.2.3", LICENSE: "pkg/LICENSE" } }],
        },
      },
    };
    const alpha = await manager(withSupport).ensure("alpha");
    expect(readFileSync(join(alpha, "..", "libalpha.so.1"), "utf8")).toBe("lib-bytes");
    expect(readFileSync(join(alpha, "..", "LICENSE"), "utf8")).toBe("MIT");
  });

  it("installs a whole directory when the pin names a tree, from a deflated zip on every platform (headless Chrome)", async () => {
    // Chrome for Testing layout: one top directory, the executable beside its data files, zip only (also on Linux).
    const archive = zip(
      {
        [`shell-x/shell${exe}`]: { content: "shell-bin" },
        "shell-x/headless_lib_data.pak": { content: "pak", mode: 0o644 },
        "shell-x/locales/en-US.pak": { content: "strings", mode: 0o644 },
        "README.txt": { content: "outside the tree", mode: 0o644 },
      },
      { deflate: true },
    );
    const path = `/${Math.random().toString(36).slice(2)}/shell.zip`;
    files.set(path, archive);
    const pkg: BinaryPackage = {
      name: "shell",
      tools: ["shell"],
      builds: {
        [currentPlatform()]: {
          version: "154.0.1",
          origin: "https://example.test",
          license: "BSD-3-Clause",
          archives: [{ urls: [`${base}${path}`], sha256: sha256(archive), size: archive.length, tree: "shell-x", files: { shell: `shell-x/shell${exe}` } }],
        },
      },
    };
    const shell = await manager(pkg).ensure("shell");
    const dir = join(shell, "..");
    expect(tree(dir)).toEqual([`shell${exe}`, "headless_lib_data.pak", "install.json", join("locales", "en-US.pak")].sort());
    expect(readFileSync(join(dir, "locales", "en-US.pak"), "utf8")).toBe("strings");
    expect(readFileSync(shell, "utf8")).toBe("shell-bin");
    if (process.platform !== "win32") expect(statSync(shell).mode & 0o111).not.toBe(0);
  });
});

describe("BinaryManager GPU candidates", () => {
  const gpuArchive = () => tarGz({ [`gpu/alpha${exe}`]: { content: "cuda-alpha" }, [`gpu/beta${exe}`]: { content: "cuda-beta" } });

  /** Prebuilt CUDA archive requiring `nvidia-smi` and `nvcc`, then the CPU download as fallback. */
  function gpuThenCpu(options: { gpuSha256?: string } = {}): BinaryPackage {
    const archive = gpuArchive();
    const path = `/${Math.random().toString(36).slice(2)}/gpu.tar.gz`;
    files.set(path, archive);
    const cpu = buildCandidates(pinned(goodArchive()), currentPlatform())[0]!;
    const gpu: PinnedBuild = {
      version: "1.2.3",
      origin: "https://example.test",
      license: "MIT",
      accelerator: "cuda",
      requires: [
        { command: "nvidia-smi", args: ["-L"], proves: "an NVIDIA GPU" },
        { command: "nvcc", args: ["--version"], proves: "the CUDA toolkit" },
      ],
      archives: [
        {
          urls: [`${base}${path}`],
          sha256: options.gpuSha256 ?? sha256(archive),
          size: archive.length,
          files: { alpha: `gpu/alpha${exe}`, beta: `gpu/beta${exe}` },
        },
      ],
    };
    return { name: "tools", tools: ["alpha", "beta"], versionProbe: { args: ["--version"], pattern: /(\S+)/ }, builds: { [currentPlatform()]: [gpu, cpu] } };
  }

  /** Fake machine: `present` commands pass their probe; an installed executable run by absolute path starts unless `failStart`. */
  function fakeMachine(options: { present: string[]; failStart?: string }) {
    const calls: string[][] = [];
    const run = async (command: string, args: readonly string[], { cwd }: { cwd: string }) => {
      calls.push([command, ...args]);
      // Like spawn: a missing working directory fails the command.
      if (!existsSync(cwd)) throw Object.assign(new Error(`spawn ${command} ENOENT (cwd ${cwd})`), { code: "ENOENT" });
      if (isAbsolute(command)) {
        expect(existsSync(command)).toBe(true);
        if (options.failStart) throw new Error(options.failStart);
        return;
      }
      if (!options.present.includes(command)) throw Object.assign(new Error(`${command} not found on PATH`), { code: "ENOENT" });
    };
    return { run, calls };
  }

  const gpuManager = (pkg: BinaryPackage, run: ReturnType<typeof fakeMachine>["run"], dataDir = tempDir()) =>
    new BinaryManager({ dataDir, configDir: tempDir(), packages: [pkg], commandRunner: run });

  it("installs the GPU candidate when its probes pass, beside the CPU build, after checking it starts", async () => {
    const machine = fakeMachine({ present: ["nvidia-smi", "nvcc"] });
    // First run on the machine: the data dir does not exist yet.
    const binaries = gpuManager(gpuThenCpu(), machine.run, join(tempDir(), "fresh"));

    expect((await binaries.locate("alpha")).pinned).toMatchObject({ accelerator: "cuda" });
    const alpha = await binaries.ensure("alpha");
    expect(readFileSync(alpha, "utf8")).toBe("cuda-alpha");
    expect(alpha).toContain(join("binaries", "tools", "1.2.3", `${currentPlatform()}-cuda`));
    expect(JSON.parse(readFileSync(join(alpha, "..", "install.json"), "utf8"))).toMatchObject({ accelerator: "cuda" });
    // Start check of each installed tool, with the package's version arguments.
    expect(machine.calls.filter(([command]) => isAbsolute(command!)).map((call) => call.slice(1))).toEqual([["--version"], ["--version"]]);
    // Probes run once per manager, not per lookup.
    expect(machine.calls.filter(([command]) => command === "nvidia-smi")).toHaveLength(1);
  });

  it("takes the CPU build without downloading the GPU one when a probe fails, and never start-checks it", async () => {
    const machine = fakeMachine({ present: ["nvidia-smi"] });
    const binaries = gpuManager(gpuThenCpu(), machine.run);

    expect((await binaries.locate("alpha")).pinned?.accelerator).toBeUndefined();
    const alpha = await binaries.ensure("alpha");
    expect(readFileSync(alpha, "utf8")).toBe("alpha-bin");
    expect(alpha).toContain(join("binaries", "tools", "1.2.3", currentPlatform()));
    expect([...hits.keys()].some((url) => url.endsWith("/gpu.tar.gz"))).toBe(false);
    expect(machine.calls.some(([command]) => isAbsolute(command!))).toBe(false);
  });

  it("falls back to the CPU build when the GPU executable does not start, and skips it afterwards until the marker is deleted", async () => {
    const machine = fakeMachine({ present: ["nvidia-smi", "nvcc"], failStart: "libcudart.so.12: cannot open shared object file" });
    const dataDir = tempDir();
    const progress: string[] = [];
    const alpha = await gpuManager(gpuThenCpu(), machine.run, dataDir).ensure("alpha", undefined, { onProgress: (p) => progress.push(p.message) });

    expect(readFileSync(alpha, "utf8")).toBe("alpha-bin");
    const marker = join(dataDir, "binaries", "tools", "1.2.3", `${currentPlatform()}-cuda.failed.json`);
    expect(JSON.parse(readFileSync(marker, "utf8")).error).toMatch(/libcudart\.so\.12/);
    expect(progress).toContainEqual(expect.stringMatching(/cuda build does not start here, using the next build .*failed\.json/));
    // Nothing of the failed build is left in its install dir.
    expect(existsSync(join(dataDir, "binaries", "tools", "1.2.3", `${currentPlatform()}-cuda`))).toBe(false);

    // A new daemon neither probes nor installs the failed candidate again.
    const again = fakeMachine({ present: ["nvidia-smi", "nvcc"] });
    expect((await gpuManager(gpuThenCpu(), again.run, dataDir).locate("alpha")).pinned?.accelerator).toBeUndefined();
    expect(again.calls).toEqual([]);

    rmSync(marker);
    expect((await gpuManager(gpuThenCpu(), again.run, dataDir).locate("alpha")).pinned?.accelerator).toBe("cuda");
  });

  it("never falls back on a checksum mismatch of the GPU build", async () => {
    const machine = fakeMachine({ present: ["nvidia-smi", "nvcc"] });
    const binaries = gpuManager(gpuThenCpu({ gpuSha256: "0".repeat(64) }), machine.run);
    await expect(binaries.ensure("alpha")).rejects.toMatchObject({ code: ErrorCode.BinaryChecksumMismatch });
    expect(tree(binaries.dataDir)).toEqual([]);
  });

  it("does not start-check the CPU fallback: it has no probes to be wrong about", async () => {
    const machine = fakeMachine({ present: [], failStart: "would fail" });
    const alpha = await gpuManager(gpuThenCpu(), machine.run).ensure("alpha");
    expect(readFileSync(alpha, "utf8")).toBe("alpha-bin");
  });
});

describe("BinaryManager models", () => {
  const modelBytes = Buffer.from("ggml-model-bytes".repeat(1000));

  function model(bytes: Buffer, digest = sha256(bytes)) {
    const path = `/${Math.random().toString(36).slice(2)}/model.bin`;
    files.set(path, bytes);
    return {
      id: "ggml-test",
      version: "abc123",
      origin: "https://example.test",
      license: "MIT",
      urls: [`${base}${path}`],
      sha256: digest,
      size: bytes.length,
      file: "ggml-test.bin",
    };
  }

  const modelManager = (m: ReturnType<typeof model>) =>
    new BinaryManager({ dataDir: tempDir(), configDir: tempDir(), packages: [], models: [m] });

  it("downloads a pinned model once, verified, and reports download progress", async () => {
    const binaries = modelManager(model(modelBytes));
    expect(await binaries.locateModel("ggml-test")).toMatchObject({ installed: false });
    const progress: { message: string; fraction?: number }[] = [];
    const path = await binaries.ensureModel("ggml-test", { onProgress: (p) => progress.push(p) });

    expect(readFileSync(path).equals(modelBytes)).toBe(true);
    expect(path).toContain(join("models", "ggml-test", "abc123"));
    expect(progress.at(-1)).toMatchObject({ message: expect.stringContaining("ggml-test"), fraction: 1 });
    hits.clear();
    expect(await binaries.ensureModel("ggml-test")).toBe(path);
    expect(hits.size).toBe(0);
  });

  it("rejects a model whose checksum does not match and keeps nothing", async () => {
    const binaries = modelManager(model(modelBytes, "0".repeat(64)));
    await expect(binaries.ensureModel("ggml-test")).rejects.toMatchObject({ code: ErrorCode.BinaryChecksumMismatch });
    expect(tree(binaries.dataDir)).toEqual([]);
  });

  it("names the known models when asked for an unknown one", async () => {
    await expect(modelManager(model(modelBytes)).ensureModel("ggml-nope")).rejects.toThrow(/ggml-nope.*ggml-test/);
  });
});
