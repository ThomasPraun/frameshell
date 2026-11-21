// Where File > Export and the preview's Export image save (#749): the dialogs start in the project's `exports/`, and an
// image is saved under an extension the daemon writes in that format.
import { mkdir } from "node:fs/promises";
import { extname, join } from "node:path";

/** Extensions the daemon's `frame` writes in their own format. */
export const IMAGE_EXPORT_EXTENSIONS = ["png", "jpg", "jpeg", "webp"] as const;

/**
 * The project's `exports/` folder, made when missing, so a save dialog can start in it: on Windows a dialog asked to
 * start in a folder that does not exist opens its parent instead (the project's parent folder).
 */
export async function exportsFolder(dir: string): Promise<string> {
  const folder = join(dir, "exports");
  await mkdir(folder, { recursive: true });
  return folder;
}

/**
 * The path to save an image at: `path` with `.png` added when it has no extension; `path` itself when its extension
 * is one the daemon writes. Null for any other extension (`.gif`, `.tif`): the daemon would write PNG bytes under it.
 */
export function imageExportPath(path: string): string | null {
  const extension = extname(path);
  if (extension === "" || extension === ".") return `${path.replace(/\.$/, "")}.png`;
  return (IMAGE_EXPORT_EXTENSIONS as readonly string[]).includes(extension.slice(1).toLowerCase()) ? path : null;
}
