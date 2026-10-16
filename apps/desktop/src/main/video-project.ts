// Planning a project created from video files (ADR 0013): folder beside the first video, name clash rules, clone test.
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { VideoProjectPlan } from "../shared/api.js";

/** Extensions offered by the Choose video dialog and accepted from drops and Open with. */
export const VIDEO_EXTENSIONS = ["mp4", "mov", "m4v", "mkv", "webm", "avi", "mts"] as const;

/** Above this total, and when no clone is possible, the user picks copy or use in place: a copy then costs real disk space. */
export const ASK_COPY_BYTES = 2 * 1024 ** 3;

/** Characters no folder name may hold on any OS Frameshell runs on. Control characters are removed separately. */
const UNSAFE_NAME = /[\\/:*?"<>|]/g;

/** Folder name from what the user typed or the video's file name; never empty. */
export function projectName(raw: string): string {
  // Windows drops trailing dots and spaces from folder names, which would make the planned path a lie.
  const printable = [...raw].filter((char) => char.charCodeAt(0) >= 0x20).join("");
  const name = printable.replace(UNSAFE_NAME, "-").trim().replace(/[. ]+$/, "");
  return name === "" || name === "." || name === ".." ? "Untitled video" : name;
}

/** File name without its extension: `interview.mp4` → `interview`. */
function stem(file: string): string {
  const name = basename(file);
  return name.slice(0, name.length - extname(name).length) || name;
}

/**
 * Plan the project for `files`: the folder (`parent`/`name`, beside the first
 * file by default), whether it already exists for these videos, and whether
 * the import must ask copy or link. Throws when a file is missing.
 */
export async function planVideoProject(
  files: string[],
  place: { parent?: string; name?: string } = {},
): Promise<VideoProjectPlan> {
  const [first] = files;
  if (!first) throw new Error("Choose at least one video.");
  let totalBytes = 0;
  const sizes: number[] = [];
  for (const file of files) {
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) throw new Error(`${file} is not a file.`);
    sizes.push(info.size);
    totalBytes += info.size;
  }
  const parent = place.parent ?? dirname(first);
  const name = projectName(place.name ?? stem(first));
  for (let n = 1; ; n++) {
    const dir = join(parent, n === 1 ? name : `${name} (${n})`);
    const existing = await stat(dir).catch(() => null);
    if (existing && (await holdsVideo(dir, first, sizes[0] ?? 0))) {
      return { files, parent, name, dir, existing: true, totalBytes, clones: true, askMode: false };
    }
    if (existing) continue;
    const clones = await canClone(first, parent);
    return { files, parent, name, dir, existing: false, totalBytes, clones, askMode: !clones && totalBytes > ASK_COPY_BYTES };
  }
}

/** `dir` is a Frameshell project whose `assets/` has a file with the video's name and size: it was made from this video. */
async function holdsVideo(dir: string, video: string, size: number): Promise<boolean> {
  const config = await stat(join(dir, "frameshell.json")).catch(() => null);
  if (!config?.isFile()) return false;
  const asset = await stat(join(dir, "assets", basename(video))).catch(() => null);
  return asset?.isFile() === true && asset.size === size;
}

/**
 * True when `source` can be cloned (copy-on-write) into `dir`: then the import,
 * which clones when it can, uses no extra space. The test clone is deleted.
 */
export async function canClone(source: string, dir: string): Promise<boolean> {
  const probe = join(dir, `.frameshell-clone-test-${randomUUID().slice(0, 8)}`);
  try {
    // FICLONE_FORCE fails at once where cloning is unsupported, instead of copying the bytes.
    await copyFile(source, probe, constants.COPYFILE_FICLONE_FORCE);
    return true;
  } catch {
    return false;
  } finally {
    await rm(probe, { force: true });
  }
}
