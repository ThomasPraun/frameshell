// Page runtime of the motion runtime (ADR 0033), bundled with the math of `@frameshell/schema/motion`
// into one script (`window.FrameshellMotion`) that HyperFrames compositions load from their own directory.
// It touches the page only through the structural types below, so it needs no DOM typings and tests run in Node.
export {
  DISTANCE_WEIGHTS,
  EASE_CURVES,
  ROLE_EASES,
  SPRING_PRESETS,
  STAGGER_MAX_TOTAL,
  STAGGER_STEPS,
  durationFromDistance,
  ease,
  settle,
  spring,
  springStep,
  stagger,
  track,
} from "@frameshell/schema/motion";

/** Version of this runtime; a composition's copy names it in its first line. */
export const version = "0.1.0";

/** Paints the whole composition at `t` seconds; must depend on nothing but `t`. */
export type Paint = (t: number) => void;

/**
 * What {@link bind} registers in `window.__timelines[compositionId]`: the
 * shape the HyperFrames runtime drives a root timeline through (it needs
 * `play` and `pause`, seeks with `seek(t)`), with no clock of its own.
 */
export interface MotionTimeline {
  play(): MotionTimeline;
  pause(): MotionTimeline;
  /** Paints `seconds` (clamped at 0) and remembers it. */
  seek(seconds: number): MotionTimeline;
  /** Last time painted, seconds. */
  time(): number;
  /** The root's declared `data-duration`, seconds (0 when missing). */
  duration(): number;
}

/** The parts of `window` the binding uses. */
interface MotionWindow {
  __timelines?: Record<string, unknown>;
  addEventListener(type: "hf-seek", listener: (event: { detail?: { time?: unknown } }) => void): void;
  document?: { querySelectorAll(selector: string): ArrayLike<{ getAttribute(name: string): string | null }> };
}

function declaredDuration(page: MotionWindow, compositionId: string): number {
  const roots = page.document?.querySelectorAll("[data-composition-id]");
  for (let i = 0; roots && i < roots.length; i++) {
    const root = roots[i]!;
    if (root.getAttribute("data-composition-id") === compositionId) return Number(root.getAttribute("data-duration")) || 0;
  }
  return 0;
}

/**
 * Binds `paint` to the HyperFrames clock of the composition whose root has
 * `data-composition-id="<compositionId>"` (the root must not carry
 * `data-no-timeline`). Call it synchronously from the composition's script:
 * it paints frame 0 at once, then registers a seek-only timeline in
 * `window.__timelines`, which renders and live preview seek frame by frame.
 * Until that timeline is first driven, the runtime's `hf-seek` event paints
 * instead, so a runtime that stops driving registered timelines still moves.
 */
export function bind(compositionId: string, paint: Paint): MotionTimeline {
  const page = globalThis as unknown as MotionWindow;
  const registry = (page.__timelines ??= {});
  if (registry[compositionId]) throw new Error(`window.__timelines["${compositionId}"] is already registered: bind one paint per composition`);
  let current = 0;
  let driven = false;
  const draw = (seconds: unknown) => {
    current = Math.max(0, Number(seconds) || 0);
    paint(current);
  };
  const timeline: MotionTimeline = {
    play: () => timeline,
    pause: () => timeline,
    seek(seconds) {
      driven = true;
      draw(seconds);
      return timeline;
    },
    time: () => current,
    duration: () => declaredDuration(page, compositionId),
  };
  draw(0);
  registry[compositionId] = timeline;
  page.addEventListener("hf-seek", (event) => {
    if (!driven) draw(event.detail?.time);
  });
  return timeline;
}

/**
 * Where an element is at one frame, relative to where its CSS puts it: pixels,
 * degrees, factors. Missing fields are the rest pose (0, 0, 0°, scale 1, opacity 1).
 */
export interface Pose {
  readonly x?: number;
  readonly y?: number;
  readonly rotate?: number;
  readonly scale?: number;
  readonly scaleX?: number;
  readonly scaleY?: number;
  /** 0 to 1, clamped: a spring that overshoots never makes an element more than opaque. */
  readonly opacity?: number;
}

/** An element as {@link write} sees it. */
export interface Writable {
  readonly style: { transform: string; opacity: string };
}

/** Fixed decimals: the same pose always writes the same string. */
const fixed = (value: number) => String(Math.round(value * 1000) / 1000);

/**
 * Writes `pose` to `element` as a 2D `transform` and `opacity`, every field
 * every time, so nothing from an earlier frame leaks into this one. Never the
 * `translate`, `scale` or `rotate` properties (element adjustments own them,
 * ADR 0021) and never 3D or `will-change` (they break frame-exact renders).
 */
export function write(element: Writable, pose: Pose): void {
  const scaleX = pose.scaleX ?? pose.scale ?? 1;
  const scaleY = pose.scaleY ?? pose.scale ?? 1;
  element.style.transform =
    `translate(${fixed(pose.x ?? 0)}px, ${fixed(pose.y ?? 0)}px) rotate(${fixed(pose.rotate ?? 0)}deg) scale(${fixed(scaleX)}, ${fixed(scaleY)})`;
  element.style.opacity = fixed(Math.min(1, Math.max(0, pose.opacity ?? 1)));
}
