// Figma import (ADR 0044 decision 10): read a folder of exported SVG frames, sanitise each (svg.ts), and fit them
// all with one scale (canvas width / widest frame) centred on the canvas, so UI sizes match between screens.
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { type SvgLimits, sanitizeSvg } from "./svg.js";

/** Limits of one Figma import: starting points, not measured. */
export const FIGMA_LIMITS = {
  /** Most SVG files read from the folder; the rest are skipped with a warning. */
  files: 200,
  /** Largest SVG file, bytes: frames embed their rasters as base64. */
  fileBytes: 25 * 1024 * 1024,
  /** All SVG files of the folder together, bytes. */
  totalBytes: 200 * 1024 * 1024,
  /** Longest embedded `data:` raster kept, characters (about 7.5 MB decoded); a longer one is removed. */
  imageChars: 10_000_000,
  /** Most elements per file, and deepest nesting. */
  elements: 200_000,
  depth: 256,
} as const;

/** Import limits; tests lower them. */
export type FigmaLimits = { -readonly [K in keyof typeof FIGMA_LIMITS]: number };

/** One sanitised frame, before it has a project path. */
export interface FigmaFrame {
  /** File name in the folder. */
  name: string;
  /** File name it is saved under: the name as a slug, unique in the import. */
  file: string;
  svg: string;
  width: number;
  height: number;
  removed: string[];
}

/** Frames read from `dir` in file name order, and why other files were skipped. */
export async function readFigmaFolder(dir: string, limits: FigmaLimits = FIGMA_LIMITS): Promise<{ frames: FigmaFrame[]; warnings: string[] }> {
  const names = (await readdir(dir)).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const warnings: string[] = [];
  const frames: FigmaFrame[] = [];
  const files = new Set<string>();
  const svgLimits: SvgLimits = { imageChars: limits.imageChars, elements: limits.elements, depth: limits.depth };
  let others = 0;
  let total = 0;
  let read = 0;
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const path = join(dir, name);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) continue;
    if (!/\.svg$/i.test(name)) {
      others++;
      continue;
    }
    if (read >= limits.files) {
      warnings.push(`${name} and the files after it were skipped: an import reads at most ${limits.files} SVG files.`);
      break;
    }
    read++;
    if (info.size > limits.fileBytes) {
      warnings.push(`${name} was skipped: larger than ${mb(limits.fileBytes)} MB.`);
      continue;
    }
    if (total + info.size > limits.totalBytes) {
      warnings.push(`${name} and the files after it were skipped: the folder's SVG files pass ${mb(limits.totalBytes)} MB together.`);
      break;
    }
    total += info.size;
    const clean = sanitizeSvg((await readFile(path)).toString("utf8"), svgLimits);
    if (!clean.ok) {
      warnings.push(`${name} was skipped: it ${clean.problem}.`);
      continue;
    }
    const { svg, width, height, removed } = clean.value;
    if (width === null || height === null) {
      warnings.push(`${name} was skipped: it states no size (width and height in px, or a viewBox), so it cannot be placed.`);
      continue;
    }
    const file = uniqueFile(name, files);
    files.add(file);
    frames.push({ name, file, svg, width, height, removed });
  }
  if (others > 0) warnings.push(`${others} file${others === 1 ? " that is" : "s that are"} not .svg ${others === 1 ? "was" : "were"} skipped.`);
  return { frames, warnings };
}

/**
 * One scale for every frame (canvas width / widest frame) and each frame's top-left once centred on the canvas.
 * Positions are rounded to 1/1000 px.
 */
export function fitFrames(frames: readonly { width: number; height: number }[], canvas: { width: number; height: number }): { reference: number; scale: number; places: { x: number; y: number }[] } {
  const reference = Math.max(...frames.map((frame) => frame.width));
  const scale = canvas.width / reference;
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return {
    reference,
    scale,
    places: frames.map((frame) => ({ x: round((canvas.width - frame.width * scale) / 2), y: round((canvas.height - frame.height * scale) / 2) })),
  };
}

/** `Home Screen.svg` → `home-screen.svg`, with `-2`, `-3`… when another frame of the import took it. */
function uniqueFile(name: string, taken: ReadonlySet<string>): string {
  const base = name.replace(/\.svg$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "frame";
  if (!taken.has(`${base}.svg`)) return `${base}.svg`;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}.svg`)) return `${base}-${n}.svg`;
}

function mb(bytes: number): number {
  return Math.round(bytes / 1_048_576);
}
