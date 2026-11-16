import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BLENDER_PACKAGE } from "@frameshell/core";
import type { ClipAdapter, PluginApi } from "@frameshell/plugin-api";
import { parsePluginManifest } from "@frameshell/schema";
import {
  BlendDeps,
  SUPPORTED_BLENDER,
  activate,
  describeRefusal,
  frameCount,
  frameRate,
  insideProject,
  listingPath,
  outsideProject,
  outsideWarning,
  parseBlenderVersion,
  propsSchema,
  scriptPath,
  sourceOf,
  supportedBlender,
} from "../src/index.js";

/** A checked-out text file with LF endings (Windows checkouts may turn them into CRLF). */
const readText = (path: string | URL): string => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

const here = (path: string) => new URL(path, import.meta.url);

describe("supported Blender versions", () => {
  it("are the 4.5 LTS and every 5.x, and the core manifest (doctor) agrees on every version", () => {
    expect(SUPPORTED_BLENDER).toBe(BLENDER_PACKAGE.userInstall!.supported);
    for (const version of ["3.6.0", "4.0.2", "4.2.9", "4.4.3", "4.5.0", "4.5.8", "5.0.0", "5.2.1", "6.0.0", "garbage"]) {
      expect(supportedBlender(version), version).toBe(BLENDER_PACKAGE.userInstall!.supports(version));
    }
    expect(["4.5.3", "5.0.1"].every(supportedBlender)).toBe(true);
    expect(["4.4.3", "6.0.0"].some(supportedBlender)).toBe(false);
  });

  it("reads the version as core's doctor probe does", () => {
    for (const output of ["Blender 4.5.3 LTS\n\tbuild date: x\n", "Blender 5.0.1\n", "noise\nBlender 5.2\n", "blender: command not found"]) {
      expect(parseBlenderVersion(output)).toBe(BLENDER_PACKAGE.versionProbe!.pattern.exec(output)?.[1] ?? null);
    }
    expect(parseBlenderVersion("Blender 4.5.3 LTS\n")).toBe("4.5.3");
  });
});

describe("props", () => {
  const validate = (props: unknown) => propsSchema["~standard"].validate(props) as { value?: unknown; issues?: { message: string }[] };

  it("accept scene and camera, or nothing", () => {
    for (const props of [{}, { scene: "Scene" }, { camera: "Camera.001" }, { scene: "A", camera: "B" }]) {
      expect(validate(props).issues, JSON.stringify(props)).toBeUndefined();
    }
  });

  it("refuse a quality prop: draft or final is the export's choice, and the message says how to pick it", () => {
    for (const quality of ["draft", "final"]) {
      expect(validate({ quality }).issues?.[0]?.message).toMatch(/unknown prop quality: .*draft render \(EEVEE\) and a final one \(Cycles\).*--quality draft.*Remove quality/);
    }
  });

  it("refuse frame ranges, scripts and the file (the .blend is the source), naming the fix", () => {
    const messages = (props: unknown) => (validate(props).issues ?? []).map((issue) => issue.message).join("\n");
    expect(messages({ file: "a.blend" })).toMatch(/the \.blend is the clip's `source`/);
    expect(messages({ frameStart: 1 })).toMatch(/unknown prop frameStart: props are scene and camera.*in and duration.*no scripts run/);
    expect(messages({ script: "import os" })).toMatch(/unknown prop script/);
    expect(messages({ scene: "", camera: 3 })).toMatch(/scene must be the name.*\n.*camera must be the name/);
    expect(messages([])).toMatch(/props must be an object/);
  });
});

describe("source and range", () => {
  const clip = (source?: string) => ({ id: "c1", ...(source === undefined ? {} : { source }), duration: 1 });

  it("sourceOf takes a /-separated .blend inside the project", () => {
    expect(sourceOf(clip("scenes/intro.blend"))).toBe("scenes/intro.blend");
    expect(sourceOf(clip("./scenes/../intro.BLEND"))).toBe("intro.BLEND");
    expect(() => sourceOf(clip())).toThrow(/needs `source`: the \.blend file/);
    expect(() => sourceOf(clip("scenes\\intro.blend"))).toThrow(/relative to the project/);
    expect(() => sourceOf(clip("/abs/intro.blend"))).toThrow(/relative to the project/);
    expect(() => sourceOf(clip("../intro.blend"))).toThrow(/outside the project/);
    expect(() => sourceOf(clip("scenes/intro.fbx"))).toThrow(/not a \.blend file/);
  });

  it("frameCount runs from the scene's first frame to the end of the clip's part, at the project fps", () => {
    expect(frameCount({ id: "c", duration: 4 }, 30)).toBe(120);
    expect(frameCount({ id: "c", in: 2, duration: 4 }, 30)).toBe(180);
    expect(frameCount({ id: "c", duration: 1 / 30 }, 30)).toBe(1);
    expect(frameCount({ id: "c", duration: 0.5 }, 25)).toBe(13);
  });

  it("frameCount does not add a frame to ends snapped to the frame grid, which are not whole milliseconds", () => {
    expect(frameCount({ id: "c", duration: 2 / 30 }, 30)).toBe(2);
    expect(frameCount({ id: "c", duration: 92 / 30 }, 30)).toBe(92);
    expect(frameCount({ id: "c", duration: 121 / 60 }, 60)).toBe(121);
    expect(frameCount({ id: "c", duration: 1 / 24 }, 24)).toBe(1);
    expect(frameCount({ id: "c", in: 7 / 30, duration: 5 / 30 }, 30)).toBe(12);
    expect(frameCount({ id: "c", duration: 5 / 30 + 0.01 }, 30)).toBe(6);
  });

  it("frameRate sends NTSC rates as exact fractions and the rest as they are", () => {
    expect(frameRate(30000 / 1001)).toBe("30000/1001");
    expect(frameRate(29.97)).toBe("30000/1001");
    expect(frameRate(24000 / 1001)).toBe("24000/1001");
    expect(frameRate(23.976)).toBe("24000/1001");
    expect(frameRate(30)).toBe("30");
    expect(frameRate(25)).toBe("25");
  });

  it("listingPath names the listing by content and path, so identical copies elsewhere do not share one", () => {
    const info = { hash: "0123456789abcdef" };
    const a = listingPath("scenes/a.blend", info);
    expect(a).toMatch(/^\.frameshell\/blender\/0123456789abcdef-[0-9a-f]{8}\/deps\.json$/);
    expect(listingPath("scenes/a.blend", info)).toBe(a);
    expect(listingPath("copy/a.blend", info)).not.toBe(a);
  });

  it("insideProject keeps what sits in the project, relative and sorted, minus the .blend and .frameshell", () => {
    const project = process.platform === "win32" ? "C:\\p" : "/p";
    const abs = (rel: string) => (process.platform === "win32" ? `C:\\p\\${rel.replaceAll("/", "\\")}` : `/p/${rel}`);
    const found = insideProject(project, [abs("tex/b.png"), abs("lib/a.blend"), "/elsewhere/x.png", abs("scenes/s.blend"), abs(".frameshell/blender/x.json"), abs("tex/b.png")], "scenes/s.blend");
    expect(found).toEqual(["lib/a.blend", "tex/b.png"]);
  });
});

describe("files outside the project", () => {
  it("outsideProject keeps what insideProject drops as outside, absolute, sorted and unique", () => {
    const project = process.platform === "win32" ? "C:\\p" : "/p";
    const outsideRoot = process.platform === "win32" ? "D:\\lib" : "/lib";
    const abs = (root: string, rel: string) => join(root, ...rel.split("/"));
    const listed = [abs(outsideRoot, "z.blend"), abs(project, "tex/b.png"), abs(outsideRoot, "a.png"), abs(outsideRoot, "z.blend"), abs(project, "../p-sibling/c.png")];
    expect(outsideProject(project, listed)).toEqual([abs(outsideRoot, "a.png"), abs(outsideRoot, "z.blend"), resolve(project, "..", "p-sibling", "c.png")].sort());
    expect(insideProject(project, listed, "scenes/s.blend")).toEqual(["tex/b.png"]);
  });

  it("enter the key by content only, beside the listing: an edit or a file appearing changes it, its path never shows", async () => {
    const project = mkdtempSync(join(tmpdir(), "frameshell-blender-outside-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "frameshell-blender-elsewhere-"));
    try {
      const lib = join(elsewhere, "lib.blend");
      const later = join(elsewhere, "later.png");
      writeFileSync(lib, "BLENDERone");
      const deps = new BlendDeps(project);
      const info = { hash: "0123456789abcdef" };
      expect(await deps.outsideKey("scenes/s.blend", info, [])).toBeNull();
      const key = await deps.outsideKey("scenes/s.blend", info, [later, lib]);
      expect(key).toBe(listingPath("scenes/s.blend", info).replace(/deps\.json$/, "outside.json"));
      const read = () => readFileSync(join(project, ...key!.split("/")), "utf8");
      const first = read();
      expect(JSON.parse(first)).toEqual({ outside: [{ missing: true }, { sha256: expect.stringMatching(/^[0-9a-f]{16}$/), bytes: 10 }] });
      expect(first).not.toContain(basename(elsewhere));
      writeFileSync(later, "png");
      await deps.outsideKey("scenes/s.blend", info, [later, lib]);
      const appeared = read();
      expect(appeared).not.toBe(first);
      writeFileSync(lib, "BLENDERtwo!");
      await deps.outsideKey("scenes/s.blend", info, [later, lib]);
      expect(read()).not.toBe(appeared);
    } finally {
      rmSync(project, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("the render warning names the clip, the .blend and the files, at most five of them", () => {
    expect(outsideWarning("c1", "scenes/a.blend", ["/lib/x.blend"])).toBe(
      "blender clip c1: scenes/a.blend loads a file from outside the project (/lib/x.blend); its content is in the render key, " +
        "but Frameshell does not watch it: copy it into the project and relink to re-render on every change.",
    );
    const many = Array.from({ length: 7 }, (_, i) => `/lib/${i}.png`);
    expect(outsideWarning("c1", "scenes/a.blend", many)).toMatch(/loads 7 files from outside the project \(\/lib\/0\.png, .*\/lib\/4\.png and 2 more\); their content/);
  });
});

describe("refusals of render.py", () => {
  it("say which scene frames a remapped clip needs, with both rates, and the same-rate message without them", () => {
    const range = (detail: Record<string, unknown>) => describeRefusal("c1", "s.blend", { event: "error", code: "range", scene: "Scene", frameStart: 1, frameEnd: 4, frames: 6, ...detail }, 30);
    expect(range({ lastFrame: 5, sceneFps: 24 })).toBe(
      'blender clip c1: it needs scene frames 1 to 5 (the scene runs at 24 fps, the project at 30) but scene "Scene" of s.blend ends at frame 4 (4 frames). Raise its End frame or shorten the clip.',
    );
    expect(range({ lastFrame: 6, sceneFps: 30 })).toMatch(/needs scene frames 1 to 6 but scene "Scene"/);
    expect(range({})).toMatch(/needs 6 frames from the scene's first frame \(1\) but/);
  });

  it("render.py samples another scene rate at the project's seconds, with no frame-rate refusal left", () => {
    const text = readText(scriptPath("render.py"));
    expect(text).toMatch(/scene\.frame_set\(whole, subframe=at - whole\)/);
    expect(text).not.toMatch(/refuse\("fps"/);
  });
});

describe("the plugin package", () => {
  it("registers the blender clip type and matches its manifest and package.json", () => {
    const parsed = parsePluginManifest(JSON.parse(readFileSync(here("../frameshell-plugin.json"), "utf8")));
    if (!parsed.ok) throw new Error("manifest invalid");
    const manifest = parsed.value;
    const pkg = JSON.parse(readFileSync(here("../package.json"), "utf8")) as { name: string; version: string; main: string; files: string[] };
    expect(manifest).toMatchObject({ name: pkg.name, version: pkg.version, main: pkg.main, apiVersion: "1" });
    expect(manifest.contributes.clipTypes).toEqual(["blender"]);
    expect(manifest.contributes.skills).toEqual(["skills/blender/SKILL.md"]);
    expect(pkg.files).toContain("python");
    expect(readText(here("../skills/blender/SKILL.md"))).toMatch(/^---\nname: blender\n/);
    const registered: ClipAdapter[] = [];
    activate({ project: { dir: "/p" }, registerClipType: (adapter: ClipAdapter) => registered.push(adapter) } as unknown as PluginApi);
    expect(registered.map((adapter) => adapter.type)).toEqual(["blender"]);
    expect(registered[0]!.propsSchema).toBe(propsSchema);
  });
});

describe("scripts that run inside Blender", () => {
  for (const name of ["render.py", "deps.py"] as const) {
    it(`${name} is Apache-2.0, as the licence note says, and parses`, () => {
      const text = readText(scriptPath(name));
      expect(text.split("\n").slice(0, 2)).toEqual(["# Copyright 2026 Frameshell contributors", "# SPDX-License-Identifier: Apache-2.0"]);
      // `bpy` exists only inside Blender: syntax is all a machine without it can check.
      try {
        execFileSync("python3", ["-I", "-c", "import ast, sys; ast.parse(open(sys.argv[1]).read())", scriptPath(name)], { stdio: "ignore" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    });
  }

  it("never accept code from a clip: the render script reads only its JSON request", () => {
    const text = readText(scriptPath("render.py"));
    expect(text).not.toMatch(/\b(exec|eval|compile|__import__|subprocess|socket)\b/);
    expect(text).not.toMatch(/bpy\.ops\.(wm|script)\./);
  });
});
