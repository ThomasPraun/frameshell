import { join } from "node:path";
import { ErrorCode, RpcError } from "@frameshell/protocol";
import { REQUIREMENTS_FILE, type RequirementsFile, parseRequirementsFile } from "@frameshell/schema";
import { readJsonIfExists } from "../fs-util.js";

/** The project's `requirements.json` (#457), or null when there is none. Throws `InvalidProjectFile`. */
export async function readRequirementsFile(root: string): Promise<RequirementsFile | null> {
  const path = join(root, REQUIREMENTS_FILE);
  const invalid = (details: string) => new RpcError(ErrorCode.InvalidProjectFile, `Invalid ${path}:\n${details}\nFix the file (see the requirements.json JSON Schema) and retry.`, { path, details });
  let raw: unknown;
  try {
    raw = await readJsonIfExists(path);
  } catch (error) {
    throw invalid((error as Error).message);
  }
  if (raw === undefined) return null;
  const parsed = parseRequirementsFile(raw);
  if (!parsed.ok) throw invalid(parsed.error);
  return parsed.value;
}
