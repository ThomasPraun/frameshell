// Which files are pictures a layer or a clip can show (ADR 0017), by extension: one list for main and renderer.

/** Still images a clip can show; they also start an image project. */
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"] as const;

/** `path` (any separators) names a still image by its extension, case-insensitive. */
export function isImagePath(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 && (IMAGE_EXTENSIONS as readonly string[]).includes(name.slice(dot + 1).toLowerCase());
}
