// Element probe of a live page (ADR 0011): what DOM element a composition shows at a point. One script, run inside
// the page by the app's live bridge (and by the daemon's headless inspect), so both answer alike.

/** Box in page pixels: a live page is laid out at the project resolution, so these are project pixels. */
export interface ProbedBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One element of a composition as the probe describes it. */
export interface ProbedElement {
  /**
   * CSS selector of the element from the nearest ancestor with an `id` (or
   * from `body`), one segment per level: `#scene-2 > div.card:nth-child(2) > h1`.
   * Unique in the page when it was probed.
   */
  selector: string;
  /** Tag name, lower case. */
  tag: string;
  id: string | null;
  classes: string[];
  /** Rendered text, whitespace collapsed, at most 200 characters; empty when none. */
  text: string;
  box: ProbedBox;
  /** Computed style values that say what the element looks like: background, colour, font, opacity, border, radius. */
  styles: Record<string, string>;
  /** `outerHTML`, cut at 2048 characters. */
  html: string;
  /** `data-*` attributes without the prefix. */
  data: Record<string, string>;
  /** What the adapter's `frameshellLive.describe(element)` added (ADR 0011); null when it has none or it threw. */
  adapter: Record<string, unknown> | null;
  /**
   * Set by the app, not the page, when the adapter names the element's
   * `source` file: true when neither its id, its classes nor its text occur
   * in that file, so a script created it; false when one does. Absent when
   * unknown (no source, nothing to look for, file unreadable).
   */
  generated?: boolean;
}

/** An element an adjustment can move (ADR 0021), as the probe's `movable` and `element` describe it. */
export interface MovableElement {
  element: ProbedElement;
  /**
   * Page pixels per CSS pixel of a `translate` on the element: the scale its
   * parent is drawn at, 1 unless the composition scales its stage to the page.
   */
  unit: number;
}

/** Most ancestors a point probe returns after the hit element. */
export const PROBE_MAX_DEPTH = 8;
/** Most elements a rectangle probe returns. */
export const PROBE_MAX_ELEMENTS = 10;

/**
 * Script text that defines `window.__frameshellProbe` in a live page:
 *
 * - `at(x, y, depth)`: the topmost element that paints pixel (`x`, `y`)
 *   (page pixels), then up to `depth` of its ancestors below `body`, as
 *   {@link ProbedElement}s; empty when nothing paints there (transparent:
 *   the layer below shows).
 * - `within(x0, y0, x1, y1, max)`: up to `max` elements that paint and lie
 *   at least half inside the rectangle, topmost (latest in the document) first.
 * - `movable(x, y, depth)`: the element an element adjustment (ADR 0021) moves
 *   for pixel (`x`, `y`): the hit of `at` without the page background, an
 *   inline hit stepped up to its nearest ancestor that is not inline, then up
 *   to `depth` ancestors below `body`; as a {@link MovableElement}, null when
 *   nothing paints there.
 * - `element(selector)`: the first element matching `selector`, as a
 *   {@link MovableElement}; null when none does or it is not valid.
 *
 * An element paints when it is visible (no `display: none`, `visibility:
 * hidden` or zero opacity on it or an ancestor) and draws something itself:
 * a background colour or image, a border, a shadow, its own text, or
 * replaced content (image, video, canvas, SVG, form control). Wrappers that
 * only lay out their children never count as the hit, though they appear
 * as its ancestors. Where no element paints but `body` (else `html`) has a
 * background, that is the hit: the composition's own background.
 */
export const PROBE_SCRIPT = `(function () {
  var STYLE_KEYS = ["background-color", "background-image", "color", "font-family", "font-size", "font-weight", "opacity", "border", "border-radius"];
  var REPLACED = /^(img|video|canvas|svg|picture|iframe|input|textarea|select|button)$/;
  var CLEAR = /^(transparent|rgba\\(.*,\\s*0\\))$/;
  var escape = function (value) { return window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, "\\\\$&"); };
  var visible = function (element) {
    for (var e = element; e && e.nodeType === 1; e = e.parentElement) {
      var style = getComputedStyle(e);
      if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity) === 0) return false;
    }
    return true;
  };
  var paints = function (element) {
    var tag = element.tagName.toLowerCase();
    if (REPLACED.test(tag) || element.ownerSVGElement) return true;
    var style = getComputedStyle(element);
    if (!CLEAR.test(style.backgroundColor)) return true;
    if (style.backgroundImage && style.backgroundImage !== "none") return true;
    if (style.boxShadow && style.boxShadow !== "none") return true;
    var sides = ["Top", "Right", "Bottom", "Left"];
    for (var i = 0; i < sides.length; i++) {
      var side = sides[i];
      if (parseFloat(style["border" + side + "Width"]) > 0 && style["border" + side + "Style"] !== "none" && !CLEAR.test(style["border" + side + "Color"])) return true;
    }
    for (var node = element.firstChild; node; node = node.nextSibling) if (node.nodeType === 3 && /\\S/.test(node.nodeValue)) return true;
    return false;
  };
  var counts = function (element) {
    return element !== document.documentElement && element !== document.body && visible(element) && paints(element);
  };
  var segment = function (element) {
    if (element.id) return "#" + escape(element.id);
    var tag = element.tagName.toLowerCase();
    var classes = [].slice.call(element.classList, 0, 2);
    var part = tag + classes.map(function (c) { return "." + escape(c); }).join("");
    var parent = element.parentElement;
    if (parent) {
      var alike = [].filter.call(parent.children, function (child) { return child.matches(part); });
      if (alike.length > 1) part += ":nth-child(" + ([].indexOf.call(parent.children, element) + 1) + ")";
    }
    return part;
  };
  var selector = function (element) {
    var parts = [];
    for (var e = element; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
      parts.unshift(segment(e));
      if (e.id) break;
    }
    return parts.length > 0 ? parts.join(" > ") : element.tagName.toLowerCase();
  };
  var describe = function (element) {
    var rect = element.getBoundingClientRect();
    var style = getComputedStyle(element);
    var styles = {};
    for (var i = 0; i < STYLE_KEYS.length; i++) styles[STYLE_KEYS[i]] = style.getPropertyValue(STYLE_KEYS[i]);
    var data = {};
    for (var key in element.dataset) data[key] = element.dataset[key];
    var adapter = null;
    var live = window.frameshellLive;
    if (live && typeof live.describe === "function") {
      try {
        var extra = live.describe(element);
        if (extra && typeof extra === "object") adapter = JSON.parse(JSON.stringify(extra));
      } catch (error) {
        adapter = null;
      }
    }
    var round = function (n) { return Math.round(n * 10) / 10; };
    return {
      selector: selector(element),
      tag: element.tagName.toLowerCase(),
      id: element.id || null,
      classes: [].slice.call(element.classList),
      text: String(element.innerText || element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 200),
      box: { x: round(rect.left), y: round(rect.top), width: round(rect.width), height: round(rect.height) },
      styles: styles,
      html: element.outerHTML.slice(0, 2048),
      data: data,
      adapter: adapter
    };
  };
  var hitAt = function (x, y) {
    var hits = document.elementsFromPoint(x, y);
    for (var i = 0; i < hits.length; i++) if (counts(hits[i])) return hits[i];
    return null;
  };
  var below = function (element) { return element && element !== document.body && element !== document.documentElement; };
  // translate and scale do nothing on a non-replaced inline box: its nearest ancestor that is not inline moves.
  var block = function (element) {
    for (var e = element; below(e); e = e.parentElement) {
      if (e.ownerSVGElement || REPLACED.test(e.tagName.toLowerCase()) || getComputedStyle(e).display !== "inline") return e;
    }
    return element;
  };
  // Page px per CSS px of a translate on the element: the scale its parent is drawn at (a stage scaled to fit).
  var unit = function (element) {
    var parent = element.parentElement;
    return parent && parent.offsetWidth > 0 ? parent.getBoundingClientRect().width / parent.offsetWidth : 1;
  };
  var movable = function (element) { return { element: describe(element), unit: unit(element) }; };
  window.__frameshellProbe = {
    at: function (x, y, depth) {
      var hit = hitAt(x, y);
      // The page's own background: what the user sees there is the composition, not the layer below.
      if (!hit && document.body && visible(document.body) && paints(document.body)) hit = document.body;
      if (!hit && visible(document.documentElement) && paints(document.documentElement)) hit = document.documentElement;
      if (!hit) return [];
      var chain = [hit];
      for (var e = hit.parentElement; e && e !== document.body && e !== document.documentElement && chain.length <= depth; e = e.parentElement) chain.push(e);
      return chain.map(describe);
    },
    within: function (x0, y0, x1, y1, max) {
      var found = [];
      var all = document.body ? document.body.querySelectorAll("*") : [];
      for (var i = all.length - 1; i >= 0 && found.length < max; i--) {
        var element = all[i];
        var rect = element.getBoundingClientRect();
        var area = rect.width * rect.height;
        if (area <= 0) continue;
        var w = Math.min(rect.right, x1) - Math.max(rect.left, x0);
        var h = Math.min(rect.bottom, y1) - Math.max(rect.top, y0);
        if (w <= 0 || h <= 0 || (w * h) / area < 0.5 || !counts(element)) continue;
        found.push(describe(element));
      }
      return found;
    },
    movable: function (x, y, depth) {
      var hit = hitAt(x, y);
      if (!hit) return null;
      var element = block(hit);
      for (var up = 0; up < depth && below(element.parentElement); up++) element = element.parentElement;
      return movable(element);
    },
    element: function (selector) {
      var element = null;
      try { element = document.querySelector(selector); } catch (error) { element = null; }
      return element ? movable(element) : null;
    }
  };
})();`;

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
