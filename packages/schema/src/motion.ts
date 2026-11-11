// Motion math (ADR 0033): springs, eases, stagger and duration rules as pure functions of time.
// The one source for these numbers: `@frameshell/motion` bundles this file into the page runtime
// that HyperFrames compositions load, so it imports nothing and never reads a clock or a random source.

/**
 * A damped spring: `response` is the period of the undamped oscillation in
 * seconds (how quick), `damping` the damping ratio ζ (how bouncy): 1 never
 * overshoots, 0.7 to 0.85 barely, 0.4 to 0.6 bounces, under 0.3 looks cartoonish.
 */
export interface SpringParams {
  /** Period of the undamped oscillation, seconds, greater than 0. */
  readonly response: number;
  /** Damping ratio ζ, greater than 0: below 1 overshoots, 1 is critical, above 1 creeps in. */
  readonly damping: number;
}

/** Named springs; the comment on each gives the overshoot of a step. */
export const SPRING_PRESETS = {
  /** About 1.5 % overshoot: small UI moves, feedback. */
  snappy: { response: 0.22, damping: 0.8 },
  /** About 0.5 % overshoot: most arrivals. */
  default: { response: 0.4, damping: 0.86 },
  /** No overshoot: large or premium moves. */
  heavy: { response: 0.5, damping: 1 },
  /** About 20 % overshoot: celebration, playful styles. */
  playful: { response: 0.5, damping: 0.45 },
} as const satisfies Record<string, SpringParams>;

/** Name of a {@link SPRING_PRESETS} entry. */
export type SpringPresetId = keyof typeof SPRING_PRESETS;

/** A spring by preset name or by its own parameters. */
export type SpringLike = SpringPresetId | SpringParams;

/** Position and velocity (units per second) of a moving value at one time. */
export interface MotionSample {
  readonly value: number;
  readonly velocity: number;
}

/** ζ within this of 1 uses the critically damped form: the other two divide by √|1 − ζ²|. */
const CRITICAL_BAND = 1e-6;

function springParams(spring: SpringLike): SpringParams {
  const params = typeof spring === "string" ? SPRING_PRESETS[spring] : spring;
  if (!params) throw new Error(`Unknown spring preset ${String(spring)}; use one of ${Object.keys(SPRING_PRESETS).join(", ")}`);
  if (!(params.response > 0) || !(params.damping > 0)) {
    throw new Error(`A spring needs response > 0 and damping > 0, got response ${params.response}, damping ${params.damping}`);
  }
  return params;
}

/**
 * Unit step response of a spring at `t` seconds after it starts: the value
 * goes from 0 to 1 starting at rest, closed form for under-, critically and
 * over-damped springs. Before the start (`t <= 0`) it is 0 at rest.
 */
export function springStep(spring: SpringLike, t: number): MotionSample {
  const { response, damping: z } = springParams(spring);
  if (!(t > 0)) return { value: 0, velocity: 0 };
  const w = (2 * Math.PI) / response;
  if (Math.abs(z - 1) < CRITICAL_BAND) {
    const decay = Math.exp(-w * t);
    return { value: 1 - (1 + w * t) * decay, velocity: w * w * t * decay };
  }
  if (z < 1) {
    const wd = w * Math.sqrt(1 - z * z);
    const decay = Math.exp(-z * w * t);
    const cos = Math.cos(wd * t);
    const sin = Math.sin(wd * t);
    return { value: 1 - decay * (cos + ((z * w) / wd) * sin), velocity: decay * ((w * w) / wd) * sin };
  }
  // Over-damped: two real decaying modes r1 (slow) and r2 (fast), starting at -1 with no velocity.
  const root = Math.sqrt(z * z - 1);
  const r1 = -w * (z - root);
  const r2 = -w * (z + root);
  const c2 = r1 / (r2 - r1);
  const c1 = -1 - c2;
  const e1 = Math.exp(r1 * t);
  const e2 = Math.exp(r2 * t);
  return { value: 1 + c1 * e1 + c2 * e2, velocity: r1 * c1 * e1 + r2 * c2 * e2 };
}

/** Value of a spring moving from `from` to `to`, `t` seconds after it starts at rest. */
export function spring(preset: SpringLike, t: number, from = 0, to = 1): number {
  return from + (to - from) * springStep(preset, t).value;
}

/**
 * Seconds until a step stays within `eps` (a fraction of the distance) of
 * its target for good: the lead-in a spring needs before the next beat.
 */
export function settle(preset: SpringLike, eps = 0.001): number {
  if (!(eps > 0 && eps < 1)) throw new Error(`settle takes eps between 0 and 1 (a fraction of the distance), got ${eps}`);
  const { response, damping: z } = springParams(preset);
  const w = (2 * Math.PI) / response;
  // An upper bound of the distance left, falling for good: once it is under eps, so is the spring.
  let bound: (t: number) => number;
  if (Math.abs(z - 1) < CRITICAL_BAND) {
    bound = (t) => (1 + w * t) * Math.exp(-w * t);
  } else if (z < 1) {
    bound = (t) => Math.exp(-z * w * t) / Math.sqrt(1 - z * z);
  } else {
    const root = Math.sqrt(z * z - 1);
    const r1 = -w * (z - root);
    const r2 = -w * (z + root);
    const c2 = r1 / (r2 - r1);
    bound = (t) => Math.abs(-1 - c2) * Math.exp(r1 * t) + Math.abs(c2) * Math.exp(r2 * t);
  }
  const step = response / 2000;
  let last = 0;
  for (let i = 1; i < 10_000_000; i++) {
    const t = i * step;
    if (Math.abs(1 - springStep(preset, t).value) > eps) last = t;
    else if (bound(t) <= eps) return last + step;
  }
  return last + step;
}

/** One retarget of {@link track}: from second `at` the value heads to `to`. */
export interface TrackMove {
  readonly at: number;
  readonly to: number;
}

/**
 * A value that starts at rest on `start` and is retargeted at each move's
 * `at` (seconds, any order). By superposition: each move adds a spring step
 * of its change of target, and a step starts at 0 with no velocity, so
 * position and velocity stay continuous through every retarget.
 */
export function track(preset: SpringLike, start: number, moves: readonly TrackMove[]): (t: number) => MotionSample {
  springParams(preset);
  const sorted = [...moves].sort((a, b) => a.at - b.at);
  const steps = sorted.map((move, i) => ({ at: move.at, delta: move.to - (i === 0 ? start : sorted[i - 1]!.to) }));
  return (t) => {
    let value = start;
    let velocity = 0;
    for (const { at, delta } of steps) {
      if (t <= at) break;
      const step = springStep(preset, t - at);
      value += delta * step.value;
      velocity += delta * step.velocity;
    }
    return { value, velocity };
  };
}

/** A CSS `cubic-bezier(x1, y1, x2, y2)` curve; x1 and x2 within 0 to 1. */
export type CubicBezier = readonly [x1: number, y1: number, x2: number, y2: number];

/** Named curves (CSS `cubic-bezier` control points). */
export const EASE_CURVES = {
  "out-expo": [0.16, 1, 0.3, 1],
  "out-quint": [0.22, 1, 0.36, 1],
  "in-out-quart": [0.76, 0, 0.24, 1],
  "in-expo": [0.7, 0, 0.84, 0],
  "out-back": [0.34, 1.56, 0.64, 1],
  linear: [0, 0, 1, 1],
} as const satisfies Record<string, CubicBezier>;

/** Name of an {@link EASE_CURVES} entry. */
export type EaseCurveId = keyof typeof EASE_CURVES;

/**
 * Curve per role: one ease on every move reads as generated. Arrivals have a
 * long tail, camera moves and colour floods ease both ways, exits and
 * zoom-throughs accelerate away; linear only for rotation, progress and loop phase.
 */
export const ROLE_EASES = {
  enter: "out-quint",
  snap: "out-expo",
  pop: "out-back",
  camera: "in-out-quart",
  color: "in-out-quart",
  exit: "in-expo",
  progress: "linear",
} as const satisfies Record<string, EaseCurveId>;

/** Name of a {@link ROLE_EASES} entry. */
export type EaseRole = keyof typeof ROLE_EASES;

/** An ease by role, by curve name, or by its control points. */
export type EaseLike = EaseRole | EaseCurveId | CubicBezier;

function curveOf(ease: EaseLike): CubicBezier {
  if (typeof ease !== "string") return ease;
  if (ease in ROLE_EASES) return EASE_CURVES[ROLE_EASES[ease as EaseRole]];
  const curve = EASE_CURVES[ease as EaseCurveId];
  if (!curve) throw new Error(`Unknown ease ${ease}; use a role (${Object.keys(ROLE_EASES).join(", ")}) or a curve (${Object.keys(EASE_CURVES).join(", ")})`);
  return curve;
}

/** `f` (0 to 1, clamped) through `ease`, as CSS evaluates a `cubic-bezier` timing function. */
export function ease(curve: EaseLike, f: number): number {
  const [x1, y1, x2, y2] = curveOf(curve);
  if (!(f > 0)) return 0;
  if (f >= 1) return 1;
  const bez = (a: number, b: number, s: number) => 3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;
  // Solve x(s) = f: Newton from s = f, then bisection when the slope is too flat to trust.
  let s = f;
  for (let i = 0; i < 8; i++) {
    const dx = 3 * (1 - s) ** 2 * x1 + 6 * (1 - s) * s * (x2 - x1) + 3 * s * s * (1 - x2);
    if (Math.abs(dx) < 1e-6) break;
    s -= (bez(x1, x2, s) - f) / dx;
  }
  if (!(s >= 0 && s <= 1) || Math.abs(bez(x1, x2, s) - f) > 1e-7) {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 60; i++) {
      s = (lo + hi) / 2;
      if (bez(x1, x2, s) < f) lo = s;
      else hi = s;
    }
  }
  return bez(y1, y2, s);
}

/** Usual delay between neighbours, seconds: letters, words, list items. */
export const STAGGER_STEPS = { letters: 0.03, words: 0.08, items: 0.06 } as const;

/** Longest a whole stagger should take, seconds: longer reads as a queue, not one gesture. */
export const STAGGER_MAX_TOTAL = 0.5;

/** Options of {@link stagger}. */
export interface StaggerOptions {
  /** Which item goes first: `start` (default), `end`, or `center` (outwards). */
  readonly from?: "start" | "end" | "center";
  /** Cap of the whole stagger in seconds; the step shrinks to fit. Default {@link STAGGER_MAX_TOTAL}. */
  readonly maxTotal?: number;
}

/** Delay in seconds of item `index` of `count`, `step` seconds apart (shrunk so the whole stays within `maxTotal`). */
export function stagger(index: number, count: number, step: number, options: StaggerOptions = {}): number {
  if (count <= 1) return 0;
  const from = options.from ?? "start";
  const order = from === "end" ? count - 1 - index : from === "center" ? Math.abs(index - (count - 1) / 2) : index;
  const span = from === "center" ? (count - 1) / 2 : count - 1;
  const fitted = Math.min(step, (options.maxTotal ?? STAGGER_MAX_TOTAL) / span);
  return order * fitted;
}

/** Duration multiplier by how heavy a moving thing should feel. */
export const DISTANCE_WEIGHTS = { light: 0.7, normal: 1, heavy: 1.35 } as const;

/**
 * Seconds a move of `px` pixels should take: (9 + 1.15·√px) frames at 60 fps,
 * times the weight. Longer moves take longer, but less than in proportion.
 */
export function durationFromDistance(px: number, weight: keyof typeof DISTANCE_WEIGHTS = "normal"): number {
  return ((9 + 1.15 * Math.sqrt(Math.abs(px))) * DISTANCE_WEIGHTS[weight]) / 60;
}
