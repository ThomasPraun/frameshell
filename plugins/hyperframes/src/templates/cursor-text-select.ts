import { CURSOR_CSS, CURSOR_HTML, CURSOR_MATH, CURSOR_SCRIPT, cursorVariables, hesitateVariable } from "./cursor-kit.js";
import {
  BACKDROP_CSS,
  BACKDROP_SETUP,
  COLOR_HELPERS,
  PLACEHOLDER,
  type Template,
  type TemplateInput,
  type TemplateVariable,
  backdropVariables,
  fontSetup,
  pageHead,
} from "./kit.js";

/** The paragraph the template shows by default, and the one it falls back to when the `text` prop has no word left. */
const DEFAULT_TEXT = "Editing a video should feel like editing a document.";

/**
 * Cursor text select (#466, UI demo): words rise into a paragraph, a cursor
 * presses at the start of a phrase and drags along it (down to the next line
 * when the phrase wraps), the highlight following the cursor word by word; on
 * release a small action pill pops over the selection. The page measures its own
 * word boxes with layout offsets (never under a transform), so the cursor lands
 * on the real text at any format. Transparent unless `backdrop` is raised.
 *
 * The page script keeps its comments out of the composition (a file over 300
 * lines draws a lint warning). Layout, in short: words are inline-block spans;
 * their boxes are read from layout offsets and rebuilt only when the layout
 * changes. The selection is cut into one segment per line; the drag runs along
 * the text of each segment and diagonally between the end of one line and the
 * start of the next, and each word's highlight is the part of the drag behind
 * it. The type shrinks until the paragraph takes at most half the frame height.
 * The pill goes under the selection when that is the last line, else over its
 * first line. Words compare without case or punctuation.
 */
export const cursorTextSelect: Template = {
  id: "cursor-text-select",
  description: "Cursor text select: a cursor drags across a phrase in a paragraph, the highlight follows it, an action pill pops on release; transparent unless a background is set",
  defaultDuration: 5,
  overlay: true,
  variables({ tokens }: TemplateInput): TemplateVariable[] {
    return [
      { id: "text", type: "string", label: "The paragraph (up to 24 words are shown)", default: DEFAULT_TEXT, maxLength: 160 },
      { id: "select", type: "string", label: "The phrase the cursor selects, as it is written in the paragraph; if it is not found the last three words are selected", default: "editing a document", maxLength: 80 },
      { id: "action", type: "string", label: "Text of the pill that pops up over the selection; empty for none", default: "Ask the agent", maxLength: 24 },
      hesitateVariable(0.25),
      { id: "ink", type: "color", label: "Text colour", default: tokens.colors.ink ?? PLACEHOLDER.ink },
      { id: "accent", type: "color", label: "Highlight colour", default: tokens.colors.accent ?? PLACEHOLDER.accent },
      { id: "card", type: "color", label: "Pill colour", default: tokens.colors.card ?? PLACEHOLDER.bg },
      ...cursorVariables(),
      { id: "size", type: "number", label: "Type size, 1 = the format's default", default: 1, min: 0.5, max: 1.5, step: 0.05 },
      ...backdropVariables(tokens),
    ];
  },
  render(input: TemplateInput): string {
    const { id, width, height, duration } = input;
    const fonts = fontSetup(input.tokens);
    const css = `
      ${BACKDROP_CSS}
      #world { position: absolute; inset: 0; }
      #content { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
      #block { position: relative; font-family: ${fonts.display}; font-weight: ${fonts.displayWeight}; line-height: 1.4; letter-spacing: -0.01em; }
      .w { position: relative; display: inline-block; }
      .w .hl { position: absolute; left: 0; right: 0; top: 0.1em; bottom: 0.1em; border-radius: 0.06em; transform-origin: 0 50%; }
      .w .t { position: relative; font-weight: inherit; }
      #pill { position: absolute; display: flex; align-items: center; justify-content: center; gap: 0.5em; white-space: nowrap; font-family: ${fonts.ui}; font-weight: 600; }
      #pill-dot { flex: none; width: 0.8em; height: 0.8em; border-radius: 50%; }
      ${CURSOR_CSS}`;
    return `${pageHead(input, this.variables(input), css)}
  <body>
    <!-- Root: size and length of the render. FrameshellMotion.bind below registers its timeline, so the render
         does not wait for one. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
      <div id="cursor-text-select-clip" class="clip">
        <div id="backdrop"></div>
        <div id="world">
          <div id="content"><div id="block"></div></div>
          <div id="pill"><i id="pill-dot"></i><span id="pill-text"></span></div>
          ${CURSOR_HTML}
        </div>
      </div>
    </div>
    <script>
      var M = window.FrameshellMotion;
      var P = M.props();
      var S = M.stage();
      var unit = Math.min(S.width, S.height);
      ${COLOR_HELPERS}
      ${BACKDROP_SETUP}
      ${CURSOR_MATH}
      ${CURSOR_SCRIPT}
      var L = M.pick({ size: 0.07, w: 0.62 }, { size: 0.066, w: 0.8 }, { size: 0.06, w: 0.86 });
      var words = String(P.text).split(/\\s+/).filter(Boolean).slice(0, 24);
      if (!words.length) words = ${JSON.stringify(DEFAULT_TEXT)}.split(" ");
      var chars = words.join(" ").length;
      var blockW = L.w * S.width;
      var px = Math.min(L.size * unit * P.size, Math.sqrt((blockW * 0.5 * S.height) / (Math.max(1, chars) * 0.55 * 1.4)));
      var block = document.getElementById("block");
      block.style.cssText += "width:" + blockW + "px;font-size:" + px + "px;color:" + P.ink;
      var spans = [];
      words.forEach(function (word, i) {
        var w = document.createElement("span");
        w.className = "w";
        w.innerHTML = '<i class="hl"></i><b class="t"></b>';
        w.lastChild.textContent = word;
        w.firstChild.style.background = P.accent;
        block.appendChild(w);
        if (i < words.length - 1) block.appendChild(document.createTextNode(" "));
        spans.push(w);
      });
      var n = spans.length;
      function norm(text) {
        var lower = String(text).toLowerCase();
        var kept = "";
        for (var c = 0; c < lower.length; c++) {
          var ch = lower.charAt(c);
          if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || lower.charCodeAt(c) > 127) kept += ch;
        }
        return kept;
      }
      var plain = words.map(norm);
      var want = String(P.select).split(" ").map(norm).filter(Boolean);
      var first = -1;
      for (var i = 0; want.length && first < 0 && i + want.length <= n; i++) {
        var same = true;
        for (var j = 0; j < want.length; j++) if (plain[i + j] !== want[j]) same = false;
        if (same) first = i;
      }
      var lastWord = n - 1;
      if (first < 0) first = Math.max(0, n - 3);
      else lastWord = first + want.length - 1;
      var pill = document.getElementById("pill");
      var pillText = document.getElementById("pill-text");
      var pillPx = px * 0.5;
      var pillW = String(P.action).length * 0.58 * pillPx + 3.4 * pillPx;
      var pillH = pillPx * 2.6;
      pillText.textContent = P.action;
      pill.style.cssText += "width:" + pillW + "px;height:" + pillH + "px;border-radius:" + pillH / 2 + "px;font-size:" + pillPx + "px;background:" + P.card + ";color:" + P.ink + ";" + (P.action ? "" : "display:none;");
      document.getElementById("pill-dot").style.background = P.accent;
      var cache = null;
      function scene() {
        var edge = spans[n - 1];
        var key = block.offsetHeight + ":" + edge.offsetLeft + ":" + edge.offsetTop + ":" + spans[0].offsetWidth;
        if (cache && cache.key === key) return cache;
        var ox = block.offsetLeft;
        var oy = block.offsetTop;
        var items = spans.map(function (w) {
          return { l: ox + w.offsetLeft, r: ox + w.offsetLeft + w.offsetWidth, top: oy + w.offsetTop, h: w.offsetHeight };
        });
        var segs = [];
        for (var k = first; k <= lastWord; k++) {
          var it = items[k];
          var seg = segs[segs.length - 1];
          if (seg && Math.abs(seg.top - it.top) < 2) {
            seg.r = it.r;
            seg.to = k;
          } else {
            segs.push({ l: it.l, r: it.r, top: it.top, h: it.h, yc: it.top + it.h / 2, from: k, to: k, s0: 0 });
          }
        }
        var total = 0;
        segs.forEach(function (seg, k) {
          if (k > 0) {
            var before = segs[k - 1];
            total += Math.sqrt(Math.pow(seg.l - before.r, 2) + Math.pow(seg.yc - before.yc, 2));
          }
          seg.s0 = total;
          total += seg.r - seg.l;
        });
        function polyAt(d) {
          for (var k = 0; k < segs.length; k++) {
            var seg = segs[k];
            if (d <= seg.s0 + seg.r - seg.l || k === segs.length - 1) {
              if (d >= seg.s0) return { x: seg.l + Math.min(d - seg.s0, seg.r - seg.l), y: seg.yc };
              var before = segs[k - 1];
              var f = (d - (before.s0 + before.r - before.l)) / (seg.s0 - (before.s0 + before.r - before.l));
              return { x: before.r + (seg.l - before.r) * f, y: before.yc + (seg.yc - before.yc) * f };
            }
          }
          return { x: segs[0].l, y: segs[0].yc };
        }
        var marks = [];
        segs.forEach(function (seg) {
          for (var k = seg.from; k <= seg.to; k++) {
            var gap = k < seg.to ? items[k + 1].l - items[k].r : 0.05 * px;
            var bleed = k === seg.from ? 0.05 * px : 0;
            spans[k].firstChild.style.left = -bleed + "px";
            spans[k].firstChild.style.right = -gap + "px";
            marks[k] = { start: seg.s0 + items[k].l - seg.l - bleed, span: items[k].r - items[k].l + gap + bleed };
          }
        });
        var start = { x: segs[0].l, y: segs[0].yc };
        var lastSeg = segs[segs.length - 1];
        var end = { x: lastSeg.r, y: lastSeg.yc };
        var made = fitFirst(CURSOR_TRIES, function (hesitate, rate) {
          var approach = journey(FROM, [{ x: start.x, y: start.y, hesitate: P.hesitate * hesitate, wait: 0.18 }], START, undefined, rate);
          var dragStart = approach.legs[0].leave;
          var dur = Math.max(0.45 / rate, (M.durationFromDistance((total * 1080) / unit, "normal") * 1.5) / rate);
          return { approach: approach, downAt: approach.legs[0].arrive + 0.04, dragStart: dragStart, dur: dur, ready: dragStart + dur + 0.08 };
        }, latest(0.5));
        var approach = made.approach;
        var downAt = made.downAt;
        var dragStart = made.dragStart;
        var dur = made.dur;
        var dragEnd = dragStart + dur;
        var upAt = made.ready;
        var rest = inFrame({ x: end.x + 0.06 * unit, y: oy + block.offsetHeight + pillH * 1.6 + 0.03 * unit }, 0.05);
        var leave = journey(end, [{ x: rest.x, y: rest.y, weight: "light", bend: 0.2 }], upAt + 0.45, { x: 0.004 * unit, y: 0.003 * unit });
        var below = Math.abs(lastSeg.top - items[n - 1].top) < 2;
        var mid = below
          ? inFrame({ x: (lastSeg.l + lastSeg.r) / 2, y: lastSeg.top + lastSeg.h + pillH * 1.3 }, 0.04)
          : inFrame({ x: (segs[0].l + segs[0].r) / 2, y: segs[0].top - pillH * 0.2 }, 0.04);
        cache = {
          key: key, marks: marks, total: total, polyAt: polyAt, start: start, end: end, approach: approach, leave: leave,
          downAt: downAt, dragStart: dragStart, dragEnd: dragEnd, dur: dur, upAt: upAt,
          pill: { x: mid.x - pillW / 2, y: mid.y - pillH }
        };
        pill.style.left = cache.pill.x + "px";
        pill.style.top = cache.pill.y + "px";
        return cache;
      }
      var world = document.getElementById("world");
      var D = S.duration;
      var OUT = 0.3;
      M.bind("${id}", function (t) {
        var out = M.ease("exit", (t - (D - OUT)) / OUT);
        put(backdrop, { opacity: P.backdrop * M.ease("enter", t / 0.3) * (1 - out) });
        put(world, { scale: 1 + 0.02 * Math.min(1, t / D) - 0.02 * out, opacity: 1 - out });

        var sc = scene();
        var d = t < sc.dragStart ? 0 : t < sc.dragEnd ? sc.total * M.ease("camera", (t - sc.dragStart) / sc.dur) : sc.total;
        var cur = t < sc.dragStart ? sc.approach.at(t) : t < sc.dragEnd ? sc.polyAt(d) : sc.leave.at(t);

        for (var k = 0; k < n; k++) {
          var at = 0.05 + M.stagger(k, n, M.STAGGER_STEPS.words);
          var w = spans[k];
          put(w, { y: (1 - M.spring("default", t - at)) * px * 0.6, opacity: M.ease("enter", (t - at) / 0.25) });
          var mark = sc.marks[k];
          put(w.firstChild, { scaleX: mark ? Math.min(1, Math.max(0, (d - mark.start) / mark.span)) : 0, opacity: 0.38 });
        }

        var s = M.spring("snappy", t - sc.upAt);
        put(pill, { y: (1 - s) * pillH * 0.5, scale: 0.85 + 0.15 * s, opacity: M.ease("enter", (t - sc.upAt) / 0.12) });

        drawRipple(t, sc.downAt, sc.start.x, sc.start.y);
        drawCursor(cur, press(t, sc.downAt, sc.upAt));
      });
    </script>
  </body>
</html>
`;
  },
};
