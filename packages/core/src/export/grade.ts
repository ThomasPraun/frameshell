// Grade tables of an export (ADR 0031): each distinct grade a timeline draws with, its LUT read and the table written
// as a `.cube` for ffmpeg `lut3d` in the work directory. The compiler only names the files (`RenderInput.grades`).
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { ErrorCode, RpcError } from "@frameshell/protocol";
import { type CubeLut, type Timeline, cubeText, gradeKey, gradeOf, gradeTable, parseCube } from "@frameshell/schema";

/** The grade tables of one export: `files` by `gradeKey` for the compiler, `contents` by file name for the work directory. */
export interface GradeFiles {
  files: ReadonlyMap<string, string>;
  contents: Record<string, string>;
}

/** Work-directory file of the table of the grade with `key`. */
export function gradeFile(key: string): string {
  return `grade-${createHash("sha256").update(key).digest("hex").slice(0, 16)}.cube`;
}

/**
 * The table of every grade the media clips on the video tracks of `timeline` (flattened) draw with. A LUT is read once
 * per file. `ExportUnsupported` naming the clip when a LUT is outside the project, missing or not a 3D `.cube`.
 */
export async function gradeFiles(root: string, timeline: Timeline): Promise<GradeFiles> {
  const files = new Map<string, string>();
  const contents: Record<string, string> = {};
  const luts = new Map<string, Promise<CubeLut>>();
  for (const track of timeline.tracks) {
    if (track.kind !== "video") continue;
    for (const clip of track.clips) {
      const grade = gradeOf(clip);
      if (!grade) continue;
      const key = gradeKey(grade);
      if (files.has(key)) continue;
      let lut: CubeLut | null = null;
      if (grade.lut !== null && grade.lutMix > 0) {
        const path = grade.lut;
        if (!luts.has(path)) luts.set(path, readLut(root, path));
        try {
          lut = await luts.get(path)!;
        } catch (error) {
          throw new RpcError(
            ErrorCode.ExportUnsupported,
            `Clip ${clip.id} grades with LUT ${path}, which cannot be used: ${(error as Error).message} Fix the file, or clear the LUT: ` +
              `\`frameshell clip set ${clip.id} --grade-lut none\`.`,
            { timeline: timeline.id, track: track.id, clip: clip.id },
          );
        }
      }
      const name = gradeFile(key);
      files.set(key, name);
      contents[name] = cubeText(gradeTable(grade, lut));
    }
  }
  return { files, contents };
}

async function readLut(root: string, path: string): Promise<CubeLut> {
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
