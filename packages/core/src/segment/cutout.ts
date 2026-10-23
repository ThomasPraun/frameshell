import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { ErrorCode, RpcError } from "@frameshell/protocol";
import { type AnyClip, type MediaClip, type Transform, placementOf } from "@frameshell/schema";
import { exists } from "../fs-util.js";
import { runTool } from "../media/ffmpeg.js";
import type { PixelSize } from "./segmenter.js";

const execFileAsync = promisify(execFile);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const invalid = (reason: string, message: string, field: string) =>
  new RpcError(ErrorCode.InvalidOperation, `image.cutout: ${message}`, { op: "image.cutout", reason, field });

/** True for a clip of a file under `assets/` (not a nested timeline, adapter or shot clip). */
export function isMediaClip(clip: AnyClip): clip is MediaClip {
  return clip.type === "media";
}

/**
 * Absolute path of `mask`: project-relative, or absolute inside the project. `.frameshell/` is allowed
 * because Pick masks live there. Throws `AssetNotFound` or `OutsideProject`.
 */
export async function resolveMask(projectDir: string, mask: string): Promise<string> {
  const target = isAbsolute(mask) ? mask : join(projectDir, ...mask.split("/"));
  let real: string;
  try {
    real = await realpath(resolve(target));
  } catch {
    throw new RpcError(ErrorCode.AssetNotFound, `Mask ${mask} does not exist in ${projectDir}.`, { path: mask });
  }
  const rel = relative(await realpath(projectDir), real);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new RpcError(ErrorCode.OutsideProject, `${mask} is outside the project ${projectDir}.`, { path: mask });
  }
  if (!(await stat(real)).isFile()) throw new RpcError(ErrorCode.AssetNotFound, `Mask ${mask} is not a file.`, { path: mask });
  return real;
}

/** Size, bit depth and colour type from a PNG's header; null when `file` is not a PNG. */
async function pngHeader(file: string): Promise<{ width: number; height: number; depth: number; colorType: number } | null> {
  const bytes = await readFile(file);
  if (bytes.length < 26 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), depth: bytes[24]!, colorType: bytes[25]! };
}

/** Pixel box `[x, y, width, height]` in a photo. */
export type PixelBox = [number, number, number, number];

/**
 * Check `mask` is an 8-bit grayscale PNG of `size` with some white in it and return the box of its non-black
 * pixels, the part the cut-out keeps. Throws InvalidOperation.
 */
export async function checkMask(ffmpeg: string, mask: string, size: PixelSize): Promise<PixelBox> {
  const header = await pngHeader(mask);
  if (!header || header.colorType !== 0 || header.depth !== 8) {
    throw invalid("not a grayscale PNG", "the mask must be an 8-bit grayscale PNG (255 inside the part, 0 outside).", "mask");
  }
  if (header.width !== size.width || header.height !== size.height) {
    throw invalid("mask size differs", `the mask is ${header.width}x${header.height} px, the photo ${size.width}x${size.height} px.`, "mask");
  }
  const bytes = size.width * size.height;
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", mask, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"];
  const { stdout } = await execFileAsync(ffmpeg, args, { encoding: "buffer", maxBuffer: bytes + 1024 * 1024, windowsHide: true });
  const box = maskBox(stdout, size);
  if (!box) throw invalid("empty mask", "the mask is all black: nothing to cut out.", "mask");
  return box;
}

/** Box of the non-zero pixels of a row-major 8-bit `mask` of `size`; null when all are zero. */
export function maskBox(mask: Uint8Array, size: PixelSize): PixelBox | null {
  let x0 = size.width;
  let y0 = -1;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < size.height; y++) {
    const row = y * size.width;
    for (let x = 0; x < size.width; x++) {
      if (mask[row + x] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y0 < 0) y0 = y;
      y1 = y;
    }
  }
  return x1 < 0 ? null : [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
}

/**
 * Transform laying the crop `box` of a `photo`-sized picture exactly over that part of the photo placed with
 * `transform` in a `project`-sized frame. Each layer is first fitted to the frame (`layerRect`, schema
 * composite.ts), so the smaller crop fits larger: scale shrinks by the ratio of the two fits, and the offset
 * moves by the distance of the box center from the photo center, fitted and scaled.
 */
export function cutoutTransform(photo: PixelSize, box: PixelBox, project: PixelSize, transform: Transform | undefined): Transform {
  const placed = placementOf(transform);
  const [x, y, width, height] = box;
  const photoFit = Math.min(project.width / photo.width, project.height / photo.height);
  const boxFit = Math.min(project.width / width, project.height / height);
  const shown = photoFit * placed.scale;
  return {
    x: placed.x + (x + width / 2 - photo.width / 2) * shown,
    y: placed.y + (y + height / 2 - photo.height / 2) * shown,
    scale: (placed.scale * photoFit) / boxFit,
    opacity: placed.opacity,
  };
}

/** First `<stem>-cutout-<n>.png` (n from 1) that is not in `assets/` of `projectDir`. */
export async function freeCutoutName(projectDir: string, stem: string): Promise<string> {
  for (let n = 1; ; n++) {
    const name = `${stem}-cutout-${n}.png`;
    if (!(await exists(join(projectDir, "assets", name)))) return name;
  }
}

/**
 * Render `photo` with `mask` as its alpha, cropped to `box`, into a PNG named `name` in a fresh temp folder.
 * The caller imports the file (a copy into `assets/`), then calls `cleanup`.
 */
export async function renderCutout(
  ffmpeg: string,
  photo: string,
  mask: string,
  box: PixelBox,
  name: string,
): Promise<{ file: string; cleanup(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "frameshell-cutout-"));
  const file = join(dir, name);
  const [x, y, width, height] = box;
  const filter = `[0:v]format=rgba[p];[1:v]format=gray[m];[p][m]alphamerge,crop=${width}:${height}:${x}:${y}[o]`;
  try {
    await runTool(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", photo, "-i", mask, "-filter_complex", filter, "-map", "[o]", "-frames:v", "1", file]);
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return { file, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
