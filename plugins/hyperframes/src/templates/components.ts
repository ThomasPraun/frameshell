// `hyperframes new --component` (ADR 0044): a picture of the project brand, as `brand.json` lists it, becomes
// the default of a template's image prop. The file is copied into the composition (a page loads nothing outside
// its directory). Read leniently like `style.json` in tokens.ts: core owns `brand.json` and its validation.
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { TemplateVariable } from "./kit.js";

/** A picture `brand.json` lists, usable as a template image. */
export interface BrandComponent {
  /** Project-relative path, `assets/brand/<brand>/<file>`. */
  path: string;
  /** Id of the capture or Figma import that wrote it (its folder under `assets/brand/`). */
  brand: string;
  kind: "svg" | "raster";
  /** `captured` from a page, `imported` from a Figma folder; never redrawn. */
  origin: "captured" | "imported";
  /** Role of a captured file (`logo`, `icon`, `og`, `hero`, `page`, `section`), `frame` for a Figma frame. */
  role: string;
  width: number | null;
  height: number | null;
  /** Figma frame: width its folder's one scale is taken from (the widest frame). */
  reference?: number;
}

/** Path of a brand picture: `BRAND_DIR` of `packages/schema/src/brand.ts`, one brand folder deep, an image extension. */
const PICTURE = /^assets\/brand\/[a-z0-9][a-z0-9-]*\/[^/\\]+\.(?:svg|png|jpe?g|gif|webp)$/i;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const size = (value: unknown): number | null => (typeof value === "number" && value > 0 && Number.isFinite(value) ? value : null);

/**
 * The pictures of `<project>/brand.json`: captured SVG and raster files and Figma frames. Fonts and
 * malformed entries are skipped; `problem` says why nothing could be read.
 */
export async function readComponents(projectDir: string): Promise<{ components: BrandComponent[]; problem: string | null }> {
  const raw = await readFile(join(projectDir, "brand.json"), "utf8").catch(() => null);
  if (raw === null) return { components: [], problem: "the project has no brand.json yet: run `frameshell brand capture <url>` or `frameshell brand import-figma <dir>` first" };
  let manifest: unknown;
  try {
    manifest = JSON.parse(raw);
  } catch {
    return { components: [], problem: "brand.json is not valid JSON" };
  }
  if (!isRecord(manifest)) return { components: [], problem: "brand.json is not an object" };
  const components: BrandComponent[] = [];
  const add = (component: BrandComponent) => {
    if (PICTURE.test(component.path) && component.path.split("/")[2] === component.brand) components.push(component);
  };
  for (const capture of Array.isArray(manifest["captures"]) ? manifest["captures"] : []) {
    if (!isRecord(capture) || typeof capture["id"] !== "string" || !Array.isArray(capture["files"])) continue;
    for (const file of capture["files"]) {
      if (!isRecord(file) || typeof file["path"] !== "string" || (file["kind"] !== "svg" && file["kind"] !== "raster")) continue;
      add({ path: file["path"], brand: capture["id"], kind: file["kind"], origin: "captured", role: String(file["role"] ?? "file"), width: size(file["width"]), height: size(file["height"]) });
    }
  }
  for (const entry of Array.isArray(manifest["imports"]) ? manifest["imports"] : []) {
    if (!isRecord(entry) || typeof entry["id"] !== "string" || !Array.isArray(entry["frames"])) continue;
    const reference = size(entry["reference"]);
    for (const frame of entry["frames"]) {
      if (!isRecord(frame) || typeof frame["path"] !== "string") continue;
      add({
        path: frame["path"],
        brand: entry["id"],
        kind: "svg",
        origin: "imported",
        role: "frame",
        width: size(frame["width"]),
        height: size(frame["height"]),
        ...(reference ? { reference } : {}),
      });
    }
  }
  return { components, problem: null };
}

/** One `--component` resolved: which image prop it fills and where its copy lives in the composition. */
export interface ComponentPick {
  prop: string;
  component: BrandComponent;
  /** Path inside the composition directory, `brand/<brand>/<file>`: the prop's default. */
  file: string;
}

/**
 * Resolves `--component` values (`<path>` or `<prop>=<path>`; the path as `brand show` prints it, the
 * `assets/brand/` prefix optional) against the template's image props. A template with one image prop takes
 * a bare path. Throws with what to pass instead.
 */
export function pickComponents(specs: readonly string[], templateId: string, variables: readonly TemplateVariable[], listed: { components: BrandComponent[]; problem: string | null }): ComponentPick[] {
  const images = variables.filter((variable) => variable.type === "image").map((variable) => variable.id);
  if (images.length === 0) throw new Error(`--component: the ${templateId} template shows no picture; templates with an image prop take one`);
  const picks: ComponentPick[] = [];
  for (const spec of specs) {
    // Brand file names are slugs, so an `=` always separates a prop name.
    const equals = spec.indexOf("=");
    const named = equals > 0 ? spec.slice(0, equals) : undefined;
    if (named !== undefined && !images.includes(named)) {
      throw new Error(`--component: ${named} is not an image prop of the ${templateId} template; its image props: ${images.join(", ")}`);
    }
    const ref = named === undefined ? spec : spec.slice(equals + 1);
    const prop = named ?? (images.length === 1 ? images[0]! : undefined);
    if (prop === undefined) {
      throw new Error(`--component: the ${templateId} template has ${images.length} image props (${images.join(", ")}); say which, e.g. \`--component ${images[0]}=<path>\``);
    }
    if (picks.some((pick) => pick.prop === prop)) throw new Error(`--component: ${prop} is given twice`);
    const path = ref.startsWith("assets/") ? ref : `assets/brand/${ref}`;
    const component = listed.components.find((candidate) => candidate.path === path);
    if (!component) throw new Error(`--component: ${ref} is not a picture brand.json lists; ${available(listed)}`);
    picks.push({ prop, component, file: `brand/${component.brand}/${component.path.split("/")[3]}` });
  }
  return picks;
}

function available({ components, problem }: { components: BrandComponent[]; problem: string | null }): string {
  if (problem) return problem;
  if (components.length === 0) return "brand.json lists no picture: run `frameshell brand capture <url>` or `frameshell brand import-figma <dir>` first";
  const shown = components.slice(0, 12).map((component) => `${component.path} (${component.role})`);
  return `pick one of: ${shown.join(", ")}${components.length > shown.length ? `, and ${components.length - shown.length} more (\`frameshell brand show\`)` : ""}`;
}

/** True when `path` (project-relative) is a regular file of the project. */
export async function componentExists(projectDir: string, path: string): Promise<boolean> {
  return (await stat(join(projectDir, ...path.split("/"))).catch(() => null))?.isFile() ?? false;
}

/**
 * A Figma frame on a `canvas` at its folder's one scale (canvas width / `reference`), centred, rounded to
 * 1/1000 px. Twin of `fitFrames` in `packages/schema/src/brand.ts`; `test/components.test.ts` checks parity.
 */
export function placeFrame(frame: { width: number; height: number }, reference: number, canvas: { width: number; height: number }): { scale: number; x: number; y: number } {
  const scale = canvas.width / reference;
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return { scale, x: round((canvas.width - frame.width * scale) / 2), y: round((canvas.height - frame.height * scale) / 2) };
}

/**
 * The licence `credits.json` records for `path`, or null when it records none (or `unknown`). Lenient: the
 * hash is not compared, since `frameshell credits` is the check; this only decides whether to remind.
 */
export async function recordedLicence(projectDir: string, path: string): Promise<string | null> {
  const raw = await readFile(join(projectDir, "credits.json"), "utf8").catch(() => null);
  if (raw === null) return null;
  try {
    const credits: unknown = JSON.parse(raw);
    const assets = isRecord(credits) && Array.isArray(credits["assets"]) ? credits["assets"] : [];
    const entry = assets.find((asset): asset is Record<string, unknown> => isRecord(asset) && asset["asset"] === path);
    const licence = entry?.["licence"];
    return typeof licence === "string" && licence.trim() !== "" && licence.trim() !== "unknown" ? licence.trim() : null;
  } catch {
    return null;
  }
}
