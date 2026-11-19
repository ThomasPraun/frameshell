import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { isAbsolute, join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ErrorCode } from "@frameshell/protocol";
import { type BinaryPackage, BinaryManager, DEFAULT_MODELS, DEFAULT_PACKAGES, type PinnedBuild, type StandardPath, buildCandidates, currentPlatform } from "../src/index.js";
import { tarGz, zip } from "./archives.js";
import { tempDir } from "./helpers.js";

// Local fixture server: real HTTP, real hashing, real `tar`; no network.
const files = new Map<string, Buffer>();
const hits = new Map<string, number>();
/** Requests held at the server until released, to keep an install in flight. */
const holds = new Map<string, { reached: () => void; released: Promise<void> }>();
/** Hold the next request for `path`: `reached` resolves when it arrives, `release` lets it answer. */
function holdRequest(path: string) {
  let reachedNow!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => (reachedNow = resolve));
  holds.set(path, { reached: reachedNow, released: new Promise<void>((resolve) => (release = resolve)) });
  return { reached, release };
}
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
    const hold = holds.get(req.url ?? "");
    holds.delete(req.url ?? "");
    // Slow first byte so concurrent installs overlap.
    const answer = () => res.writeHead(200, { "content-length": body.length }).end(body);
    if (hold) {
      hold.reached();
      void hold.released.then(answer);
    } else {
      setTimeout(answer, 50);
    }
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

describe("BinaryManager user install (Blender, ADR 0035)", () => {
  function blenderManager(config?: unknown) {
    const dirs = { dataDir: tempDir(), configDir: tempDir() };
    if (config) writeFileSync(join(dirs.configDir, "config.json"), JSON.stringify(config));
    return { dirs, binaries: new BinaryManager({ ...dirs, standardPaths: false }) };
  }

  it("takes the executable from a project or global `binaries.blender` override, without downloading", async () => {
    const system = tempDir();
    const blender = join(system, `blender${exe}`);
    writeFileSync(blender, "stub");
    const global = blenderManager({ binaries: { blender } });
    expect(await global.binaries.locate("blender")).toMatchObject({ source: "global", path: blender, installed: true, pinned: null });
    expect(await global.binaries.ensure("blender")).toBe(blender);
    const project = { dir: system, binaries: { blender: `blender${exe}` } };
    expect(await blenderManager().binaries.ensure("blender", project)).toBe(blender);
  });

  it("without an override says where Blender comes from and how to name it, never that a build is missing", async () => {
    const { dirs, binaries } = blenderManager();
    expect(await binaries.locate("blender")).toMatchObject({ source: "managed", path: null, installed: false, pinned: null });
    const error = await binaries.ensure("blender").catch((e: unknown) => e);
    expect(error).toMatchObject({ code: ErrorCode.BinaryUnavailable, data: { binary: "blender" } });
    const message = (error as Error).message;
    expect(message).toMatch(/your own Blender \(4\.5 LTS and 5\.x; https:\/\/www\.blender\.org\/download\/\) and never downloads it/);
    expect(message).toContain('"binaries": { "blender": ');
    expect(message).toContain(join(dirs.configDir, "config.json"));
    expect(message).not.toMatch(/managed blender build/);
  });

  it("names an override that points at nothing, as for any tool", async () => {
    const missing = join(tempDir(), `blender${exe}`);
    await expect(blenderManager({ binaries: { blender: missing } }).binaries.ensure("blender")).rejects.toMatchObject({
      code: ErrorCode.BinaryNotFound,
      data: { binary: "blender", path: missing },
    });
  });

  it("still throws for a tool no package ships, override or not", async () => {
    const { binaries } = blenderManager({ binaries: { godot: "/opt/godot" } });
    await expect(binaries.locate("godot")).rejects.toThrow(/Unknown binary: godot/);
  });
});

describe("BinaryManager user install at a standard path", () => {
  /** Fake Windows install root: `<ProgramFiles>/Blender Foundation/<folder>/blender.exe` for each folder. */
  function programFiles(folders: Record<string, boolean>) {
    const root = tempDir();
    for (const [folder, withExe] of Object.entries(folders)) {
      const dir = join(root, "Blender Foundation", folder);
      mkdirSync(dir, { recursive: true });
      if (withExe) writeFileSync(join(dir, "blender.exe"), "stub");
    }
    return root;
  }
  const windows = (env: NodeJS.ProcessEnv, config?: unknown) => {
    const dirs = { dataDir: tempDir(), configDir: tempDir() };
    if (config) writeFileSync(join(dirs.configDir, "config.json"), JSON.stringify(config));
    return new BinaryManager({ ...dirs, platform: "win32-x64", env });
  };

  it("takes the newest Blender of the supported range from the Windows installer's folders, without running it", async () => {
    const root = programFiles({ "Blender 4.2": true, "Blender 4.5": true, "Blender 5.1": true, "Blender 5.10": false, "Blender 6.0": true, "Blender Launcher": true });
    const binaries = windows({ ProgramFiles: root, PATH: tempDir() });
    const path = join(root, "Blender Foundation", "Blender 5.1", "blender.exe");
    expect(await binaries.locate("blender")).toEqual({ name: "blender", package: "blender", source: "system", found: "standard", path, installed: true, pinned: null });
    expect(await binaries.ensure("blender")).toBe(path);
  });

  it("takes a Blender outside the range when it is the only one, so doctor can say so", async () => {
    const root = programFiles({ "Blender 4.2": true });
    expect(await windows({ ProgramFiles: root }).locate("blender")).toMatchObject({ source: "system", path: join(root, "Blender Foundation", "Blender 4.2", "blender.exe") });
  });

  it("prefers Blender on PATH to an install folder outside the range, which is only a fallback", async () => {
    const root = programFiles({ "Blender 3.6": true });
    const onPath = tempDir();
    writeFileSync(join(onPath, "blender.exe"), "stub");
    expect(await windows({ ProgramFiles: root, PATH: onPath }).locate("blender")).toMatchObject({ source: "system", found: "path", path: join(onPath, "blender.exe") });
    // A folder of the range still wins over PATH: its rule comes first and the version is known.
    const supported = programFiles({ "Blender 3.6": true, "Blender 4.5": true });
    expect(await windows({ ProgramFiles: supported, PATH: onPath }).locate("blender")).toMatchObject({
      found: "standard",
      path: join(supported, "Blender Foundation", "Blender 4.5", "blender.exe"),
    });
    // Nothing on PATH: the folder outside the range is returned, so doctor says "out of range" and not "missing".
    expect(await windows({ ProgramFiles: root, PATH: tempDir() }).locate("blender")).toMatchObject({
      found: "standard",
      path: join(root, "Blender Foundation", "Blender 3.6", "blender.exe"),
    });
  });

  it("lets a `binaries.blender` override win over an install it would find", async () => {
    const root = programFiles({ "Blender 5.0": true });
    const own = join(tempDir(), "blender.exe");
    writeFileSync(own, "stub");
    const located = await windows({ ProgramFiles: root }, { binaries: { blender: own } }).locate("blender");
    expect(located).toMatchObject({ source: "global", path: own, installed: true });
    expect(located.found).toBeUndefined();
  });

  it("looks on PATH after the install folders, and says where it looked when Blender is nowhere", async () => {
    const onPath = tempDir();
    writeFileSync(join(onPath, "blender.exe"), "stub");
    expect(await windows({ ProgramFiles: tempDir(), PATH: `${tempDir()};${onPath}` }).locate("blender")).toMatchObject({
      source: "system",
      found: "path",
      path: join(onPath, "blender.exe"),
    });
    // No ProgramFiles in the environment: that rule is skipped, not an error.
    const binaries = windows({ PATH: tempDir() });
    expect(await binaries.locate("blender")).toMatchObject({ source: "managed", path: null, installed: false });
    const error = await binaries.ensure("blender").catch((e: unknown) => e);
    expect(error).toMatchObject({ code: ErrorCode.BinaryUnavailable });
    expect((error as Error).message).toMatch(/was not told where it is \(looked in \$\{ProgramFiles\}\\Blender Foundation, for blender on PATH\)\. Frameshell uses your own Blender/);
  });

  it("follows the order of a package's rules: a fixed path before PATH, `${VAR}` from the environment", async () => {
    const rules: StandardPath[] = [
      { kind: "file", path: "${APPS}/Tool.app/tool" },
      { kind: "path", name: "tool" },
    ];
    const tool: BinaryPackage = {
      name: "tool",
      tools: ["tool"],
      builds: {},
      onDemand: true,
      userInstall: {
        label: "Tool",
        supported: "any",
        download: "https://example.test",
        examplePath: { darwin: "/x", linux: "/x", win32: "C:\\x" },
        standardPaths: { darwin: rules, linux: rules, win32: rules },
        supports: () => true,
      },
    };
    const apps = tempDir();
    const onPath = tempDir();
    const pathTool = join(onPath, `tool${exe}`);
    writeFileSync(pathTool, "stub", { mode: 0o755 });
    const env = { APPS: apps, PATH: onPath };
    const binaries = new BinaryManager({ dataDir: tempDir(), configDir: tempDir(), packages: [tool], env });
    expect(await binaries.locate("tool")).toMatchObject({ source: "system", found: "path", path: pathTool });
    mkdirSync(join(apps, "Tool.app"));
    writeFileSync(join(apps, "Tool.app", "tool"), "stub");
    expect(await binaries.locate("tool")).toMatchObject({ source: "system", found: "standard", path: join(apps, "Tool.app", "tool") });
    // Off for tests that must not see the machine's own installs.
    const off = new BinaryManager({ dataDir: tempDir(), configDir: tempDir(), packages: [tool], env, standardPaths: false });
    expect(await off.locate("tool")).toMatchObject({ source: "managed", installed: false });
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
    const progress: { message: string; fraction?: number; stage?: string; values?: Record<string, string | number> }[] = [];
    const path = await binaries.ensureModel("ggml-test", { onProgress: (p) => progress.push(p) });

    expect(readFileSync(path).equals(modelBytes)).toBe(true);
    expect(path).toContain(join("models", "ggml-test", "abc123"));
    expect(progress.at(-1)).toMatchObject({
      message: expect.stringContaining("ggml-test"),
      fraction: 1,
      stage: "model-download",
      values: { model: "ggml-test", size: expect.any(Number) },
    });
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

describe("BinaryManager removal", () => {
  const modelBytes = Buffer.from("ggml-model-bytes".repeat(1000));

  it("lists what is on disk with bytes, deletes every version, and downloads again on next use", async () => {
    const pkg = pinned(goodArchive());
    const binaries = manager(pkg);
    expect(await binaries.downloads()).toEqual([]);

    await binaries.ensure("alpha");
    // An older pin and a failed-candidate marker, as an upgrade and a GPU build that did not start leave them.
    const old = join(binaries.dataDir, "binaries", "tools", "0.9.0", currentPlatform());
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "alpha"), "old".repeat(100));
    writeFileSync(join(binaries.dataDir, "binaries", "tools", "1.2.3", `${currentPlatform()}-cuda.failed.json`), "{}");

    const [listed] = await binaries.downloads();
    expect(listed).toMatchObject({ name: "tools", kind: "package", tools: ["alpha", "beta"], versions: ["0.9.0", "1.2.3"] });
    expect(listed!.bytes).toBeGreaterThan(300);

    const removed = await binaries.remove("tools");
    expect(removed).toEqual({ name: "tools", kind: "package", removed: true, versions: ["0.9.0", "1.2.3"], bytes: listed!.bytes });
    expect(existsSync(join(binaries.dataDir, "binaries", "tools"))).toBe(false);
    expect(await binaries.downloads()).toEqual([]);
    expect(await binaries.locate("alpha")).toMatchObject({ installed: false });

    hits.clear();
    expect(readFileSync(await binaries.ensure("alpha"), "utf8")).toBe("alpha-bin");
    expect(hits.size).toBe(1);
  });

  it("removes a pinned model file and downloads it again on next use", async () => {
    const path = `/${Math.random().toString(36).slice(2)}/model.bin`;
    files.set(path, modelBytes);
    const pin = { id: "ggml-test", version: "abc123", origin: "https://example.test", license: "MIT", urls: [`${base}${path}`], sha256: sha256(modelBytes), size: modelBytes.length, file: "ggml-test.bin" };
    const binaries = new BinaryManager({ dataDir: tempDir(), configDir: tempDir(), packages: [], models: [pin] });
    await binaries.ensureModel("ggml-test");

    expect(await binaries.downloads()).toEqual([{ name: "ggml-test", kind: "model", tools: [], versions: ["abc123"], bytes: modelBytes.length }]);
    expect(await binaries.remove("ggml-test")).toMatchObject({ kind: "model", removed: true, bytes: modelBytes.length });
    expect((await binaries.locateModel("ggml-test")).installed).toBe(false);
    expect(readFileSync(await binaries.ensureModel("ggml-test")).equals(modelBytes)).toBe(true);
  });

  it("never touches a binaries override, and removing what is not on disk is a no-op", async () => {
    const dir = tempDir();
    const alpha = join(dir, `alpha${exe}`);
    writeFileSync(alpha, "mine");
    const binaries = manager(pinned(goodArchive()));
    const project = { dir, binaries: { alpha } };
    await binaries.ensure("beta");
    expect(await binaries.remove("tools")).toMatchObject({ removed: true });
    expect(await binaries.locate("alpha", project)).toMatchObject({ source: "project", installed: true, path: alpha });
    expect(readFileSync(alpha, "utf8")).toBe("mine");
    expect(await binaries.remove("tools")).toEqual({ name: "tools", kind: "package", removed: false, versions: [], bytes: 0 });
  });

  it("refuses an unknown name and names what can be removed", async () => {
    await expect(manager(pinned(goodArchive())).remove("nope")).rejects.toMatchObject({ code: ErrorCode.InvalidParams, message: expect.stringContaining("tools") });
  });

  it("refuses while the package is installing, then removes it once installed", async () => {
    const pkg = pinned(goodArchive());
    const hold = holdRequest([...files.keys()].at(-1)!);
    const binaries = manager(pkg);
    const installing = binaries.ensure("alpha");
    await hold.reached;
    await expect(binaries.remove("tools")).rejects.toMatchObject({ code: ErrorCode.BinaryInUse, data: { name: "tools", reason: "installing" } });
    hold.release();
    await installing;
    expect(await binaries.remove("tools")).toMatchObject({ removed: true });
  });

  it("refuses a model only while that exact model installs, not one whose id starts with the same text", async () => {
    const path = `/${Math.random().toString(36).slice(2)}/model.bin`;
    files.set(path, modelBytes);
    const pin = (id: string) => ({ id, version: "abc123", origin: "https://example.test", license: "MIT", urls: [`${base}${path}`], sha256: sha256(modelBytes), size: modelBytes.length, file: `${id}.bin` });
    const binaries = new BinaryManager({ dataDir: tempDir(), configDir: tempDir(), packages: [], models: [pin("ggml-test"), pin("ggml-test-q5")] });
    await binaries.ensureModel("ggml-test");
    const hold = holdRequest(path);
    const installing = binaries.ensureModel("ggml-test-q5");
    await hold.reached;
    expect(await binaries.remove("ggml-test")).toMatchObject({ removed: true });
    await expect(binaries.remove("ggml-test-q5")).rejects.toMatchObject({ code: ErrorCode.BinaryInUse, data: { reason: "installing" } });
    hold.release();
    await installing;
  });

  it("keeps package names and model ids apart, since one name picks the download", () => {
    const names = DEFAULT_PACKAGES.map((pkg) => pkg.name);
    expect(new Set(names).size).toBe(names.length);
    expect(DEFAULT_MODELS.filter((model) => names.includes(model.id))).toEqual([]);
  });
});
