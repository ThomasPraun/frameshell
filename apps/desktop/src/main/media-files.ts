// Which files from the OS (dialog, drop, Open with) the app takes as videos or as project media.
import { stat } from "node:fs/promises";
import { extname } from "node:path";

/** Video extensions: the Choose video dialog, drops on the welcome screen, Open with. */
export const VIDEO_EXTENSIONS = ["mp4", "mov", "m4v", "mkv", "webm", "avi", "mts"] as const;

/** Media a drop on a project imports into `assets/`: videos, audio, images. */
export const MEDIA_EXTENSIONS = [
  ...VIDEO_EXTENSIONS,
  ...["wav", "mp3", "m4a", "aac", "flac", "ogg", "opus"],
  ...["png", "jpg", "jpeg", "gif", "webp", "svg"],
] as const;

/**
 * Split `paths` into files with one of `extensions` (case-insensitive) and
 * the rest, which includes folders and missing paths. Order is kept.
 */
export async function partitionFiles(
  paths: string[],
  extensions: readonly string[],
): Promise<{ accepted: string[]; refused: string[] }> {
  const accepted: string[] = [];
  const refused: string[] = [];
  for (const path of paths) {
    const ext = extname(path).slice(1).toLowerCase();
    const info = await stat(path).catch(() => null);
    (info?.isFile() && extensions.includes(ext) ? accepted : refused).push(path);
  }
  return { accepted, refused };
}
