// File kinds by extension, shared by main (dialogs, drops) and renderer (inspector wording); no Node imports.

/** Image extensions Frameshell imports, lower case without the dot. */
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"] as const;

/** True when `path` names an image by its extension (any case). */
export function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && (IMAGE_EXTENSIONS as readonly string[]).includes(path.slice(dot + 1).toLowerCase());
}
