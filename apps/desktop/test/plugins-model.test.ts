import { OFFICIAL_PLUGINS } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";
import type { MachineDownloads, PluginsView } from "../src/shared/api.js";
import { plugins as strings } from "../src/shared/i18n/plugins.js";
import { transcriptionInstallCommand } from "../src/renderer/src/plugins/install-command.js";
import { type CatalogPlugin, downloadRows, otherPlugins, pluginRows, pluginState, trustPrompt } from "../src/renderer/src/plugins/model.js";

type Catalog = PluginsView["catalog"];

function entry(name: string, overrides: Partial<CatalogPlugin> = {}): CatalogPlugin {
  return {
    name,
    kind: "clip-adapter",
    provides: [],
    purpose: "",
    need: { kind: "none", text: "", met: true },
    paid: false,
    cloud: false,
    downloads: [],
    downloadBytes: 0,
    installed: false,
    pin: null,
    status: null,
    version: null,
    error: null,
    ...overrides,
  };
}

function catalog(plugins: CatalogPlugin[], trust: Catalog["trust"] = "not-required"): Catalog {
  return { dir: "/p", platform: "linux-x64", trust, plugins };
}

const binary = (name: string, pkg: string, overrides: Partial<MachineDownloads["binaries"][number]> = {}): MachineDownloads["binaries"][number] => ({
  name,
  package: pkg,
  source: "managed",
  path: `/data/binaries/${pkg}/${name}`,
  installed: false,
  version: null,
  pinned: { version: "1", origin: "", license: "MIT", accelerator: null },
  ...overrides,
});

describe("pluginState", () => {
  it("maps the catalog's install and load fields to one state", () => {
    expect(pluginState({ installed: false, status: null })).toBe("not-installed");
    expect(pluginState({ installed: true, status: "loaded" })).toBe("loaded");
    expect(pluginState({ installed: true, status: "error" })).toBe("error");
    expect(pluginState({ installed: true, status: "untrusted" })).toBe("untrusted");
  });
});

describe("pluginRows", () => {
  it("offers Install on a project without plugins and Remove once installed", () => {
    const [free, loaded] = pluginRows(catalog([entry("a"), entry("b", { installed: true, status: "loaded", version: "1.0.0", pin: "b@1.0.0" })]));
    expect(free).toMatchObject({ state: "not-installed", install: true, installBlocked: false, remove: false });
    expect(loaded).toMatchObject({ state: "loaded", install: false, remove: true, version: "1.0.0" });
  });

  it("blocks Install until the project's declared plugins are trusted", () => {
    for (const trust of ["unknown", "denied"] as const) {
      expect(pluginRows(catalog([entry("a")], trust))[0]).toMatchObject({ install: true, installBlocked: true });
    }
    expect(pluginRows(catalog([entry("a")], "trusted"))[0]).toMatchObject({ install: true, installBlocked: false });
  });

  it("says what using it costs: free, or paid cloud with audio or text leaving the machine", () => {
    const rows = pluginRows(
      catalog([
        entry("free"),
        entry("asr", { kind: "transcription-provider", paid: true, cloud: true }),
        entry("tts", { kind: "speech-provider", paid: true, cloud: true }),
      ]),
    );
    expect(rows.map((row) => row.cost)).toEqual(["free", "cloud-audio", "cloud-text"]);
  });

  it("names what the first use downloads, or that it is already on disk", () => {
    const tool = { kind: "binary" as const, id: "tool", what: "", bytes: 100, onDisk: false };
    const model = { kind: "model" as const, id: "model", what: "", bytes: 600, onDisk: true };
    const rows = pluginRows(
      catalog([
        entry("none"),
        entry("some", { downloads: [tool, model], downloadBytes: 100 }),
        entry("ready", { downloads: [{ ...tool, onDisk: true }, model] }),
        entry("unsized", { downloads: [{ ...tool, bytes: null }], downloadBytes: 0 }),
      ]),
    );
    expect(rows.map((row) => row.download)).toEqual([
      { state: "none" },
      { state: "first-use", bytes: 100, names: ["tool"] },
      { state: "ready", names: ["tool", "model"] },
      { state: "first-use", bytes: 0, names: ["tool"] },
    ]);
  });
});

describe("trustPrompt", () => {
  it("asks only when declared plugins were never decided, and reminds when they were refused", () => {
    expect(trustPrompt("unknown")).toBe("ask");
    expect(trustPrompt("denied")).toBe("denied");
    expect(trustPrompt("trusted")).toBeNull();
    expect(trustPrompt("not-required")).toBeNull();
  });
});

describe("otherPlugins", () => {
  it("lists declared plugins the official catalog does not have", () => {
    const declared = (name: string) => ({ name, pin: "x", status: "untrusted" as const, version: null, apiVersion: null, error: null, contributes: null });
    expect(otherPlugins({ catalog: catalog([entry("@frameshell/blender")]), declared: [declared("@frameshell/blender"), declared("@acme/titles")] }).map((p) => p.name)).toEqual(["@acme/titles"]);
  });
});

describe("downloadRows", () => {
  it("lists what is on disk first, then what is not downloaded yet, and totals the disk used", () => {
    const machine: MachineDownloads = {
      dataDir: "/data",
      downloads: [
        { name: "ggml-large-v3-turbo-q5_0", kind: "model", tools: [], versions: ["r1"], bytes: 574_000_000 },
        { name: "ffmpeg", kind: "package", tools: ["ffmpeg", "ffprobe"], versions: ["8.0"], bytes: 120_000_000 },
      ],
      binaries: [
        binary("ffmpeg", "ffmpeg", { installed: true }),
        binary("chrome-headless-shell", "chrome-headless-shell"),
        binary("whisper-server", "whisper-server"),
        binary("sherpa", "sherpa-onnx", { pinned: null, path: null }),
        binary("blender", "blender", { source: "system", installed: false, pinned: null }),
      ],
    };
    const chrome = { kind: "binary" as const, id: "chrome-headless-shell", what: "", bytes: 90_000_000, onDisk: false };
    const ffmpeg = { kind: "binary" as const, id: "ffmpeg", what: "", bytes: 40_000_000, onDisk: false };
    const { rows, totalBytes } = downloadRows(machine, catalog([entry("@frameshell/hyperframes", { downloads: [chrome, ffmpeg] })]));
    expect(rows).toEqual([
      { name: "ggml-large-v3-turbo-q5_0", kind: "model", bytes: 574_000_000, onDisk: true },
      { name: "ffmpeg", kind: "package", bytes: 120_000_000, onDisk: true },
      { name: "chrome-headless-shell", kind: "package", bytes: 90_000_000, onDisk: false },
      { name: "whisper-server", kind: "package", bytes: null, onDisk: false },
    ]);
    expect(totalBytes).toBe(694_000_000);
  });

  it("works before the catalog is read", () => {
    expect(downloadRows({ dataDir: "/data", downloads: [], binaries: [binary("ffmpeg", "ffmpeg")] }, null)).toEqual({
      rows: [{ name: "ffmpeg", kind: "package", bytes: null, onDisk: false }],
      totalBytes: 0,
    });
  });
});

describe("official plugin words", () => {
  it("has a title and purpose for every official plugin in both languages", () => {
    for (const plugin of OFFICIAL_PLUGINS) {
      for (const lang of ["en", "es"] as const) {
        expect(strings[lang].about[plugin.name]?.title, `${lang} ${plugin.name}`).toBeTruthy();
        expect(strings[lang].about[plugin.name]?.purpose, `${lang} ${plugin.name}`).toBeTruthy();
      }
    }
    expect(Object.keys(strings.en.about).sort()).toEqual(OFFICIAL_PLUGINS.map((plugin) => plugin.name).sort());
  });

  it("builds the transcription install command from the official table", () => {
    expect(transcriptionInstallCommand("whisper-cpp")).toBe("frameshell plugin install @frameshell/whisper-cpp");
    expect(transcriptionInstallCommand("nobody")).toBe("frameshell plugin catalog");
  });
});
