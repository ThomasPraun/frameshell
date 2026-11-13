// Reading a voiceover script and choosing its lines: shared by `voiceover.generate` and `voiceover.place`.
import { ErrorCode, RpcError } from "@frameshell/protocol";
import { type VoiceoverLine, type VoiceoverScript, parseVoiceoverScript } from "@frameshell/schema";
import { locateScript } from "../scripts/outline.js";

/** A voiceover script read from the project. */
export interface ReadScript {
  /** Project-relative, `/`-separated. */
  path: string;
  script: VoiceoverScript;
  /** Every spoken line, in file order. */
  lines: VoiceoverLine[];
}

/** `InvalidParams` naming `field`, in the shape the daemon validates params with. */
export function invalidParam(field: string, message: string): RpcError {
  return new RpcError(ErrorCode.InvalidParams, message, { issues: [{ path: [field], message }] });
}

/**
 * Read `script` (absolute, or relative to `cwd` then `root`) and parse it. Throws `ScriptNotFound`, `OutsideProject`, or
 * `InvalidOperation` naming `op` when the script lacks `voiceover: true`.
 */
export async function readVoiceoverScript(root: string, cwd: string, script: string, op: string): Promise<ReadScript> {
  const { path, text } = await locateScript(root, cwd, script);
  const parsed = parseVoiceoverScript(text);
  if (!parsed.voiceover.voiceover) {
    throw new RpcError(ErrorCode.InvalidOperation, `${path} is not a voiceover script: add \`voiceover: true\` to its frontmatter.`, {
      op,
      reason: "not a voiceover script",
      field: "script",
      hint: "Write the lines to be read in a script with `voiceover: true` in its frontmatter.",
    });
  }
  return { path, script: parsed, lines: parsed.scenes.flatMap((scene) => scene.lines) };
}

/** Lines `ids` names, in script order; all when absent. Throws `InvalidParams` naming unknown ids, or a script with no lines. */
export function pickLines(all: VoiceoverLine[], ids: readonly string[] | undefined): VoiceoverLine[] {
  if (!ids) {
    if (all.length === 0) throw invalidParam("script", "The script has no lines to say: write them under `## ` scene headings.");
    return all;
  }
  const known = new Set(all.map((line) => line.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw invalidParam("lines", `No line ${unknown.join(", ")} in the script (lines: ${all.map((line) => line.id).join(", ") || "none"}).`);
  }
  const wanted = new Set(ids);
  return all.filter((line) => wanted.has(line.id));
}
