import { join } from "node:path";
import { ErrorCode, RpcError } from "@frameshell/protocol";
import { STYLE_FILE, type StyleFile, parseStyleFile } from "@frameshell/schema";
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
