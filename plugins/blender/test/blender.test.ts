import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BLENDER_PACKAGE } from "@frameshell/core";
import type { ClipAdapter, PluginApi } from "@frameshell/plugin-api";
import { parsePluginManifest } from "@frameshell/schema";
import { SUPPORTED_BLENDER, activate, frameCount, insideProject, parseBlenderVersion, propsSchema, scriptPath, sourceOf, supportedBlender } from "../src/index.js";

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

  it("accept scene, camera and the draft quality, or nothing", () => {
    for (const props of [{}, { scene: "Scene" }, { camera: "Camera.001" }, { scene: "A", camera: "B", quality: "draft" }]) {
      expect(validate(props).issues, JSON.stringify(props)).toBeUndefined();
    }
  });

  it("refuse final quality in this version, with what to do", () => {
    expect(validate({ quality: "final" }).issues?.[0]?.message).toMatch(/"final" is not available in this version.*"draft"/);
    expect(validate({ quality: "medium" }).issues?.[0]?.message).toMatch(/must be "draft"/);
  });

  it("refuse frame ranges, scripts and the file (the .blend is the source), naming the fix", () => {
    const messages = (props: unknown) => (validate(props).issues ?? []).map((issue) => issue.message).join("\n");
    expect(messages({ file: "a.blend" })).toMatch(/the \.blend is the clip's `source`/);
    expect(messages({ frameStart: 1 })).toMatch(/unknown prop frameStart.*in and duration.*no scripts run/);
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

  it("insideProject keeps what sits in the project, relative and sorted, minus the .blend and .frameshell", () => {
    const project = process.platform === "win32" ? "C:\\p" : "/p";
    const abs = (rel: string) => (process.platform === "win32" ? `C:\\p\\${rel.replaceAll("/", "\\")}` : `/p/${rel}`);
    const found = insideProject(project, [abs("tex/b.png"), abs("lib/a.blend"), "/elsewhere/x.png", abs("scenes/s.blend"), abs(".frameshell/blender/x.json"), abs("tex/b.png")], "scenes/s.blend");
    expect(found).toEqual(["lib/a.blend", "tex/b.png"]);
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
    expect(readFileSync(here("../skills/blender/SKILL.md"), "utf8")).toMatch(/^---\nname: blender\n/);
    const registered: ClipAdapter[] = [];
    activate({ project: { dir: "/p" }, registerClipType: (adapter: ClipAdapter) => registered.push(adapter) } as unknown as PluginApi);
    expect(registered.map((adapter) => adapter.type)).toEqual(["blender"]);
    expect(registered[0]!.propsSchema).toBe(propsSchema);
  });
});

describe("scripts that run inside Blender", () => {
  for (const name of ["render.py", "deps.py"] as const) {
    it(`${name} is Apache-2.0, as the licence note says, and parses`, () => {
      const text = readFileSync(scriptPath(name), "utf8");
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
    const text = readFileSync(scriptPath("render.py"), "utf8");
    expect(text).not.toMatch(/\b(exec|eval|compile|__import__|subprocess|socket)\b/);
    expect(text).not.toMatch(/bpy\.ops\.(wm|script)\./);
  });
});
