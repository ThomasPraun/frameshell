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
});

describe("BinaryManager source builds", () => {
  const sourceArchive = () => tarGz({ "src-1.2.3/CMakeLists.txt": { content: "project(alpha)" } });

  /** Package building `alpha` and `beta` from a served source archive. */
  function fromSource(archive: Buffer): BinaryPackage {
    const path = `/${Math.random().toString(36).slice(2)}/src.tar.gz`;
    files.set(path, archive);
    return {
      name: "tools",
      tools: ["alpha", "beta"],
      builds: {
        [currentPlatform()]: {
          version: "1.2.3",
          origin: "https://example.test",
          license: "MIT",
          archives: [{ urls: [`${base}${path}`], sha256: sha256(archive), size: archive.length, files: {} }],
          build: {
            root: "src-1.2.3",
            configure: ["-DFAST=ON"],
            targets: ["alpha", "beta"],
            files: { alpha: `bin/alpha${exe}`, beta: `bin/beta${exe}` },
            toolchainHint: "Install CMake",
          },
        },
      },
    };
  }

  /** Fake CMake: records calls; `--build` writes the executables into the build dir. */
  function fakeCmake(fail?: { on: "version" | "configure" | "build"; error: Error }) {
    const calls: string[][] = [];
    const run = async (command: string, args: readonly string[]) => {
      calls.push([command, ...args]);
      const step = args[0] === "--version" ? "version" : args[0] === "--build" ? "build" : "configure";
      if (fail?.on === step) throw fail.error;
      if (step === "configure") {
        expect(readFileSync(join(args[args.indexOf("-S") + 1]!, "CMakeLists.txt"), "utf8")).toBe("project(alpha)");
      }
      if (step === "build") {
        const dir = args[1]!;
        mkdirSync(join(dir, "bin"), { recursive: true });
        for (const tool of ["alpha", "beta"]) writeFileSync(join(dir, "bin", `${tool}${exe}`), `built-${tool}`);
      }
    };
    return { run, calls };
  }

  const sourceManager = (pkg: BinaryPackage, run: ReturnType<typeof fakeCmake>["run"]) =>
    new BinaryManager({ dataDir: tempDir(), configDir: tempDir(), packages: [pkg], buildRunner: run });

  it("downloads the pinned source, configures and builds with CMake, and installs the built tools", async () => {
    const cmake = fakeCmake();
    const binaries = sourceManager(fromSource(sourceArchive()), cmake.run);
    const progress: string[] = [];
    const alpha = await binaries.ensure("alpha", undefined, { onProgress: (p) => progress.push(p.message) });

    expect(readFileSync(alpha, "utf8")).toBe("built-alpha");
    expect(readFileSync((await binaries.locate("beta")).path!, "utf8")).toBe("built-beta");
    expect(alpha).toContain(join("binaries", "tools", "1.2.3", currentPlatform()));
    const [version, configure, build] = cmake.calls;
    expect(version).toEqual(["cmake", "--version"]);
    expect(configure).toEqual(expect.arrayContaining(["cmake", "-S", "-B", "-DCMAKE_BUILD_TYPE=Release", "-DFAST=ON"]));
    expect(build).toEqual(expect.arrayContaining(["cmake", "--build", "--config", "Release", "--target", "alpha", "beta"]));
    expect(progress).toEqual(expect.arrayContaining([expect.stringMatching(/^Building tools 1\.2\.3/)]));
    // Only the built tools and install.json are kept: no sources, no build tree.
    expect(tree(join(alpha, ".."))).toEqual([`alpha${exe}`, `beta${exe}`, "install.json"].sort());
  });

  it("fails before downloading when CMake is missing, naming the toolchain to install", async () => {
    const missing = Object.assign(new Error("spawn cmake ENOENT"), { code: "ENOENT" });
    const cmake = fakeCmake({ on: "version", error: missing });
    await expect(sourceManager(fromSource(sourceArchive()), cmake.run).ensure("alpha")).rejects.toMatchObject({
      code: ErrorCode.BinaryInstallFailed,
      message: expect.stringMatching(/Install CMake.*binaries/s),
    });
    expect(hits.size).toBe(0);
  });

  it("reports a failed build with the compiler output and installs nothing", async () => {
    const cmake = fakeCmake({ on: "build", error: new Error("error: metal.h not found") });
    const binaries = sourceManager(fromSource(sourceArchive()), cmake.run);
    await expect(binaries.ensure("alpha")).rejects.toMatchObject({
      code: ErrorCode.BinaryInstallFailed,
      message: expect.stringMatching(/metal\.h not found.*Install CMake/s),
    });
    expect(tree(binaries.dataDir)).toEqual([]);
  });
});

describe("BinaryManager GPU candidates", () => {
  const sourceArchive = () => tarGz({ "src-1.2.3/CMakeLists.txt": { content: "project(alpha)" } });

  /** CUDA source build requiring `nvidia-smi` and `nvcc`, then the CPU download as fallback. */
  function gpuThenCpu(options: { gpuSha256?: string } = {}): BinaryPackage {
    const source = sourceArchive();
    const path = `/${Math.random().toString(36).slice(2)}/src.tar.gz`;
    files.set(path, source);
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
      archives: [{ urls: [`${base}${path}`], sha256: options.gpuSha256 ?? sha256(source), size: source.length, files: {} }],
      build: {
        root: "src-1.2.3",
        configure: ["-DGGML_CUDA=ON"],
        targets: ["alpha", "beta"],
        files: { alpha: `bin/alpha${exe}`, beta: `bin/beta${exe}` },
        toolchainHint: "Install the CUDA toolkit",
      },
    };
    return { name: "tools", tools: ["alpha", "beta"], versionProbe: { args: ["--version"], pattern: /(\S+)/ }, builds: { [currentPlatform()]: [gpu, cpu] } };
  }

  /**
   * Fake machine: `present` commands pass their probe; cmake builds (or fails
   * with `failBuild`); a built executable run by absolute path starts unless
   * `failStart`.
   */
  function fakeMachine(options: { present: string[]; failBuild?: string; failStart?: string }) {
    const calls: string[][] = [];
    const run = async (command: string, args: readonly string[], { cwd }: { cwd: string }) => {
      calls.push([command, ...args]);
      // Like spawn: a missing working directory fails the command.
      if (!existsSync(cwd)) throw Object.assign(new Error(`spawn ${command} ENOENT (cwd ${cwd})`), { code: "ENOENT" });
      if (isAbsolute(command)) {
        if (options.failStart) throw new Error(options.failStart);
        return;
      }
      if (command !== "cmake") {
        if (!options.present.includes(command)) throw Object.assign(new Error(`${command} not found on PATH`), { code: "ENOENT" });
        return;
      }
      if (args[0] !== "--build") return;
      if (options.failBuild) throw new Error(options.failBuild);
      mkdirSync(join(args[1]!, "bin"), { recursive: true });
      for (const tool of ["alpha", "beta"]) writeFileSync(join(args[1]!, "bin", `${tool}${exe}`), `cuda-${tool}`);
    };
    return { run, calls };
  }

  const gpuManager = (pkg: BinaryPackage, run: ReturnType<typeof fakeMachine>["run"], dataDir = tempDir()) =>
    new BinaryManager({ dataDir, configDir: tempDir(), packages: [pkg], buildRunner: run });

  it("builds the GPU candidate when its probes pass, installs it beside the CPU build and checks it starts", async () => {
    const machine = fakeMachine({ present: ["nvidia-smi", "nvcc"] });
    // First run on the machine: the data dir does not exist yet.
    const binaries = gpuManager(gpuThenCpu(), machine.run, join(tempDir(), "fresh"));

    expect((await binaries.locate("alpha")).pinned).toMatchObject({ accelerator: "cuda" });
    const alpha = await binaries.ensure("alpha");
    expect(readFileSync(alpha, "utf8")).toBe("cuda-alpha");
    expect(alpha).toContain(join("binaries", "tools", "1.2.3", `${currentPlatform()}-cuda`));
    expect(JSON.parse(readFileSync(join(alpha, "..", "install.json"), "utf8"))).toMatchObject({ accelerator: "cuda", builtFromSource: true });
    expect(machine.calls).toContainEqual(expect.arrayContaining(["cmake", "-DGGML_CUDA=ON"]));
    // Start check of each built tool, with the package's version arguments.
    expect(machine.calls.filter(([command]) => isAbsolute(command!)).map((call) => call.slice(1))).toEqual([["--version"], ["--version"]]);
    // Probes run once per manager, not per lookup.
    expect(machine.calls.filter(([command]) => command === "nvidia-smi")).toHaveLength(1);
  });

  it("takes the CPU build without building anything when a probe fails", async () => {
    const machine = fakeMachine({ present: ["nvidia-smi"] });
    const binaries = gpuManager(gpuThenCpu(), machine.run);

    expect((await binaries.locate("alpha")).pinned?.accelerator).toBeUndefined();
    const alpha = await binaries.ensure("alpha");
    expect(readFileSync(alpha, "utf8")).toBe("alpha-bin");
    expect(alpha).toContain(join("binaries", "tools", "1.2.3", currentPlatform()));
    expect(machine.calls.some(([command]) => command === "cmake")).toBe(false);
  });

  it.each([
    ["the build fails", { failBuild: "nvcc fatal: unsupported gpu architecture" }, /unsupported gpu architecture/],
    ["the built executable does not start", { failStart: "libcudart.so.12: cannot open shared object file" }, /libcudart\.so\.12/],
  ])("falls back to the CPU build when %s, and skips the GPU build afterwards until the marker is deleted", async (_, failure, reason) => {
    const machine = fakeMachine({ present: ["nvidia-smi", "nvcc"], ...failure });
    const dataDir = tempDir();
    const progress: string[] = [];
    const alpha = await gpuManager(gpuThenCpu(), machine.run, dataDir).ensure("alpha", undefined, { onProgress: (p) => progress.push(p.message) });

    expect(readFileSync(alpha, "utf8")).toBe("alpha-bin");
    const marker = join(dataDir, "binaries", "tools", "1.2.3", `${currentPlatform()}-cuda.failed.json`);
    expect(JSON.parse(readFileSync(marker, "utf8")).error).toMatch(reason);
    expect(progress).toContainEqual(expect.stringMatching(/cuda build failed, using the next build .*failed\.json/));
    // Nothing of the failed build is left in its install dir.
    expect(existsSync(join(dataDir, "binaries", "tools", "1.2.3", `${currentPlatform()}-cuda`))).toBe(false);

    // A new daemon neither probes nor builds the failed candidate again.
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
