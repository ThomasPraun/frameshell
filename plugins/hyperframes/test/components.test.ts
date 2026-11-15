import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandResult } from "@frameshell/plugin-api";
import { type BrandManifest, fitFrames, parseBrandManifest } from "@frameshell/schema";
import { type CheckReport, checkCompositions, newComposition } from "../src/index.js";
import { placeFrame, readComponents } from "../src/templates/components.js";
import type { TemplateVariable } from "../src/templates/index.js";

let project: string;
type Outcome = Exclude<CommandResult, string | void>;

const LOGO = "assets/brand/acme-com/logo-1.svg";
const SECTION = "assets/brand/acme-com/section-pricing.png";
const HOME = "assets/brand/acme-figma/home.svg";
const PHONE = "assets/brand/acme-figma/phone.svg";
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40" viewBox="0 0 120 40"><rect width="120" height="40" fill="#ff3366"/></svg>';

/** A `brand.json` the schema accepts: one capture (logo, section crop, font) and one Figma import (two frames). */
function manifest(): BrandManifest {
  const file = (path: string, role: string, kind: string, width: number | null, height: number | null) => ({ path, role, kind, origin: "captured", sourceUrl: "https://acme.com/", width, height });
  const frames = [
    { width: 1440, height: 1024 },
    { width: 375, height: 812 },
  ];
  const fit = fitFrames(frames, { width: 1920, height: 1080 });
  const parsed = parseBrandManifest({
    schemaVersion: 1,
    captures: [
      {
        id: "acme-com",
        url: "https://acme.com/",
        finalUrl: "https://acme.com/",
        capturedAt: "2026-11-15T10:00:00.000Z",
        title: "Acme",
        ok: true,
        reason: null,
        textLength: 900,
        files: [file(LOGO, "logo", "svg", 120, 40), file(SECTION, "section", "raster", 2400, 1500), file("assets/fonts/Inter-400.woff2", "font", "font", null, null)],
        colors: [],
        accent: null,
        fonts: [],
        variables: {},
        headings: [],
        buttons: [],
        videos: [],
        warnings: [],
      },
    ],
    imports: [
      {
        id: "acme-figma",
        kind: "figma",
        source: "/tmp/acme-figma",
        importedAt: "2026-11-15T10:00:00.000Z",
        canvas: { width: 1920, height: 1080 },
        reference: fit.reference,
        scale: fit.scale,
        frames: [HOME, PHONE].map((path, index) => ({ path, name: `${path.split("/")[3]}`, origin: "imported", ...frames[index]!, ...fit.places[index]!, removed: [] })),
        warnings: [],
      },
    ],
  });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

function writeProject(width = 1920, height = 1080): void {
  writeFileSync(join(project, "frameshell.json"), JSON.stringify({ resolution: { width, height } }));
  writeFileSync(join(project, "brand.json"), JSON.stringify(manifest()));
  for (const path of [LOGO, HOME, PHONE]) {
    mkdirSync(dirname(join(project, path)), { recursive: true });
    writeFileSync(join(project, path), SVG);
  }
  writeFileSync(join(project, SECTION), "png-bytes");
}

beforeEach(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-hyperframes-components-")));
  writeProject();
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

const scaffold = async (args: string[]) => (await newComposition.run({ args, cwd: project, project: { dir: project } })) as Outcome;
const dirOf = (name: string) => join(project, "compositions", "hyperframes", name);
const declared = (name: string) =>
  JSON.parse(/data-composition-variables='([^']*)'/.exec(readFileSync(join(dirOf(name), "index.html"), "utf8"))![1]!.replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&amp;/g, "&")) as TemplateVariable[];
const defaultOf = (name: string, prop: string) => declared(name).find((variable) => variable.id === prop)?.default;

describe("readComponents", () => {
  it("lists the captured pictures and the Figma frames of a schema-valid brand.json, never a font", async () => {
    const { components, problem } = await readComponents(project);
    expect(problem).toBeNull();
    expect(components.map((component) => [component.path, component.role, component.kind, component.origin])).toEqual([
      [LOGO, "logo", "svg", "captured"],
      [SECTION, "section", "raster", "captured"],
      [HOME, "frame", "svg", "imported"],
      [PHONE, "frame", "svg", "imported"],
    ]);
    expect(components[2]!.reference).toBe(1440);
  });

  it("skips paths outside the entry's own brand folder", async () => {
    const tampered = manifest() as unknown as { captures: { files: { path: string }[] }[] };
    tampered.captures[0]!.files[0]!.path = "assets/brand/other/logo-1.svg";
    tampered.captures[0]!.files[1]!.path = "assets/brand/acme-com/../../../secret.png";
    writeFileSync(join(project, "brand.json"), JSON.stringify(tampered));
    expect((await readComponents(project)).components.map((component) => component.path)).toEqual([HOME, PHONE]);
  });

  it("says why when there is no brand.json or it is broken", async () => {
    rmSync(join(project, "brand.json"));
    expect((await readComponents(project)).problem).toContain("frameshell brand capture");
    writeFileSync(join(project, "brand.json"), "{ nope");
    expect((await readComponents(project)).problem).toBe("brand.json is not valid JSON");
  });
});

describe("placeFrame", () => {
  it("matches fitFrames of @frameshell/schema on every canvas (twin parity)", () => {
    const frames = [
      { width: 1440, height: 1024 },
      { width: 375, height: 812 },
      { width: 1200, height: 3000 },
    ];
    for (const canvas of [
      { width: 1920, height: 1080 },
      { width: 1080, height: 1920 },
      { width: 1080, height: 1350 },
      { width: 1366, height: 768 },
    ]) {
      const fit = fitFrames(frames, canvas);
      frames.forEach((frame, index) => expect(placeFrame(frame, fit.reference, canvas)).toEqual({ scale: fit.scale, ...fit.places[index]! }));
    }
  });
});

describe("frameshell hyperframes new --component", () => {
  it("copies the brand picture into the composition and makes it the image prop's default", async () => {
    const result = await scaffold(["closer", "--template", "logo-lockup", "--component", LOGO]);
    expect(readFileSync(join(dirOf("closer"), "brand", "acme-com", "logo-1.svg"), "utf8")).toBe(SVG);
    expect(defaultOf("closer", "logo")).toBe("brand/acme-com/logo-1.svg");
    expect(result.output).toContain(`Brand picture: logo = brand/acme-com/logo-1.svg (captured logo, svg, copied from ${LOGO})`);
    expect(result.data).toMatchObject({ components: [{ prop: "logo", file: "brand/acme-com/logo-1.svg", source: LOGO, origin: "captured", licence: null }] });
    expect((result.data as { props: TemplateVariable[] }).props.find((variable) => variable.id === "logo")?.default).toBe("brand/acme-com/logo-1.svg");
  });

  it("takes the path without assets/brand/ and keeps the rest of the props", async () => {
    await scaffold(["shot", "--template", "device-frame", "--component", "acme-com/section-pricing.png"]);
    expect(defaultOf("shot", "screenshot")).toBe("brand/acme-com/section-pricing.png");
    expect(defaultOf("shot", "frame")).toBe("browser");
  });

  it("fills named props of a template with two pictures, and asks for the name otherwise", async () => {
    await expect(scaffold(["ba", "--template", "before-after", "--component", HOME])).rejects.toThrow(/2 image props \(before, after\); say which/);
    expect(existsSync(dirOf("ba"))).toBe(false);
    await scaffold(["ba", "--template", "before-after", "--component", `before=${HOME}`, "--component", `after=${PHONE}`]);
    expect(defaultOf("ba", "before")).toBe("brand/acme-figma/home.svg");
    expect(defaultOf("ba", "after")).toBe("brand/acme-figma/phone.svg");
  });

  it("reports a Figma frame's placement at its folder's one scale on this canvas", async () => {
    writeProject(1080, 1920);
    const result = await scaffold(["reveal", "--template", "pull-back-reveal", "--component", HOME]);
    const scale = 1080 / 1440;
    const frame = { scale, x: 0, y: Math.round(((1920 - 1024 * scale) / 2) * 1000) / 1000 };
    expect(result.data).toMatchObject({ components: [{ prop: "picture", origin: "imported", role: "frame", frame }] });
    expect(result.output).toContain(`scale 0.75, x 0, y ${frame.y}`);
  });

  it("reminds about credits until the source has a licence", async () => {
    const reminder = "frameshell credits set assets/brand/acme-com/logo-1.svg --licence own";
    expect((await scaffold(["a", "--template", "end-card", "--component", LOGO])).output).toContain(reminder);
    writeFileSync(join(project, "credits.json"), JSON.stringify({ schemaVersion: 1, assets: [{ asset: LOGO, hash: `sha256:${"0".repeat(64)}`, licence: "own", addedAt: "2026-11-15" }] }));
    const confirmed = await scaffold(["b", "--template", "end-card", "--component", LOGO]);
    expect(confirmed.output).not.toContain(reminder);
    expect(confirmed.data).toMatchObject({ components: [{ licence: "own" }] });
  });

  it("refuses before writing anything: no template, no picture prop, an unknown file, a font, a wrong prop, a missing file", async () => {
    await expect(scaffold(["x", "--component", LOGO])).rejects.toThrow("--component needs --template");
    await expect(scaffold(["x", "--template", "counter", "--component", LOGO])).rejects.toThrow("the counter template shows no picture");
    await expect(scaffold(["x", "--template", "end-card", "--component", "assets/brand/acme-com/nope.svg"])).rejects.toThrow(
      `pick one of: ${LOGO} (logo), ${SECTION} (section), ${HOME} (frame), ${PHONE} (frame)`,
    );
    await expect(scaffold(["x", "--template", "end-card", "--component", "assets/fonts/Inter-400.woff2"])).rejects.toThrow("is not a picture brand.json lists");
    await expect(scaffold(["x", "--template", "end-card", "--component", `screenshot=${LOGO}`])).rejects.toThrow("screenshot is not an image prop of the end-card template; its image props: logo");
    await expect(scaffold(["x", "--template", "end-card", "--component", LOGO, "--component", LOGO])).rejects.toThrow("logo is given twice");
    await expect(scaffold(["x", "--template", "end-card", "--component"])).rejects.toThrow("--component takes a picture");
    rmSync(join(project, LOGO));
    await expect(scaffold(["x", "--template", "end-card", "--component", LOGO])).rejects.toThrow("listed in brand.json but missing on disk");
    rmSync(join(project, "brand.json"));
    await expect(scaffold(["x", "--template", "end-card", "--component", LOGO])).rejects.toThrow("the project has no brand.json yet");
    expect(existsSync(dirOf("x"))).toBe(false);
  });

  it("passes `hyperframes check` with the brand picture in place", async () => {
    await scaffold(["closer", "--template", "logo-lockup", "--component", LOGO]);
    const checked = (await checkCompositions.run({ args: ["closer", "--strict"], cwd: project, project: { dir: project } })) as Outcome;
    expect((checked.data as CheckReport).compositions[0]!.findings.filter((finding) => finding.severity !== "info")).toEqual([]);
    expect(checked.failed).toBe(false);
  });
});
