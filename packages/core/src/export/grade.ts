// Grade tables of an export (ADR 0031): each distinct grade chain a timeline draws with, its LUTs read and the table written
// as a `.cube` for ffmpeg `lut3d` in the work directory. The compiler only names the files (`RenderInput.grades`).
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { ErrorCode, RpcError } from "@frameshell/protocol";
import { type CubeLut, type GradeStage, type Timeline, cubeText, gradeChainKey, gradeChainOf, gradeChainTable, gradeOf, parseCube } from "@frameshell/schema";

/** The grade tables of one export: `files` by `gradeChainKey` for the compiler, `contents` by file name for the work directory. */
export interface GradeFiles {
  files: ReadonlyMap<string, string>;
  contents: Record<string, string>;
}

/** Work-directory file of the table of the grade with `key`. */
export function gradeFile(key: string): string {
  return `grade-${createHash("sha256").update(key).digest("hex").slice(0, 16)}.cube`;
}

/**
 * The table of every grade chain (`gradeChainOf`) the media and generated clips on the video tracks of `timeline`
 * (flattened) draw with. A LUT is read once per file. `ExportUnsupported` naming the clip when a LUT is outside the
 * project, missing or not a 3D `.cube`.
 */
export async function gradeFiles(root: string, timeline: Timeline): Promise<GradeFiles> {
  const files = new Map<string, string>();
  const contents: Record<string, string> = {};
  const luts = new Map<string, Promise<CubeLut>>();
  for (const track of timeline.tracks) {
    if (track.kind !== "video") continue;
    for (const clip of track.clips) {
      const chain = gradeChainOf(clip);
      if (!chain) continue;
      const key = gradeChainKey(chain);
      if (files.has(key)) continue;
      const stages: GradeStage[] = [];
      for (const grade of chain) {
        const path = grade.lut !== null && grade.lutMix > 0 ? grade.lut : null;
        if (path === null) {
          stages.push({ grade, lut: null });
          continue;
        }
        if (!luts.has(path)) luts.set(path, readLut(root, path));
        try {
          stages.push({ grade, lut: await luts.get(path)! });
        } catch (error) {
          const own = gradeOf(clip)?.lut === path;
          throw new RpcError(
            ErrorCode.ExportUnsupported,
            own
              ? `Clip ${clip.id} grades with LUT ${path}, which cannot be used: ${(error as Error).message} Fix the file, or clear the LUT: ` +
                  `\`frameshell clip set ${clip.id} --grade-lut none\`.`
              : `Clip ${clip.id} plays inside a nested timeline clip that grades with LUT ${path}, which cannot be used: ` +
                  `${(error as Error).message} Fix the file, or clear that clip's LUT with \`frameshell clip set <clip> --grade-lut none\`.`,
            { timeline: timeline.id, track: track.id, clip: clip.id },
          );
        }
      }
      const name = gradeFile(key);
      files.set(key, name);
      contents[name] = cubeText(gradeChainTable(stages));
    }
  }
  return { files, contents };
}

/** The 3D LUT at project-relative `path`; rejects with the reason (outside the project, no such file, not a 3D `.cube`) as the message. */
export async function readLut(root: string, path: string): Promise<CubeLut> {
  const file = resolve(root, path);
  const inside = relative(root, file);
  if (inside.startsWith("..") || isAbsolute(inside)) throw new Error("it is outside the project.");
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    throw new Error((error as NodeJS.ErrnoException).code === "ENOENT" ? "no such file." : `${(error as Error).message}.`, { cause: error });
  }
  return parseCube(text);
}
