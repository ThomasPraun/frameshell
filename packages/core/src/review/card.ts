import { basename } from "node:path";
import type { AnalyzeLayer, ReviewResultShape } from "@frameshell/protocol";

// The card an agent reads a review by (#801), as `analyze` has: the verdict and what to fix in about 300 tokens, then
// the files to open with their size. Pure: the result in, Markdown out. Each line says how its number was got:
// MEASURED (every frame or the decoded sound), ESTIMATED (samples, or a timeline's sound from clip envelopes),
// DECISION (the project's `requirements.json` judged).

/** File name of the card in the review folder, next to `review.json` and `metrics.json`. */
export const REVIEW_CARD_FILE = "card.md";

/** Craft warnings listed on the card; the rest are in `metrics.json`. */
export const CARD_WARNINGS = 6;

/** What each layer after the card holds. */
export const REVIEW_LAYER_HOLDS = {
  review: "the sheets with every tile's time, the fastest moments, the safe-zone flags",
  metrics: "every number, every craft warning and waiver, the requirements checks, the sound review",
} as const;

type Reviewed = Omit<ReviewResultShape, "card" | "layers">;

const span = (from: number | null, to: number | null) => (from === null ? "whole film" : to === null || to === from ? `${from} s` : `${from}-${to} s`);
const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** `card.md`: the verdict, the warnings to fix first, the key numbers, then `layers` (smallest first) and the images. */
export function reviewCardMarkdown(result: Reviewed, layers: readonly AnalyzeLayer[]): string {
  const what = result.source === "file" ? basename(result.file ?? "") : `timeline ${result.timeline}`;
  const lines = [
    `# Review ${result.run} of ${what}`,
    "",
    `${result.range.from} to ${result.range.to} s, ${result.width}x${result.height} at ${result.fps} fps. Read this card first; open a layer below only for what you need.`,
    "",
  ];
  const { metrics } = result;
  if (metrics) {
    const { picture, requirements, craft } = metrics;
    const sampled = picture.sampled ? "[ESTIMATED]" : "[MEASURED]";
    if (requirements) {
      const count = (status: string) => requirements.checks.filter((check) => check.status === status).length;
      lines.push(
        `- [DECISION] Requirements (${requirements.file}): ${requirements.failed === 0 ? "pass" : `FAIL, ${requirements.failed} failed`}; ${count("pass")} checks pass, ${count("fail")} fail, ${count("skipped")} skipped.`,
      );
      for (const check of requirements.checks.filter((each) => each.status === "fail").slice(0, 3)) lines.push(`  - ${check.id}${check.clip ? ` ${check.clip}` : ""}: ${cut(check.message, 110)}`);
    } else lines.push("- [DECISION] Requirements: the project has no `requirements.json`.");
    const fails = craft.filter((warning) => warning.severity === "fail").length;
    lines.push(`- ${sampled} Craft warnings: ${craft.length}${fails > 0 ? ` (${fails} fail)` : ""}${metrics.waived.length > 0 ? `, ${metrics.waived.length} waived` : ""}.`);
    // Failing ones first, then in film order.
    const shown = [...craft].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "fail" ? -1 : 1)).slice(0, CARD_WARNINGS);
    for (const warning of shown) lines.push(`  - ${warning.severity === "fail" ? "FAIL " : ""}${warning.check} ${span(warning.from, warning.to)}${warning.clip ? ` (${warning.clip})` : ""}: ${cut(warning.message, 110)}`);
    if (craft.length > shown.length) lines.push(`  - ${craft.length - shown.length} more in metrics.json (craft).`);
    const still = picture.longestStatic ? `${picture.longestStatic.seconds} s at ${picture.longestStatic.from} s` : "none";
    const gap = picture.largestGap ? `${picture.largestGap.seconds} s` : "none";
    lines.push(`- ${sampled} Picture (${picture.samples} ${picture.sampled ? "samples" : "frames"}): longest still ${still}, largest gap between events ${gap}, ${picture.events} events, ${picture.blank.length} near-blank stretches.`);
    lines.push(`- [${metrics.rhythm.label}] Rhythm: shot-length CV ${metrics.rhythm.shotLengthCv}, ${Math.round(metrics.rhythm.stillShare * 100)}% still, ${metrics.rhythm.bursts.length} bursts.`);
    const sound: string[] = [];
    if (metrics.loudness) sound.push(`[MEASURED] ${metrics.loudness.integrated === null ? "silent" : `${metrics.loudness.integrated} LUFS`}`);
    if (metrics.sound) sound.push(`${metrics.sound.source === "file" ? "[MEASURED]" : "[ESTIMATED]"} sound review of the ${metrics.sound.source === "file" ? "mix" : "clips"}`);
    if (metrics.subtitles) sound.push(`${metrics.subtitles.cues} subtitle cues, ${metrics.subtitles.shortCues.length} too short to read`);
    if (sound.length > 0) lines.push(`- Sound and words: ${sound.join("; ")}.`);
  } else lines.push("- No metrics: `metrics` was not among the outputs asked for.");
  if (result.peaks.length > 0) lines.push(`- [MEASURED] Fastest moments: ${result.peaks.slice(0, 3).map((peak) => `${peak.at} s`).join(", ")}.`);
  for (const zone of result.safeZones) lines.push(`- Safe zones ${zone.platform}: ${zone.flags.length === 0 ? "nothing crosses" : `${zone.flags.length} crossing${zone.flags.length === 1 ? "" : "s"}`}.`);
  if (result.warnings.length > 0) lines.push(`- ${result.warnings.length} note${result.warnings.length === 1 ? "" : "s"}: ${cut(result.warnings[0]!, 110)}${result.warnings.length > 1 ? " (the rest in review.json)" : ""}`);
  lines.push("", "## Layers", "");
  for (const entry of layers) lines.push(`- \`${entry.file}\`: ${entry.holds} (${entry.bytes} bytes, about ${entry.tokens} tokens)`);
  if (result.sheets.length > 0) {
    const kinds = [...new Set(result.sheets.map((sheet) => sheet.kind))];
    lines.push(`- Images (${result.sheets.length}, ${kinds.join(", ")}): ${result.sheets.slice(0, 8).map((sheet) => `\`${basename(sheet.path)}\``).join(", ")}${result.sheets.length > 8 ? ", …" : ""} (look at them for what a number cannot say)`);
  }
  return `${lines.join("\n")}\n`;
}
