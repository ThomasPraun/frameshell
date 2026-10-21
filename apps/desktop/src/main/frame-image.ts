import { mkdtemp, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Size } from "@frameshell/schema/composite";
import type { DaemonLink } from "./daemon-link.js";
import { type ImageLayersDeps, addImageLayers } from "./image-layers.js";
import { projectName } from "./video-project.js";

/** Picture sizes offered for an image made from a frame, besides the video's own (ADR 0017). */
export const FRAME_IMAGE_SIZES = {
  /** YouTube's recommended thumbnail size. */
  thumbnail: { width: 1280, height: 720 },
  square: { width: 1080, height: 1080 },
  vertical: { width: 1080, height: 1920 },
} as const satisfies Record<string, Size>;

/** What {@link imageFromFrame} needs from the app; replaced in tests. */
export interface FrameImageDeps {
  /** The app's daemon connection (`ui` author). */
  request: DaemonLink["request"];
  /** {@link addImageLayers} deps for the new project at `dir`, once it exists. */
  layers: (dir: string) => Promise<ImageLayersDeps>;
  /** Where the capture waits before its import (the OS temp folder). */
  tempDir: string;
}

/**
 * Make an image project from the frame of `timeline` showing at `at` seconds in the project at `dir` (ADR 0017):
 * a folder beside that project, named after it and the time (`interview frame 01-05`, then `… (2)`), `size`
 * big, with the frame as its only layer covering the picture. The video project is left as it was. Resolves
 * with the new project's folder.
 */
export async function imageFromFrame(source: { dir: string; name: string }, timeline: string, at: number, size: Size, deps: FrameImageDeps): Promise<string> {
  const stamp = clockName(at);
  const dir = await freeFolder(dirname(source.dir), projectName(`${source.name} frame ${stamp}`));
  const scratch = await mkdtemp(join(deps.tempDir, "frameshell-frame-"));
  try {
    const capture = join(scratch, `frame-${stamp}.png`);
    await deps.request("frame", { cwd: source.dir, timeline, at, out: capture });
    await deps.request("project.init", { dir, name: basename(dir), kind: "image", resolution: size });
    const { imported } = await deps.request("asset.import", { cwd: dir, files: [capture], mode: "copy" });
    await addImageLayers(dir, "main", imported.map((item) => item.asset), await deps.layers(dir), "cover");
    return dir;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** `at` as minutes and seconds for a file name: 65.4 → `01-05`; hours when there are some: `1-02-03`. */
export function clockName(at: number): string {
  const total = Math.max(0, Math.floor(at));
  const two = (n: number) => String(n).padStart(2, "0");
  const hours = Math.floor(total / 3600);
  const rest = `${two(Math.floor((total % 3600) / 60))}-${two(total % 60)}`;
  return hours > 0 ? `${hours}-${rest}` : rest;
}

/** `parent`/`name`, or `name (2)`, `name (3)`… when taken. */
async function freeFolder(parent: string, name: string): Promise<string> {
  for (let n = 1; ; n++) {
    const dir = join(parent, n === 1 ? name : `${name} (${n})`);
    if (!(await stat(dir).catch(() => null))) return dir;
  }
}
