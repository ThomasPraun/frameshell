import { type ResolvedStyle, STYLE_FILE, parseStyleFile, resolveStyle } from "@frameshell/schema";

/**
 * The project's style (`style.json`, ADR 0028) with its defaults: the numbers `clip set --glass` and `--voice` copy
 * into a clip. A missing file gives the defaults; a file that does not parse throws with its message.
 */
export async function projectStyle(): Promise<ResolvedStyle> {
  const text = await window.frameshell.files.read(STYLE_FILE).catch(() => null);
  if (text === null) return resolveStyle(null);
  const parsed = parseStyleFile(JSON.parse(text));
  if (!parsed.ok) throw new Error(`${STYLE_FILE}: ${parsed.error}`);
  return resolveStyle(parsed.value);
}
