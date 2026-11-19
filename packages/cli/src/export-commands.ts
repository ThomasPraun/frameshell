import { resolve } from "node:path";
import type { DaemonConnection } from "@frameshell/protocol";

/** Help text of `export otio` (ADR 0045), in `frameshell --help`. */
export const EXPORT_USAGE = `  export otio [--timeline id] [--out file.otio] [--absolute-paths]
                               Write the timeline as an OpenTimelineIO file for an editor: media clips with
                               source ranges and speed, gaps, track mute and hide, markers. Generated and
                               nested clips keep their slot and length as missing media; program tracks,
                               subtitles, transitions, transforms, keys, grades, audio effects and the sound of
                               video-track clips are left out and listed as warnings. Media paths are relative to the file unless
                               --absolute-paths. Default file: exports/<timeline>.otio. Never edits the timeline
`;

/** Flags each `export` command takes besides the global ones. */
export const EXPORT_FLAGS: Record<string, readonly string[]> = {
  "export otio": ["timeline", "out", "absolute-paths"],
};

/** A parsed `export` command. */
export type ExportInvocation = { kind: "export.otio"; timeline?: string; out?: string; absolutePaths?: true };

/** Parse `export <sub>`; null when the shape is wrong. */
export function parseExport(rest: string[], options: { timeline?: string | undefined; out?: string | undefined; "absolute-paths"?: boolean | undefined }): ExportInvocation | null {
  if (rest.length !== 1 || rest[0] !== "otio") return null;
  return {
    kind: "export.otio",
    ...(options.timeline ? { timeline: options.timeline } : {}),
    ...(options.out ? { out: options.out } : {}),
    ...(options["absolute-paths"] ? { absolutePaths: true as const } : {}),
  };
}

/** Run a parsed `export` command; human output unless `json`. */
export async function executeExport(conn: DaemonConnection, inv: ExportInvocation, cwd: string, json: boolean): Promise<string> {
  const { kind: _kind, out, ...params } = inv;
  const result = await conn.request("export.otio", { cwd, ...params, ...(out ? { out: resolve(cwd, out) } : {}) });
  if (json) return `${JSON.stringify(result, null, 2)}\n`;
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  return (
    `Wrote ${result.path} (${plural(result.tracks, "track")}, ${plural(result.clips, "clip")}, ${plural(result.markers, "marker")}, ${result.fps} fps)\n` +
    result.warnings.map((warning) => `warning: ${warning}\n`).join("")
  );
}
