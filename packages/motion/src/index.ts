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
export const version = "0.2.0";

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

declare const window: MotionWindow | undefined;

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
  // The HyperFrames linter looks for this exact registration in a composition's scripts (missing_timeline_registry).
  if (typeof window !== "undefined") window.__timelines ??= {};
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

/** Frame shape a layout is written for: `wide` is 16:9 and wider, `tall` is 4:5 and narrower, `square` is between. */
export type FormatClass = "wide" | "square" | "tall";

/** The class of a frame by its aspect ratio (width / height): above 1.2 wide, below 0.9 tall. */
export function formatClass(width: number, height: number): FormatClass {
  const ratio = width / height;
  return ratio > 1.2 ? "wide" : ratio < 0.9 ? "tall" : "square";
}

/** What the composition root declares: the frame it renders at and how long it plays. */
export interface Stage {
  /** `data-width`, pixels. */
  readonly width: number;
  /** `data-height`, pixels. */
  readonly height: number;
  /** `data-duration`, seconds. */
  readonly duration: number;
  /** Class of the frame, from its aspect ratio. */
  readonly format: FormatClass;
}

/** The parts of `window` the stage and props helpers read. */
interface PageWindow {
  document?: {
    documentElement: { getAttribute(name: string): string | null };
    querySelector(selector: string): { getAttribute(name: string): string | null } | null;
  };
  __hyperframes?: { getVariables?: () => Record<string, unknown> };
}

/**
 * The first composition root's declared size and length. The frame is the
 * root's `data-width` / `data-height`, so a layout that reads it follows the
 * size the composition is rendered at (format injection, ADR 0033 slice 4,
 * will set that size per format).
 */
export function stage(): Stage {
  const root = (globalThis as unknown as PageWindow).document?.querySelector("[data-composition-id]");
  const width = Number(root?.getAttribute("data-width"));
  const height = Number(root?.getAttribute("data-height"));
  if (!(width > 0 && height > 0)) throw new Error("stage(): no [data-composition-id] root with data-width and data-height");
  return { width, height, duration: Number(root?.getAttribute("data-duration")) || 0, format: formatClass(width, height) };
}

/** `wide`, `square` or `tall` by the frame the composition renders at: lays out one thing per format. */
export function pick<T>(wide: T, square: T, tall: T): T {
  const { format } = stage();
  return format === "wide" ? wide : format === "tall" ? tall : square;
}

/** One declared composition variable, as `data-composition-variables` lists it. */
export interface PropDeclaration {
  readonly id: string;
  readonly type: string;
  readonly default?: unknown;
  readonly min?: number;
  readonly max?: number;
  readonly maxLength?: number;
  readonly options?: readonly { readonly value: string }[];
}

const COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function coerce(declared: PropDeclaration, given: unknown): unknown {
  switch (declared.type) {
    case "number":
      if (typeof given !== "number" || !Number.isFinite(given)) return declared.default;
      return Math.min(declared.max ?? Infinity, Math.max(declared.min ?? -Infinity, given));
    case "color":
      return typeof given === "string" && COLOR.test(given) ? given : declared.default;
    case "string":
      return typeof given === "string" ? given.slice(0, declared.maxLength ?? 400) : declared.default;
    case "boolean":
      return typeof given === "boolean" ? given : declared.default;
    case "enum":
      return typeof given === "string" && (declared.options ?? []).some((option) => option.value === given) ? given : declared.default;
    case "image": {
      const url = typeof given === "object" && given !== null ? (given as { url?: unknown }).url : given;
      if (typeof url === "string") return url;
      const fallback = declared.default;
      return typeof fallback === "object" && fallback !== null ? ((fallback as { url?: unknown }).url ?? "") : (fallback ?? "");
    }
    default:
      return given === undefined ? declared.default : given;
  }
}

/**
 * Typed prop values: for each declaration, the given value when it fits the
 * type, else the default. Numbers clamp to `min` / `max`, colours must be hex,
 * an enum must be one of its options, an image is a path or `{ url }` (read as
 * its path). A wrong clip prop therefore never breaks the picture.
 */
export function resolveProps(declared: readonly PropDeclaration[], given: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const declaration of declared) values[declaration.id] = coerce(declaration, given[declaration.id]);
  return values;
}

/**
 * The clip's props as typed values: the declarations of the root `<html>`
 * element's `data-composition-variables`, resolved against what HyperFrames
 * hands the page (`getVariables()`: the clip's `props` over the defaults).
 */
export function props(): Record<string, unknown> {
  const page = globalThis as unknown as PageWindow;
  const raw = page.document?.documentElement.getAttribute("data-composition-variables");
  const declared = raw ? (JSON.parse(raw) as unknown) : [];
  if (!Array.isArray(declared)) throw new Error("data-composition-variables must be an array of declarations");
  return resolveProps(declared as PropDeclaration[], page.__hyperframes?.getVariables?.() ?? {});
}
