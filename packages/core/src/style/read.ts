import { join } from "node:path";
import { ErrorCode, RpcError, type StyleShowResult } from "@frameshell/protocol";
import { SAFE_ZONES, STYLE_FILE, type StyleFile, parseStyleFile, resolveStyle } from "@frameshell/schema";
import { readJsonIfExists } from "../fs-util.js";

/** The project's `style.json` (ADR 0028), or null when there is none. Throws `InvalidProjectFile`. */
export async function readStyleFile(root: string): Promise<StyleFile | null> {
  const path = join(root, STYLE_FILE);
  const invalid = (details: string) => new RpcError(ErrorCode.InvalidProjectFile, `Invalid ${path}:\n${details}`, { path, details });
  let raw: unknown;
  try {
    raw = await readJsonIfExists(path);
  } catch (error) {
    throw invalid((error as Error).message);
  }
  if (raw === undefined) return null;
  const parsed = parseStyleFile(raw);
  if (!parsed.ok) throw invalid(parsed.error);
  return parsed.value;
}

/** `style.show`: the resolved style with each value's source, and the safe zones of the platforms it names. */
export async function showStyle(root: string): Promise<StyleShowResult> {
  const file = await readStyleFile(root);
  if (!file) return { dir: root, path: STYLE_FILE, style: null, from: null, safeZones: [] };
  const style = resolveStyle(file);
  return { dir: root, path: STYLE_FILE, style, from: file.from ?? null, safeZones: style.platforms.value.map((id) => SAFE_ZONES[id]) };
}
