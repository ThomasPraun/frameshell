// Keys and transition ramps (ADR 0018) as ffmpeg expressions and filters: the twins of `keyedValueAt`, `placementAt`,
// `gainAt`, `fadeWeight` and `dissolveWeights` in `@frameshell/schema`, pinned by test/export-animation.test.ts.
import { type Clip, type ClipKey, clipTime, keyedValueAt } from "@frameshell/schema";

/** Stable decimal text for args: at most 6 decimals, no trailing zeros. */
export function num(value: number): string {
  return String(Number(value.toFixed(6)));
}

/** Timeline second at which `clip` plays clip-clock second `at`: the inverse of `clipTime`. */
function timelineSecond(clip: Clip, at: number): number {
  const speed = "asset" in clip ? (clip.speed ?? 1) : 1;
  return clip.start + (at - (clip.in ?? 0)) / speed;
}

/** `f` (an expression, 0 to 1) through a key's ease, as `easeFraction` computes it. */
function eased(ease: ClipKey["ease"], f: string): string {
  switch (ease) {
    case "in":
      return `${f}*${f}`;
    case "out":
      return `${f}*(2-${f})`;
    case "in-out":
      return `${f}*${f}*(3-2*${f})`;
    default:
      return f;
  }
}

/**
 * ffmpeg expression of `keys` (on `clip`'s clock) at timeline second `time` (an expression), valid for timeline
 * seconds [`from`, `to`]: held before the first key and after the last, eased between, as `keyedValueAt`. Keys
 * outside the range are left out but for the one on each side; a value that cannot change there is a plain number.
 */
export function keyExpression(clip: Clip, keys: readonly ClipKey[], time: string, from: number, to: number): string {
  const timed = keys.map((key) => ({ ...key, time: timelineSecond(clip, key.at) }));
  const before = timed.filter((key) => key.time <= from).at(-1);
  const after = timed.find((key) => key.time >= to);
  const kept = [...(before ? [before] : []), ...timed.filter((key) => key.time > from && key.time < to), ...(after && after !== before ? [after] : [])];
  if (kept.every((key) => key.value === kept[0]!.value)) return num(kept[0]!.value);
  let line = num(kept.at(-1)!.value);
  for (let k = kept.length - 2; k >= 0; k--) {
    const a = kept[k]!;
    const b = kept[k + 1]!;
    const delta = b.value - a.value;
    const span =
      delta === 0
        ? num(a.value)
        : (a.ease ?? "linear") === "linear"
          ? `${num(a.value)}+${num(delta / (b.time - a.time))}*(${time}-${num(a.time)})`
          : `${num(a.value)}+${num(delta)}*(${eased(a.ease, `((${time}-${num(a.time)})/${num(b.time - a.time)})`)})`;
    line = `if(lt(${time},${num(b.time)}),${span},${line})`;
  }
  if (kept.length > 1) line = `if(lt(${time},${num(kept[0]!.time)}),${num(kept[0]!.value)},${line})`;
  return line;
}

/** A linear ramp of a clip's picture or sound: `in` rises from 0 to 1, `out` falls from 1 to 0, over [`start`, `start + length`). */
export interface Ramp {
  type: "in" | "out";
  /** Timeline seconds (pictures) or output samples from the item's start (sound). */
  start: number;
  length: number;
}

/**
 * `fade` filters multiplying a picture by `ramps` (timeline seconds; the frames' timestamps must be timeline
 * seconds): its alpha (`alpha: true`, layers) or towards black (the bottom track's concatenated clips).
 */
export function fadeFilters(ramps: readonly Ramp[], alpha: boolean): string[] {
  return ramps.map((ramp) => `fade=t=${ramp.type}${alpha ? ":alpha=1" : ""}:st=${num(ramp.start)}:d=${num(ramp.length)}`);
}

/**
 * `sendcmd` plus a named `colorchannelmixer` setting a layer's alpha gain to its keyed opacity on every frame of
 * timeline frames [`start`, `end`) (timestamps must be timeline seconds). Values come from `keyedValueAt` itself:
 * per frame commands measured as cheap as one `fade` and five times cheaper than a `geq` alpha expression.
 * A command takes effect half a frame before its frame, so timestamp rounding never delays it.
 */
export function keyedOpacity(clip: Clip, keys: readonly ClipKey[], start: number, end: number, fps: number, name: string): string {
  const value = (frame: number) => keyedValueAt(keys, clipTime(clip, frame / fps))!;
  const first = value(start);
  const commands: string[] = [];
  let last = first;
  for (let frame = start + 1; frame < end; frame++) {
    const v = value(frame);
    if (num(v) === num(last)) continue;
    commands.push(`${num((frame - 0.5) / fps)} [enter] colorchannelmixer@${name} aa ${num(v)}`);
    last = v;
  }
  const mixer = `colorchannelmixer@${name}=aa=${num(first)}`;
  return commands.length === 0 ? mixer : `sendcmd=c='${commands.join(";")}',${mixer}`;
}

/** `volume` filter in dB of an `ffmpeg` expression (`eval=frame`: per audio frame). */
export function gainVolume(decibels: string): string {
  return `volume='pow(10,(${decibels})/20)':eval=frame`;
}

/** Output samples per audio frame under keyed gain: `volume` evaluates once per frame, so 64 samples keep steps under 1.4 ms. */
export const GAIN_FRAME_SAMPLES = 64;
