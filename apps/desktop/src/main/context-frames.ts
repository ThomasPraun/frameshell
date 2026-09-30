import { join, relative, sep } from "node:path";
import type { DaemonRequest } from "./timeline-editor.js";

/** Where "Ask agent" frame captures go (SPEC §10): regenerable, gitignored with the rest of `.frameshell/`. */
export const CONTEXT_DIR = [".frameshell", "context"] as const;

/** Timeline the preview plays and regions are drawn on. */
const TIMELINE = "main";

/**
 * Capture the frame of the main timeline showing at `at` (timeline seconds)
 * for a preview region reference: the daemon's `frame` method renders it
 * with the export compiler (as MCP `frame_capture` does) and writes it, so
 * main stays read-only. Named `f_<frame>.png` after the frame index, so
 * asking twice about one frame reuses one file. Resolves with the
 * project-relative, `/`-separated path; rejects with the daemon's message
 * (no media, ffmpeg missing, time outside the timeline).
 */
export async function captureContextFrame(request: DaemonRequest, projectDir: string, at: number): Promise<string> {
  const { fps } = await request("timeline.show", { cwd: projectDir, timeline: TIMELINE });
  const frame = Math.max(0, Math.floor(at * fps + 1e-6));
  const out = join(projectDir, ...CONTEXT_DIR, `f_${String(frame).padStart(4, "0")}.png`);
  // The frame's own start: the daemon captures exactly the frame the name says.
  const result = await request("frame", { cwd: projectDir, timeline: TIMELINE, at: frame / fps, out });
  return relative(projectDir, result.path).split(sep).join("/");
}
