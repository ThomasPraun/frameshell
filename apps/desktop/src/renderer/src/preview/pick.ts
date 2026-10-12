// What the Pick tool points at (ADR 0011): the layers under a point and, in a generated clip, the composition element
// painting it. Pure but for the probe it is given, so it is tested with a fake one.
import { PROBE_MAX_DEPTH, type ProbedElement } from "@frameshell/protocol/probe";
import type { Size } from "@frameshell/schema/composite";
import { liveSeconds } from "./live.js";
import type { PickTarget } from "./pick-pages.js";
import { type Program, programAt } from "./program.js";
import { type FrameBox, frameBox, layersAt } from "./transform-edit.js";

/** One layer under a picked point. */
export interface PickLayer {
  clip: string;
  type: string;
  paints: boolean;
}

/** What a point shows. */
export interface PickResult {
  /** Every layer whose box holds the point, topmost first; `paints` as finally decided (element probes included). */
  layers: PickLayer[];
  /** The clip the user sees there; null over black. */
  target: string | null;
  /** Picked element of the target's composition, then its ancestors; empty for footage, stills and failed probes. */
  elements: ProbedElement[];
  /** Why the target's elements are unknown; null when known or not applicable. */
  unavailable: string | null;
  /** Where the target's live page lies, in fractions of the frame (maps element boxes); null when the target is not generated. */
  page: FrameBox | null;
}

/** Asks a generated clip's live page what paints a page pixel (see `PickPages.probeAt`). */
export type ProbeAt = (target: PickTarget, x: number, y: number, depth: number) => Promise<ProbedElement[]>;

/**
 * The live page target of the generated clip on `layer` at `frame`: where
 * its page lies and what time it must show. Null when that layer holds no
 * generated clip, or its render state is not known yet (no page identity).
 */
export function pickTarget(program: Program, frame: number, layer: number): PickTarget | null {
  const span = programAt(program, frame, layer);
  if (span?.kind !== "generated" || !span.render) return null;
  const identity = span.render.state === "ready" ? span.render.file : span.render.key;
  if (!identity) return null;
  // Renders are made at the project format, so the page is laid out at it too.
  const box = frameBox(program.resolution, program.resolution, span.placement);
  return { clip: span.clip, identity, box, seconds: liveSeconds(span, frame / program.fps, program.fps) };
}

/** Page pixel of frame point `point` (fractions) in a page lying at `box`, laid out at `resolution`. */
export function pagePoint(box: FrameBox, resolution: Size, point: { x: number; y: number }): { x: number; y: number } {
  return { x: ((point.x - box.left) / box.width) * resolution.width, y: ((point.y - box.top) / box.height) * resolution.height };
}

/** Box of a probed element in fractions of the frame, for a page lying at `page`. */
export function elementBox(page: FrameBox, resolution: Size, element: ProbedElement): FrameBox {
  const sx = page.width / resolution.width;
  const sy = page.height / resolution.height;
  return { left: page.left + element.box.x * sx, top: page.top + element.box.y * sy, width: element.box.width * sx, height: element.box.height * sy };
}

/**
 * What point `point` (fractions of the frame) shows at `frame`: layers from
 * the top down. A generated clip's page decides for itself (an element
 * paints there, or the page is transparent there and the next layer down
 * shows); when its page cannot be probed, the engine's alpha decides and
 * `unavailable` says why. Footage and stills paint unless their alpha
 * (`alphaOf`, from the engine) says otherwise.
 */
export async function resolvePick(
  program: Program,
  frame: number,
  point: { x: number; y: number },
  alphaOf: (layer: number) => number | undefined,
  probe: ProbeAt,
): Promise<PickResult> {
  const hits = layersAt(program, frame, point, alphaOf);
  const layers: PickLayer[] = hits.map(({ clip, type, paints }) => ({ clip, type, paints }));
  for (const [index, hit] of hits.entries()) {
    if (hit.kind !== "generated") {
      if (hit.paints) return { layers, target: hit.clip, elements: [], unavailable: null, page: null };
      continue;
    }
    const target = pickTarget(program, frame, hit.layer);
    let elements: ProbedElement[] | null = null;
    let unavailable: string | null = null;
    if (!target) unavailable = "its render state is not known yet";
    else {
      try {
        const at = pagePoint(target.box, program.resolution, point);
        elements = await probe(target, at.x, at.y, PROBE_MAX_DEPTH);
      } catch (error) {
        unavailable = (error as Error).message;
      }
    }
    if (elements) {
      layers[index]!.paints = elements.length > 0;
      if (elements.length > 0) return { layers, target: hit.clip, elements, unavailable: null, page: target!.box };
      continue;
    }
    if (hit.paints) return { layers, target: hit.clip, elements: [], unavailable, page: target?.box ?? null };
  }
  return { layers, target: null, elements: [], unavailable: null, page: null };
}

/** Leading text an element's source must contain for its text to count as written there. */
const TEXT_PROBE_CHARS = 24;

/**
 * `elements` with {@link ProbedElement.generated} set where the adapter named
 * a `source` file: an element whose id, classes and text all occur nowhere in
 * that file was created by a script (GSAP, bindings), so the agent looks for
 * the script, not the markup. `read` returns a project file's text; each file
 * is read once. Elements without a source, or with nothing to look for, are
 * returned as they are.
 */
export async function markGenerated(elements: readonly ProbedElement[], read: (path: string) => Promise<string>): Promise<ProbedElement[]> {
  const files = new Map<string, Promise<string | null>>();
  const text = (path: string) => {
    let file = files.get(path);
    if (!file) {
      file = read(path).catch(() => null);
      files.set(path, file);
    }
    return file;
  };
  return Promise.all(
    elements.map(async (element) => {
      const source = element.adapter?.["source"];
      if (typeof source !== "string") return element;
      const tokens = [element.id, ...element.classes, element.text.slice(0, TEXT_PROBE_CHARS).trim()].filter((token): token is string => !!token);
      const content = tokens.length > 0 ? await text(source) : null;
      if (content === null) return element;
      return { ...element, generated: tokens.every((token) => !content.includes(token)) };
    }),
  );
}
