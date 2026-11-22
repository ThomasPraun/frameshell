// `clip.textFit` (#803): does every line of text of a generated clip fit its box and the frame? Its live page is
// seeked to a few settled times and each visible element with text of its own is measured; props can be tried in
// place of the clip's own (another language) for the check only.
import {
  type ClipLiveResult,
  type ClipTextFitResult,
  ErrorCode,
  RpcError,
  TEXT_FIT_DEFAULT_FRACTIONS,
  TEXT_FIT_SLACK_PX,
} from "@frameshell/protocol";
import type { AnyClip, Size, Timeline } from "@frameshell/schema";
import { Chrome } from "../inspect/chrome.js";
import { LIVE_PAGE_TIMEOUT_MS, openLivePage } from "../inspect/live-page.js";
import { generatedClips } from "./renderer.js";
import { seek } from "./verify.js";

/** One element with text of its own, as {@link TEXT_FIT_SCRIPT} measures it at one time. */
export interface MeasuredText {
  selector: string;
  text: string;
  /** The text's own box (a range over the element's contents), page pixels. */
  text_box: Box;
  /**
   * How far the content passes the inside of the box holding it (the element, or for an inline element its nearest
   * ancestor that is not inline) on its end sides, page pixels: scroll size over client size, scaled by transforms.
   */
  spill: { right: number; bottom: number };
}

/** A box in page pixels. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Problem = ClipTextFitResult["problems"][number];
type Side = Problem["side"];

/**
 * Script text evaluated in a live page: every visible element (no `display: none`, `visibility: hidden` or zero
 * opacity on it or an ancestor) with a text node of its own, as {@link MeasuredText}s. The selector is the probe's
 * (`window.__frameshellProbe.selector`, defined in every probed page), so it names elements as `inspect.point` does.
 * The box check reads scroll overflow, not the glyph box, less what glyphs taller than a tight `line-height` add.
 */
export const TEXT_FIT_SCRIPT = `(function () {
  var round = function (n) { return Math.round(n * 10) / 10; };
  var box = function (r) { return { x: round(r.left), y: round(r.top), width: round(r.width), height: round(r.height) }; };
  var visible = function (element) {
    for (var e = element; e && e.nodeType === 1; e = e.parentElement) {
      var style = getComputedStyle(e);
      if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity) === 0) return false;
    }
    return true;
  };
  var own = function (element) {
    for (var node = element.firstChild; node; node = node.nextSibling) if (node.nodeType === 3 && /\\S/.test(node.nodeValue)) return true;
    return false;
  };
  var holder = function (element) {
    var e = element;
    while (e.parentElement && e !== document.body && getComputedStyle(e).display === "inline") e = e.parentElement;
    return e;
  };
  // Glyphs taller than a tight line-height reach past their line box and count as scroll overflow; that is not a
  // spill, so the bottom gives them back (\`lead\`: the tallest line of the range over the line-height).
  var spill = function (element, lead) {
    var rect = element.getBoundingClientRect();
    var sx = element.offsetWidth > 0 ? rect.width / element.offsetWidth : 1;
    var sy = element.offsetHeight > 0 ? rect.height / element.offsetHeight : 1;
    var bottom = Math.max(0, element.scrollHeight - element.clientHeight) * sy;
    return { right: round(Math.max(0, element.scrollWidth - element.clientWidth) * sx), bottom: round(Math.max(0, bottom - lead)) };
  };
  var leadOf = function (element, range) {
    var lineHeight = parseFloat(getComputedStyle(element).lineHeight);
    var rect = element.getBoundingClientRect();
    var sy = element.offsetHeight > 0 ? rect.height / element.offsetHeight : 1;
    if (!(lineHeight > 0)) return 0;
    var tallest = 0;
    var rects = range.getClientRects();
    for (var r = 0; r < rects.length; r++) tallest = Math.max(tallest, rects[r].height);
    return Math.max(0, tallest - lineHeight * sy);
  };
  var probe = window.__frameshellProbe;
  var found = [];
  var all = document.body ? document.body.querySelectorAll("*") : [];
  for (var i = 0; i < all.length; i++) {
    var element = all[i];
    if (element.ownerSVGElement || !own(element) || !visible(element)) continue;
    var range = document.createRange();
    range.selectNodeContents(element);
    var text = range.getBoundingClientRect();
    if (text.width <= 0 || text.height <= 0) continue;
    found.push({
      selector: probe && typeof probe.selector === "function" ? probe.selector(element) : element.tagName.toLowerCase(),
      text: String(element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 80),
      text_box: box(text),
      spill: spill(holder(element), leadOf(element, range))
    });
  }
  return found;
})()`;

/** How far box `inner` passes box `outer` on each side, page pixels (0 where it stays inside). */
function excess(inner: Box, outer: Box): Record<Side, number> {
  return {
    left: Math.max(0, outer.x - inner.x),
    top: Math.max(0, outer.y - inner.y),
    right: Math.max(0, inner.x + inner.width - (outer.x + outer.width)),
    bottom: Math.max(0, inner.y + inner.height - (outer.y + outer.height)),
  };
}

/** The side passed most and by how much; null within {@link TEXT_FIT_SLACK_PX}. */
function worstSide(by: Record<Side, number>): { side: Side; by: number } | null {
  let best: { side: Side; by: number } | null = null;
  for (const side of ["left", "right", "top", "bottom"] as const) if (by[side] > TEXT_FIT_SLACK_PX && (!best || by[side] > best.by)) best = { side, by: by[side] };
  return best;
}

/**
 * The problems of `measured`, one list per time in `times`: per element and kind the worst over the times, worst
 * first. Text passing the frame of `size` is `outside`; content passing the box that holds it `overflows`.
 */
export function textFitProblems(measured: readonly (readonly MeasuredText[])[], times: readonly number[], size: Size): Problem[] {
  const frame: Box = { x: 0, y: 0, width: size.width, height: size.height };
  const worst = new Map<string, Problem>();
  measured.forEach((lines, i) => {
    for (const line of lines) {
      const checks: [Problem["kind"], Record<Side, number>][] = [
        ["outside", excess(line.text_box, frame)],
        ["overflows", { left: 0, top: 0, ...line.spill }],
      ];
      for (const [kind, by] of checks) {
        const hit = worstSide(by);
        if (!hit) continue;
        const key = `${kind}\n${line.selector}`;
        const amount = Math.round(hit.by * 10) / 10;
        const was = worst.get(key);
        if (!was || amount > was.by) {
          worst.set(key, { kind, at: Math.round(times[i]! * 1000) / 1000, by: amount, side: hit.side, selector: line.selector, text: line.text, box: line.text_box });
        }
      }
    }
  });
  return [...worst.values()].sort((a, b) => b.by - a.by || a.selector.localeCompare(b.selector));
}

/** Composition seconds checked by default: {@link TEXT_FIT_DEFAULT_FRACTIONS} of the part played from `start` for `duration`. */
export function textFitTimes(start: number, duration: number): number[] {
  return TEXT_FIT_DEFAULT_FRACTIONS.map((fraction) => Math.round((start + fraction * duration) * 1000) / 1000);
}

/** What {@link TextFitChecker} needs from the daemon. */
export interface TextFitOptions {
  /** The timeline with nested timelines flattened (ids `<nested clip>/<clip>`) and the project fps. */
  timeline(root: string, id: string): Promise<{ timeline: Timeline; fps: number }>;
  /** The clip's live page (`clip.live`), with `props` merged over the clip's own when given. */
  live(root: string, timeline: string, clip: string, props?: Record<string, unknown>): Promise<ClipLiveResult>;
  /** Project resolution: the page is laid out at this size. */
  resolution(root: string): Promise<Size>;
  /** Path of managed `chrome-headless-shell` for the project. */
  chrome(root: string): Promise<string>;
  /** The top-level props the clip's adapter declares (`ClipAdapter.declaredProps`); null when it declares none. */
  declaredProps?(root: string, clip: AnyClip): Promise<readonly string[] | null>;
}

/** Runs `clip.textFit`. */
export class TextFitChecker {
  readonly #options: TextFitOptions;

  constructor(options: TextFitOptions) {
    this.#options = options;
  }

  /**
   * Check the text of generated clip `clip` of timeline `timeline` at `at` (composition seconds; default
   * {@link textFitTimes}), with `props` tried in place of the clip's own. Throws ClipNotFound, InvalidParams,
   * LiveUnavailable.
   */
  async check(root: string, request: { timeline: string; clip: string; props?: Record<string, unknown>; at?: number[] }): Promise<ClipTextFitResult> {
    const { timeline } = await this.#options.timeline(root, request.timeline);
    const placed = generatedClips(timeline);
    const clip = placed.find((candidate) => candidate.clip.id === request.clip)?.clip;
    if (!clip) {
      const ids = placed.map((candidate) => candidate.clip.id);
      throw new RpcError(
        ErrorCode.ClipNotFound,
        `No generated clip "${request.clip}" on timeline ${timeline.id}` + (ids.length > 0 ? ` (generated clips: ${ids.join(", ")}).` : " (it has none)."),
        { clip: request.clip },
      );
    }
    const start = clip.in ?? 0;
    const end = start + clip.duration;
    const outside = (request.at ?? []).filter((time) => time < start || time > end);
    if (outside.length > 0) {
      throw new RpcError(ErrorCode.InvalidParams, `at ${outside.join(", ")} is outside the part of ${clip.id} that plays (${start} to ${Math.round(end * 1000) / 1000} s).`, {
        clip: clip.id,
      });
    }
    const times = [...(request.at ?? textFitTimes(start, clip.duration))].sort((a, b) => a - b);
    const tried = Object.keys(request.props ?? {});
    const props = tried.length > 0 ? request.props : undefined;
    const live = await this.#options.live(root, request.timeline, clip.id, props);
    const size = await this.#options.resolution(root);
    let chrome: Chrome | null = null;
    try {
      chrome = await Chrome.launch(await this.#options.chrome(root));
      const page = await openLivePage(chrome, root, live, size);
      const measured: MeasuredText[][] = [];
      try {
        for (const time of times) {
          await seek(page, time);
          measured.push(await page.evaluate<MeasuredText[]>(TEXT_FIT_SCRIPT, LIVE_PAGE_TIMEOUT_MS));
        }
      } finally {
        await page.close();
      }
      const problems = textFitProblems(measured, times, size);
      const lines = new Set(measured.flatMap((each) => each.map((line) => line.selector))).size;
      const warnings: string[] = [];
      if (lines === 0) warnings.push("No visible text at the times checked: the clip draws its words on a canvas or in SVG, or shows them at other times (pass `at`).");
      const declared = (await this.#options.declaredProps?.(root, clip)) ?? null;
      const unknown = declared && declared.length > 0 ? tried.filter((id) => !declared.includes(id)) : [];
      if (unknown.length > 0) warnings.push(`The clip has no prop ${unknown.map((id) => `\`${id}\``).join(", ")}: check its ids with \`clip show\`.`);
      return { timeline: timeline.id, clip: clip.id, type: clip.type, ok: problems.length === 0, size, tried, at: times, lines, problems, warnings };
    } catch (error) {
      if (error instanceof RpcError) throw error;
      const details = (error as Error)?.message ?? String(error);
      throw new RpcError(ErrorCode.LiveUnavailable, `${clip.type} clip ${clip.id} cannot be checked: ${details}`, { clip: clip.id, type: clip.type, timeline: timeline.id, details });
    } finally {
      await chrome?.close();
    }
  }
}
