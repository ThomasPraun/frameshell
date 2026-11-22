import { basename } from "node:path";
import {
  ANALYZE_CUT_KINDS,
  ANALYZE_EVENT_KINDS,
  type AnalyzeLayer,
  type AnalyzeResultShape,
  labelOf,
} from "@frameshell/protocol";

// The layers an agent reads an analysis by (#801): a short card first, then one line per shot, then every value. Pure:
// the result in, Markdown out. Each line carries the label of what it reports, the same words as `labels`.

/** File names of the layers in the analysis folder, next to `analysis.json`. */
export const CARD_FILE = "card.md";
export const SHOTS_FILE = "shots.md";

type Measured = Omit<AnalyzeResultShape, "card" | "layers">;

const percent = (share: number) => `${Math.round(share * 100)}%`;
const tag = (result: Measured, path: string) => `[${labelOf(result.labels, path) ?? "?"}]`;

/** About how many tokens a text of `bytes` costs: 4 bytes a token, rounded up. */
export function tokensOf(bytes: number): number {
  return Math.ceil(bytes / 4);
}

/** A layer entry for a file of `bytes` bytes. */
export function layer(file: string, bytes: number, holds: string): AnalyzeLayer {
  return { file, bytes, tokens: tokensOf(bytes), holds };
}

/** `shots.md`: one line per shot, so an agent finds the shot it needs without reading every value. */
export function shotsMarkdown(result: Measured): string {
  const lines = [
    `# Shots of ${result.name}`,
    "",
    `One line per shot: number, start-end s (length), the three biggest colours, brightness and warmth ${tag(result, "shots[].look")}, the most of the picture graphics cover ${tag(result, "shots[].ink")}.`,
    "",
  ];
  for (const shot of result.shots) {
    const colours = shot.palette.slice(0, 3).map((color) => color.hex).join(" ") || "-";
    const ink = shot.ink.peak > 0 ? percent(shot.ink.peak) : "-";
    lines.push(`- #${shot.index} ${shot.start}-${shot.end} s (${shot.length} s)  ${colours}  bright ${shot.look.brightness} warm ${shot.look.warmth}  ink ${ink}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * `card.md`: the film in about 300 tokens, every line labelled, then the layers to open next with their size. `layers`
 * are the other files, smallest first.
 */
export function cardMarkdown(result: Measured, layers: readonly AnalyzeLayer[]): string {
  const { stats, rhythm, look, curve } = result;
  const lines = [
    `# Analysis ${result.name}: ${basename(result.file)}`,
    "",
    `${result.duration} s, ${result.width}x${result.height} at ${result.fps} fps. Read this card first; open a layer below only for what you need.`,
    "",
    `- ${tag(result, "stats")} Cutting: ${stats.shotCount} shots, ${stats.cutsPerMinute} cuts a minute, median ${stats.medianLength} s (${stats.shortest} to ${stats.longest} s).`,
    `- ${tag(result, "rhythm")} Rhythm: shot-length CV ${rhythm.shotLengthCv}, ${percent(rhythm.stillShare)} still, ${rhythm.changesPerMinute} big changes a minute, ${rhythm.bursts.length} bursts.`,
    `- ${tag(result, "cuts")} Cut kinds: ${countsOf(ANALYZE_CUT_KINDS.map((kind) => [kind, result.cuts.counts[kind]] as const))}; ${result.cuts.jumpsPerMinute} jumps and punches a minute.`,
    `- ${tag(result, "events")} Events: ${countsOf(ANALYZE_EVENT_KINDS.map((kind) => [kind, result.events.filter((event) => event.kind === kind).length] as const))}.`,
    `- ${tag(result, "look")} Look: brightness ${look.brightness}, contrast ${look.contrast}, saturation ${look.saturation}, warmth ${look.warmth}. ${tag(result, "palette")} Palette: ${result.palette.slice(0, 3).map((color) => `${color.hex} ${percent(color.share)}`).join(", ") || "none"}.`,
    `- ${tag(result, "curve")} Motion: mean change ${curve.mean}, peak at ${curve.peakAt} s, ${curve.moves.length} moves. ${tag(result, "ink")} Ink: ${percent(result.ink.mean)} of the picture on average.`,
  ];
  const sound: string[] = [];
  if (result.loudness) sound.push(`${tag(result, "loudness")} ${result.loudness.integrated === null ? "silent" : `${result.loudness.integrated} LUFS`}`);
  if (result.tempo) sound.push(`${tag(result, "tempo")} ${result.tempo.bpm} BPM${result.tempo.low ? " (low confidence)" : ""}`);
  if (result.audio) {
    const { speech } = result.audio;
    sound.push(`${tag(result, "audio")} ${speech.status === "measured" ? `${speech.sentences.length} sentences, ${speech.words} words` : "speech skipped"}, ${result.audio.sections.length} sections`);
  }
  lines.push(`- Sound: ${sound.length > 0 ? sound.join("; ") : "none"}.`);
  if (result.suggestions.length > 0) lines.push(`- ${tag(result, "suggestions")} Style suggestions, never applied: ${result.suggestions.map((suggestion) => suggestion.path).join(", ")}.`);
  if (result.warnings.length > 0) lines.push(`- ${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}: ${result.warnings[0]}${result.warnings.length > 1 ? " (the rest in analysis.json)" : ""}`);
  lines.push("", "## Layers", "");
  for (const entry of layers) lines.push(`- \`${entry.file}\`: ${entry.holds} (${entry.bytes} bytes, about ${entry.tokens} tokens)`);
  if (result.sheets.length > 0) lines.push(`- Images: ${result.sheets.map((sheet) => `\`${basename(sheet.path)}\``).join(", ")} (look at them for what a number cannot say)`);
  return `${lines.join("\n")}\n`;
}

function countsOf(entries: readonly (readonly [string, number])[]): string {
  return entries.filter(([, count]) => count > 0).map(([kind, count]) => `${count} ${kind}`).join(", ") || "none";
}

/** What each layer after the card holds. */
export const LAYER_HOLDS = {
  shots: "one line per shot: times, colours, look, ink",
  full: "every value with its label, the cuts, events, moves, sentences and beat lists",
} as const;
