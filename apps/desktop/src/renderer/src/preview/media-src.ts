/** URL of the project-relative `path` under the window's media root (`frameshell-media://`). Worker-safe: no DOM. */
export function mediaSrc(mediaUrl: string, path: string): string {
  return mediaUrl + path.split("/").map(encodeURIComponent).join("/");
}
