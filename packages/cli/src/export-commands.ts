import { resolve } from "node:path";
import type { DaemonConnection } from "@frameshell/protocol";

/** Help text of `export otio` (ADR 0045), in `frameshell --help`. */
export const EXPORT_USAGE = `  export otio [--timeline id] [--out file.otio] [--absolute-paths]
                               Write the timeline as an OpenTimelineIO file for an editor: media clips with
                               source ranges and speed, gaps, dissolves between butted clips, track mute and
                               hide, markers. Generated and nested clips keep their slot and length as missing
                               media; the sound of video-track clips goes on an extra Audio track per video
                               track. Program tracks, subtitles, dips and fades, transition shapes, transforms,
                               keys, grades, audio effects and sound fades are left out and listed as warnings.
                               Image projects are refused. Media paths are relative to the file unless
                               --absolute-paths. Default file: exports/<timeline>.otio. Never edits the timeline
  export premiere [--timeline id] [--out file.xml]
                               Write the timeline as a Premiere Pro XML file (xmeml, ADR 0047) for Premiere's
                               File > Import: media clips with source ranges and speed, dissolves between
                               butted clips as Cross Dissolve, track mute and hide, markers, the sound of
                               video-track clips as linked audio clips. Generated and nested clips keep their
                               slot and length as offline media. Left out and listed as warnings: program
                               tracks, subtitles, dips and fades, transition shapes, transforms, keys, grades,
                               audio effects, sound fades, clip gain. Media paths are always absolute
                               file://localhost/ URLs: the file is not portable. Default file:
                               exports/<timeline>.xml. Never edits the timeline
`;

/** Flags each `export` command takes besides the global ones. */
export const EXPORT_FLAGS: Record<string, readonly string[]> = {
  "export otio": ["timeline", "out", "absolute-paths"],
  "export premiere": ["timeline", "out"],
};

/** A parsed `export` command. */
export type ExportInvocation =
  | { kind: "export.otio"; timeline?: string; out?: string; absolutePaths?: true }
  | { kind: "export.premiereXml"; timeline?: string; out?: string };

/** Parse `export <sub>`; null when the shape is wrong. */
export function parseExport(rest: string[], options: { timeline?: string | undefined; out?: string | undefined; "absolute-paths"?: boolean | undefined }): ExportInvocation | null {
  if (rest.length !== 1) return null;
  const shared = { ...(options.timeline ? { timeline: options.timeline } : {}), ...(options.out ? { out: options.out } : {}) };
  if (rest[0] === "premiere") return { kind: "export.premiereXml", ...shared };
  if (rest[0] !== "otio") return null;
  return { kind: "export.otio", ...shared, ...(options["absolute-paths"] ? { absolutePaths: true as const } : {}) };
}

/** Run a parsed `export` command; human output unless `json`. */
export async function executeExport(conn: DaemonConnection, inv: ExportInvocation, cwd: string, json: boolean): Promise<string> {
  const shared = { cwd, ...(inv.timeline ? { timeline: inv.timeline } : {}), ...(inv.out ? { out: resolve(cwd, inv.out) } : {}) };
  const result =
    inv.kind === "export.otio"
      ? await conn.request("export.otio", { ...shared, ...(inv.absolutePaths ? { absolutePaths: true } : {}) })
      : await conn.request("export.premiereXml", shared);
  if (json) return `${JSON.stringify(result, null, 2)}\n`;
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  return (
    `Wrote ${result.path} (${plural(result.tracks, "track")}, ${plural(result.clips, "clip")}, ${plural(result.markers, "marker")}, ${result.fps} fps)\n` +
    result.warnings.map((warning) => `warning: ${warning}\n`).join("")
  );
}
