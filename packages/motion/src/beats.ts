// Beat helpers of the motion runtime (ADR 0029 decision 8, ADR 0033): pure functions of `t` over the grid the host
// puts in `window.frameshellTiming`. Seek-safe like the rest of the runtime: nothing is remembered between calls.
import { spring } from "@frameshell/schema/motion";

/** One beat of `window.frameshellTiming.beats`, as the plugin API's `RenderBeat` (structural copy: this package has no dependency on it). */
export interface TimingBeat {
  /** Composition seconds, the clock the page is seeked with. */
  readonly at: number;
  /** Number as `beat:N` names it. */
  readonly beat: number;
  /** Set when the beat starts a bar: the bar's number as `bar:N` names it. */
  readonly bar?: number;
}

/** One marker of `window.frameshellTiming.markers`. */
export interface TimingMarker {
  readonly at: number;
  readonly id: string;
  readonly label: string;
  readonly color?: string;
}

/** `window.frameshellTiming`, as a composition that asked with `<meta name="frameshell-timing" content="beats markers">` finds it. */
export interface FrameshellTiming {
  readonly beats?: readonly TimingBeat[];
  readonly tempo?: { readonly bpm: number; readonly meter: number };
  /** Stable code (`no-tempo`, `no-beats`, `low-confidence`...) of why `beats` is empty although asked. */
  readonly beatsProblem?: string;
  readonly markers?: readonly TimingMarker[];
}

/**
 * The grid a composition falls back to when the page has no usable beats (no `frameshell-timing` meta, no tempo on
 * the timeline, no measured music): beat `n` (0-based) at `offset + n * 60 / bpm` seconds. Without one the fallback is
 * the clip's own seconds, 60 BPM from 0 (beat `n` at second `n`).
 */
export interface NominalBeats {
  /** Beats per minute, above 0. Default 60. */
  readonly bpm?: number;
  /** Beats per bar. Default 4. */
  readonly meter?: number;
  /** Seconds of beat 0. Default 0. */
  readonly offset?: number;
  /** Seconds {@link beats} lists a nominal grid for. Default the composition root's `data-duration`. */
  readonly duration?: number;
}

/** Where `t` is on the grid: see {@link beatAt}. */
export interface BeatPosition {
  /** Beat the clip is on: 0 is the clip's first beat; negative before it. */
  readonly index: number;
  /** The same beat as `beat:N` numbers it (beat `index + 1` on a nominal grid). */
  readonly beat: number;
  /** The bar it falls in as `bar:N` numbers it; null when the clip holds no bar start to count from. */
  readonly bar: number | null;
  /** Fraction of the beat elapsed, 0 up to 1 (excluded). */
  readonly phase: number;
}

/** One beat of {@link beats}. */
export interface ListedBeat {
  /** Composition seconds. */
  readonly at: number;
  /** 0-based position in the list, what {@link sinceBeat} and {@link springOnBeat} call `n`. */
  readonly index: number;
  /** As `beat:N`. */
  readonly beat: number;
  /** Bar number when the beat starts a bar. */
  readonly bar?: number;
}

interface Grid {
  /** Seconds of beat `n`; beats outside the listed ones continue at the nearest period. */
  at(n: number): number;
  /** Greatest `n` with `at(n) <= t`. */
  indexAt(t: number): number;
  beat(n: number): number;
  bar(n: number): number | null;
}

const DEFAULT_METER = 4;

function timing(): FrameshellTiming | null {
  const found = (globalThis as { frameshellTiming?: FrameshellTiming }).frameshellTiming;
  return typeof found === "object" && found !== null ? found : null;
}

function usableBeats(from: FrameshellTiming | null): readonly TimingBeat[] | null {
  const list = from?.beats;
  if (from?.beatsProblem || !Array.isArray(list) || list.length === 0) return null;
  return list.every((beat) => Number.isFinite(beat.at)) ? list : null;
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function meterOf(meter: number | undefined): number {
  return Math.max(1, Math.round(positive(meter, DEFAULT_METER)));
}

function nominalGrid(nominal: NominalBeats | undefined): Grid {
  const period = 60 / positive(nominal?.bpm, 60);
  const meter = meterOf(nominal?.meter);
  const offset = Number.isFinite(nominal?.offset) ? nominal!.offset! : 0;
  return {
    at: (n) => offset + n * period,
    indexAt: (t) => Math.floor((t - offset) / period),
    beat: (n) => n + 1,
    bar: (n) => Math.floor(n / meter) + 1,
  };
}

function listedGrid(list: readonly TimingBeat[], tempo: FrameshellTiming["tempo"]): Grid {
  const last = list.length - 1;
  const tempoPeriod = tempo && tempo.bpm > 0 ? 60 / tempo.bpm : null;
  const gap = (from: number, to: number) => (to - from > 0 ? to - from : (tempoPeriod ?? 1));
  const before = list.length > 1 ? gap(list[0]!.at, list[1]!.at) : (tempoPeriod ?? 1);
  const after = list.length > 1 ? gap(list[last - 1]!.at, list[last]!.at) : (tempoPeriod ?? 1);
  const meter = meterOf(tempo?.meter);
  const start = list.find((beat) => beat.bar !== undefined);
  const beat = (n: number) => (n < 0 ? list[0]!.beat + n : n > last ? list[last]!.beat + (n - last) : list[n]!.beat);
  return {
    at: (n) => (n < 0 ? list[0]!.at + n * before : n > last ? list[last]!.at + (n - last) * after : list[n]!.at),
    indexAt(t) {
      if (t < list[0]!.at) return -Math.ceil((list[0]!.at - t) / before);
      if (t >= list[last]!.at) return last + Math.floor((t - list[last]!.at) / after);
      let [low, high] = [0, last];
      while (low < high) {
        const middle = (low + high + 1) >> 1;
        if (list[middle]!.at <= t) low = middle;
        else high = middle - 1;
      }
      return low;
    },
    beat,
    bar: (n) => (start ? start.bar! + Math.floor((beat(n) - start.beat) / meter) : null),
  };
}

function gridOf(nominal?: NominalBeats): Grid {
  const found = timing();
  const list = usableBeats(found);
  return list ? listedGrid(list, found!.tempo) : nominalGrid(nominal);
}

/** The raw `window.frameshellTiming` of the page (what the composition asked for), or null when the page has none. */
export function frameshellTiming(): FrameshellTiming | null {
  return timing();
}

/**
 * True when the page carries a beat grid of the timeline's music to use: the composition asked for `beats` and the
 * host found a usable grid. False means the helpers use the nominal fallback; `frameshellTiming()?.beatsProblem` says why.
 */
export function hasBeats(): boolean {
  return usableBeats(timing()) !== null;
}

/**
 * The beats of the clip, ascending, with their 0-based `index`. With the timeline's grid: those inside the clip
 * (composition seconds). Without it (no `frameshell-timing` meta, `beatsProblem` set, nothing asked): the `nominal`
 * grid up to `nominal.duration` (default the root's `data-duration`; `[]` there when none), or the clip's own
 * seconds, one beat a second, when no nominal is given.
 */
export function listBeats(nominal: NominalBeats | undefined, duration: number): readonly ListedBeat[] {
  const found = timing();
  const list = usableBeats(found);
  if (list) return list.map((beat, index) => ({ at: beat.at, index, beat: beat.beat, ...(beat.bar !== undefined ? { bar: beat.bar } : {}) }));
  const grid = nominalGrid(nominal);
  const span = nominal?.duration ?? duration;
  const out: ListedBeat[] = [];
  for (let n = Math.max(0, Math.ceil(grid.indexAt(0))); Number.isFinite(span) && grid.at(n) <= span && out.length < 100_000; n++) {
    const bar = grid.bar(n)!;
    out.push({ at: grid.at(n), index: n, beat: grid.beat(n), ...(grid.bar(n - 1) !== bar ? { bar } : {}) });
  }
  return out;
}

/**
 * Where `t` (clip seconds) is on the beat grid. Defined for every `t`: before the clip's first beat and after its last
 * the grid continues at its nearest period, so a spring started on beat -1 or beat 40 still has a time. Uses the
 * timeline's grid when the page has one, else `nominal` (see {@link NominalBeats}).
 */
export function beatAt(t: number, nominal?: NominalBeats): BeatPosition {
  const grid = gridOf(nominal);
  const index = grid.indexAt(t);
  const from = grid.at(index);
  return { index, beat: grid.beat(index), bar: grid.bar(index), phase: Math.min(Math.max((t - from) / (grid.at(index + 1) - from), 0), 1 - Number.EPSILON) };
}

/** Seconds at which beat `n` (0-based, as {@link ListedBeat.index}) falls; beats outside the clip continue at the nearest period. */
export function beatTime(n: number, nominal?: NominalBeats): number {
  return gridOf(nominal).at(n);
}

/**
 * Seconds since beat `n` at clip time `t`: negative before it, 0 on it. The pure form of "on beat n, do this": feed it
 * to an ease or a spring (`M.ease("enter", sinceBeat(t, n) / 0.2)`).
 */
export function sinceBeat(t: number, n: number, nominal?: NominalBeats): number {
  return t - gridOf(nominal).at(n);
}

/** A spring that starts at beat `n` (see {@link sinceBeat}) and moves from `from` to `to`; `from` before the beat. */
export function springOnBeat(preset: Parameters<typeof spring>[0], t: number, n: number, from = 0, to = 1, nominal?: NominalBeats): number {
  return spring(preset, sinceBeat(t, n, nominal), from, to);
}

/**
 * The timeline's markers inside the clip, ascending, in composition seconds; only those whose label equals `label`
 * (trimmed, case-insensitive) when one is given. `[]` when the page has no `markers` timing: markers have no nominal
 * fallback, so a composition that needs one keeps its own time as a prop.
 */
export function markers(label?: string): readonly TimingMarker[] {
  const list = timing()?.markers;
  if (!Array.isArray(list)) return [];
  const want = label?.trim().toLowerCase();
  return want === undefined ? list : list.filter((marker) => marker.label.trim().toLowerCase() === want);
}
