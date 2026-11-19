import type { RenderTiming, RenderTimingKind } from "@frameshell/plugin-api";

/** Clip prop by which a Remotion clip asks for the timeline's timing (ADR 0029 decision 8). */
export const TIMING_PROP = "timing";

/** Reserved `inputProps` key the timing arrives under, in renders and the live page alike. */
export const TIMING_INPUT = "frameshellTiming";

/** File in the Remotion project's `src/` that reads the timeline timing; `remotion new` writes it once. */
export const TIMING_HELPER_FILE = "frameshell-timing.ts";

/** Kinds `props.timing` may list, as `RenderTimingKind`. A copy of `RENDER_TIMING_KINDS` (a type-only import: installed plugins carry no plugin-api, ADR 0021); `timing-parity.test.ts` holds the two equal. */
export const TIMING_KINDS: readonly RenderTimingKind[] = ["beats", "markers", "words"];

const KINDS_EXAMPLE = '["beats", "markers"]';

const KINDS_LIST = `${TIMING_KINDS.slice(0, -1).map((k) => `"${k}"`).join(", ")} and/or "${TIMING_KINDS.at(-1)}"`;

/**
 * Issues with `props.timing` and the reserved input prop; empty when both are fine. `timing` must be a list of
 * known kinds. While a clip asks for timing, `inputProps.frameshellTiming` is refused (the host's data would
 * replace it); a clip that does not ask keeps its inputProps as they are.
 */
export function timingIssues(timing: unknown, inputProps: unknown): { message: string; path: string[] }[] {
  const issues: { message: string; path: string[] }[] = [];
  if (timing === undefined) return issues;
  if (!Array.isArray(timing)) {
    issues.push({ message: `timing must be a list of the timing the composition reads, e.g. ${KINDS_EXAMPLE}`, path: [TIMING_PROP] });
    return issues;
  }
  for (const kind of timing) {
    if (!TIMING_KINDS.includes(kind as RenderTimingKind)) {
      issues.push({ message: `unknown timing ${JSON.stringify(kind)}: use ${KINDS_LIST}, e.g. ${KINDS_EXAMPLE}`, path: [TIMING_PROP] });
    }
  }
  if (timing.length > 0 && typeof inputProps === "object" && inputProps !== null && TIMING_INPUT in inputProps) {
    issues.push({
      message: `inputProps.${TIMING_INPUT} is reserved: Frameshell puts the timeline's timing there while props.timing asks for it. Remove it, or drop props.timing`,
      path: ["inputProps", TIMING_INPUT],
    });
  }
  return issues;
}

/** The kinds `props.timing` lists, sorted, once each; none for a clip without it or with unknown words. */
export function timingKinds(props: { timing?: unknown } | undefined): RenderTimingKind[] {
  const listed = Array.isArray(props?.timing) ? (props.timing as unknown[]) : [];
  return TIMING_KINDS.filter((kind) => listed.includes(kind)).sort();
}

/** `inputProps` with the timeline's timing under {@link TIMING_INPUT}; the same object when there is none. */
export function withTiming(inputProps: Record<string, unknown>, timing: RenderTiming | undefined): Record<string, unknown> {
  return timing ? { ...inputProps, [TIMING_INPUT]: timing } : inputProps;
}

/**
 * Whether `source` is a Frameshell timing helper written before the `words` kind: it declares `FrameshellTiming`
 * but not `wordsProblem`. A file of the person's own (no such interface) is never outdated. Remotion projects are
 * not updated by Frameshell, so this only feeds a warning; the fields are added by hand.
 */
export function outdatedTimingHelper(source: string): boolean {
  return source.includes("export interface FrameshellTiming") && !source.includes("wordsProblem");
}

/** What to do about an {@link outdatedTimingHelper}, named for the project-relative `file`. */
export function outdatedTimingHelperAdvice(file: string): string {
  return `${file} predates transcript words: add FrameshellWord ({ at, end, text, id }) and \`words?\` and \`wordsProblem?\` to FrameshellTiming by hand, as the Remotion skill shows, before a composition reads them.`;
}

/**
 * Source of `src/frameshell-timing.ts` that `frameshell remotion new` writes into the Remotion project: the shape of
 * the data and one hook to read it. Seconds are composition seconds, so a beat is on frame `Math.round(at * fps)`.
 * No maths lives here: compare `frame / fps` with the beats.
 */
export const TIMING_HELPER_SOURCE = `// Timeline timing for a clip with props.timing, e.g. {"composition":"intro","timing":["beats","markers"]}.
// Frameshell passes it as the input prop ${TIMING_INPUT}. Times are composition seconds: frame / fps.
import { getInputProps, useVideoConfig } from "remotion";

export interface FrameshellBeat {
  /** Composition seconds. */
  at: number;
  /** Number as \`beat:N\` names it (counted from 1 in the music file). */
  beat: number;
  /** Bar number as \`bar:N\` names it, on the beat that starts a bar. */
  bar?: number;
}

export interface FrameshellMarker {
  at: number;
  id: string;
  label: string;
  color?: string;
}

export interface FrameshellWord {
  /** Composition seconds the word starts and ends. */
  at: number;
  end: number;
  /** As corrected in the transcript, else as transcribed. */
  text: string;
  /** Transcript word id, as \`word:w_000012\` names it. */
  id: string;
}

export interface FrameshellTiming {
  /** Present when the clip asked for "beats"; empty when there is no usable grid (see beatsProblem). */
  beats?: FrameshellBeat[];
  tempo?: { bpm: number; meter: number };
  /** Why beats is empty: no-tempo, no-music-clip, no-beats, broken-beats or low-confidence. */
  beatsProblem?: string;
  /** Present when the clip asked for "markers". */
  markers?: FrameshellMarker[];
  /** Present when the clip asked for "words": transcript words that start inside the clip; empty, see wordsProblem. */
  words?: FrameshellWord[];
  /** Why words is empty: no-transcript or stale-transcript. */
  wordsProblem?: string;
}

/**
 * The timing of this clip, or null when it did not ask (or in the Remotion Studio). Reads the composition's props
 * first; when its calculateMetadata returned props without the timing, falls back to the render's input props.
 */
export function useFrameshellTiming(): FrameshellTiming | null {
  const { props } = useVideoConfig();
  const fromProps = (props as Record<string, unknown>)["${TIMING_INPUT}"] as FrameshellTiming | undefined;
  return fromProps ?? ((getInputProps() as Record<string, unknown>)["${TIMING_INPUT}"] as FrameshellTiming | undefined) ?? null;
}
`;
