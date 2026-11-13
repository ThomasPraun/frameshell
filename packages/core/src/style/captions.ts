import { join } from "node:path";
import { type CaptionTokens, type Timeline, resolveStyle, styleCaptionTokens } from "@frameshell/schema";
import { fontFileMetrics } from "../export/font-metrics.js";
import { readStyleFile } from "./read.js";

/**
 * What the project's `style.json` gives the captions of `timeline` (ADR 0028 decision 11), the caption face's
 * metrics read from its font file: `tokens` undefined when the timeline has no subtitle track or the project no
 * style. A face that cannot be used becomes the bundled one, with a warning. Throws `InvalidProjectFile` for an
 * invalid `style.json` only when it would be used.
 */
export async function readCaptionTokens(root: string, timeline: Timeline): Promise<{ tokens?: CaptionTokens; warnings: string[] }> {
  if (!timeline.tracks.some((track) => track.kind === "subtitles")) return { warnings: [] };
  const file = await readStyleFile(root);
  if (!file) return { warnings: [] };
  const { tokens, warning } = await styleCaptionTokens(resolveStyle(file), (font) => fontFileMetrics(join(root, ...font.split("/"))));
  return { tokens, warnings: warning ? [warning] : [] };
}
