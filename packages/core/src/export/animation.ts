// Keys and transition ramps (ADR 0018) as ffmpeg expressions and filters: the twins of `keyedValueAt`, `placementAt`,
// `gainAt`, `fadeWeight` and `dissolveWeights` in `@frameshell/schema`, pinned by test/export-animation.test.ts.
import { type Clip, type ClipKey, type ClipKeys, type NestHost, nestingOf, placementAt, placementOf } from "@frameshell/schema";

/** Stable decimal text for args: at most 6 decimals, no trailing zeros. */
export function num(value: number): string {
  return String(Number(value.toFixed(6)));
}

/** How a clock that keys count on (a clip's own, or a nested clip's) runs against timeline seconds. */
export interface KeyClock {
  start: number;
  in?: number | undefined;
  speed?: number | undefined;
}

/** Timeline second at which `clock` reads clock second `at`: the inverse of `clipTime`. */
function timelineSecond(clock: KeyClock, at: number): number {
  return clock.start + (at - (clock.in ?? 0)) / (clock.speed ?? 1);
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
export function keyExpression(clip: KeyClock, keys: readonly ClipKey[], time: string, from: number, to: number): string {
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
 * ffmpeg expressions of `clip`'s `x`, `y` and `scale` at timeline second `time` (an expression), valid for timeline
 * seconds [`from`, `to`], as `placementAt` composes them: its own keys or transform inside each host's
 * (`composePlacement`: offsets scale with the host's scale and add, scales multiply). What cannot change is a number.
 */
export function placementExpressions(clip: Clip, time: string, from: number, to: number): { x: string; y: string; scale: string } {
  const value = (clock: KeyClock, keys: readonly ClipKey[] | undefined, fixed: number) => (keys ? keyExpression(clock, keys, time, from, to) : num(fixed));
  const own = placementOf(clip.transform);
  let x = value(clip, clip.keys?.x, own.x);
  let y = value(clip, clip.keys?.y, own.y);
  let scale = value(clip, clip.keys?.scale, own.scale);
  const hosts = nestingOf(clip)?.hosts ?? [];
  for (let i = hosts.length - 1; i >= 0; i--) {
    const host = hosts[i]!;
    const clock = hostClock(host);
    const base = placementOf(host.transform);
    const hostScale = value(clock, host.keys?.scale, base.scale);
    x = plus(value(clock, host.keys?.x, base.x), times(x, hostScale));
    y = plus(value(clock, host.keys?.y, base.y), times(y, hostScale));
    scale = times(hostScale, scale);
  }
  return { x, y, scale };
}

/**
 * ffmpeg expression of `clip`'s gain in dB at timeline second `time` (an expression), valid for timeline seconds
 * [`from`, `to`], as `gainAt` sums it: its own keys or `audio.gain`, plus each host's.
 */
export function gainExpression(clip: Clip, time: string, from: number, to: number): string {
  const value = (clock: KeyClock, keys: ClipKeys | undefined, fixed: number) => (keys?.gain ? keyExpression(clock, keys.gain, time, from, to) : num(fixed));
  let gain = value(clip, clip.keys, clip.audio?.gain ?? 0);
  for (const host of nestingOf(clip)?.hosts ?? []) gain = plus(gain, value(hostClock(host), host.keys, host.gain ?? 0));
  return gain;
}

/** A nested clip's own clock: nested-timeline seconds, its `in` at its window's start. */
function hostClock(host: NestHost): KeyClock {
  return { start: host.start, in: host.in };
}

/** True for a plain number as {@link num} writes it, not an expression. */
function isNumber(expression: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(expression);
}

function plus(a: string, b: string): string {
  if (isNumber(a) && isNumber(b)) return num(Number(a) + Number(b));
  if (a === "0") return b;
  if (b === "0") return a;
  return `(${a})+(${b})`;
}

function times(a: string, b: string): string {
  if (isNumber(a) && isNumber(b)) return num(Number(a) * Number(b));
  if (a === "0" || b === "0") return "0";
  if (a === "1") return b;
  if (b === "1") return a;
  return `(${a})*(${b})`;
}

/**
 * `sendcmd` plus a named `colorchannelmixer` setting a layer's alpha gain to its keyed opacity on every frame of
 * timeline frames [`start`, `end`) (timestamps must be timeline seconds). Values come from `placementAt` itself,
 * hosts composed: per frame commands measured as cheap as one `fade` and five times cheaper than a `geq` alpha
 * expression. A command takes effect half a frame before its frame, so timestamp rounding never delays it.
 */
export function keyedOpacity(clip: Clip, start: number, end: number, fps: number, name: string): string {
  const value = (frame: number) => placementAt(clip, frame / fps).opacity;
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

/** `volume` filter in dB of an `ffmpeg` expression, times `factor` when given (`eval=frame`: per audio frame). */
export function gainVolume(decibels: string, factor?: string): string {
  return `volume='pow(10,(${decibels})/20)${factor ? `*${factor}` : ""}':eval=frame`;
}

/** Output samples per audio frame under keyed gain: `volume` evaluates once per frame, so 64 samples keep steps under 1.4 ms. */
export const GAIN_FRAME_SAMPLES = 64;
