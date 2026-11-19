import {
  BACKDROP_CSS,
  BACKDROP_SETUP,
  COLOR_HELPERS,
  FLAT_HELPERS,
  SEED_HELPERS,
  PLACEHOLDER,
  type Template,
  type TemplateInput,
  type TemplateVariable,
  backdropVariables,
  fontSetup,
  pageHead,
  trimScript,
} from "./kit.js";

const DEFAULT_TEXT = "Make the one thing that matters impossible to miss.";
const DEFAULT_MARK = "impossible to miss";

/**
 * Emphasis marker: a sentence rises in, then a hand-drawn mark is drawn
 * on a phrase of it: highlight, circle, underline, strike-through, box or
 * bracket (the rough-notation family). The marks are SVG strokes whose dash
 * offset is a function of the time, with seeded wobble, so every seek paints
 * the same pixels. A phrase that wraps gets one stroke per line (highlight,
 * underline, strike-through) or one shape round the whole phrase (circle, box,
 * bracket). Transparent unless `backdrop` is raised.
 */
export const emphasisMarker: Template = {
  id: "emphasis-marker",
  description: "Emphasis marker: a hand-drawn highlight, circle, underline, strike-through, box or bracket drawn on a phrase of a sentence; transparent unless a background is set",
  defaultDuration: 4,
  overlay: true,
  variables({ tokens }: TemplateInput): TemplateVariable[] {
    return [
      { id: "text", type: "string", label: "The sentence", default: DEFAULT_TEXT, maxLength: 140 },
      { id: "mark", type: "string", label: "The phrase to mark, as written in the sentence; empty or not found marks the last two words", default: DEFAULT_MARK, maxLength: 60 },
      {
        id: "marker",
        type: "enum",
        label: "Kind of mark",
        default: "highlight",
        options: [
          { value: "highlight", label: "Highlight: a marker pen behind the words" },
          { value: "circle", label: "Circle round the phrase" },
          { value: "underline", label: "Underline" },
          { value: "strike", label: "Strike-through (the words dim)" },
          { value: "box", label: "Box round the phrase" },
          { value: "bracket", label: "Brackets either side" },
        ],
      },
      { id: "markAt", type: "number", label: "Seconds until the mark starts (pulled in on a short clip so it finishes before the exit)", default: 1, min: 0.5, max: 5, step: 0.1, unit: "s" },
      { id: "drawTime", type: "number", label: "Seconds the mark takes to draw", default: 0.6, min: 0.2, max: 1.5, step: 0.05, unit: "s" },
      { id: "rough", type: "number", label: "How hand-drawn it looks, 0 = ruler straight", default: 0.5, min: 0, max: 1, step: 0.05 },
      { id: "weight", type: "number", label: "Stroke thickness, 1 = the format's default", default: 1, min: 0.5, max: 2, step: 0.1 },
      { id: "seed", type: "string", label: "Any text; a different one wobbles the mark another way, for variants of the same look", default: "frameshell", maxLength: 40 },
      { id: "ink", type: "color", label: "Text colour", default: tokens.colors.ink ?? PLACEHOLDER.ink },
      { id: "accent", type: "color", label: "Mark colour", default: tokens.colors.accent ?? PLACEHOLDER.accent },
      { id: "size", type: "number", label: "Type size, 1 = the format's default", default: 1, min: 0.5, max: 1.6, step: 0.05 },
      ...backdropVariables(tokens),
    ];
  },
  render(input: TemplateInput): string {
    const { id, width, height, duration } = input;
    const fonts = fontSetup(input.tokens);
    const css = `
      ${BACKDROP_CSS}
      #content { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
      #block { position: relative; isolation: isolate; text-align: center; font-family: ${fonts.display}; font-weight: ${fonts.displayWeight}; line-height: 1.3; letter-spacing: -0.01em; }
      /* The mask clips a word while it travels; the padding keeps accents and descenders inside it. */
      .mask { display: inline-block; overflow: hidden; padding: 0.1em 0.04em 0.16em; margin: -0.1em -0.04em -0.16em; }
      .word { position: relative; z-index: 1; display: inline-block; }
      /* The highlight sits under the words, every other mark over them. */
      .layer { position: absolute; left: 0; top: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
      #under { z-index: 0; }
      #over { z-index: 2; }`;
    const page = `${pageHead(input, this.variables(input), css)}
  <body>
    <!-- Root: size and length of the render. FrameshellMotion.bind below registers its timeline, so the render
         does not wait for one. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
      <div id="emphasis-marker-clip" class="clip">
        <div id="backdrop"></div>
        <div id="content">
          <div id="block">
            <svg id="under" class="layer"></svg>
            <svg id="over" class="layer"></svg>
          </div>
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
      ${FLAT_HELPERS}
      ${SEED_HELPERS}

      // Layout per format (size a fraction of the short side, w the text block's share of the frame width). wide, square, tall.
      var L = M.pick({ size: 0.082, w: 0.7 }, { size: 0.078, w: 0.82 }, { size: 0.07, w: 0.86 });
      var words = String(P.text).split(/\\s+/).filter(Boolean).slice(0, 30);
      if (!words.length) words = ${JSON.stringify(DEFAULT_TEXT)}.split(" ");
      var n = words.length;
      var blockW = L.w * S.width;
      // The block fills at most about half the frame height: type size from the area, 0.55 em per character, 1.3 line height.
      var px = Math.min(L.size * unit * P.size, Math.sqrt((blockW * 0.5 * S.height) / (Math.max(1, words.join(" ").length) * 0.55 * 1.3)));

      var block = document.getElementById("block");
      block.style.cssText += "width:" + blockW + "px;font-size:" + px + "px;color:" + P.ink;
      var under = document.getElementById("under");
      var over = document.getElementById("over");
      var spans = [];
      words.forEach(function (text, i) {
        var mask = document.createElement("span");
        var word = document.createElement("span");
        mask.className = "mask";
        word.className = "word";
        word.textContent = text;
        mask.appendChild(word);
        block.appendChild(mask);
        if (i < n - 1) block.appendChild(document.createTextNode(" "));
        spans.push(word);
      });

      // The words to mark: the phrase as written (letters and digits only), else the last two words.
      function norm(text) {
        return String(text).toLowerCase().replace(/[^\\p{L}\\p{N}]/gu, "");
      }
      // Words with no letter or digit (a lone dash) are skipped on both sides; kept[k] is the word index of the k-th kept word.
      var kept = [];
      var plain = [];
      words.forEach(function (word, k) {
        var text = norm(word);
        if (text) { kept.push(k); plain.push(text); }
      });
      var want = String(P.mark).split(/\\s+/).map(norm).filter(Boolean);
      var first = -1;
      for (var i = 0; want.length && first < 0 && i + want.length <= plain.length; i++) {
        var same = true;
        for (var j = 0; j < want.length; j++) if (plain[i + j] !== want[j]) same = false;
        if (same) first = i;
      }
      var lastWord = n - 1;
      if (first < 0) first = Math.max(0, n - 2);
      else { lastWord = kept[first + want.length - 1]; first = kept[first]; }

      // The wobble: a seeded hash of the shape's index, so the same seed always draws the same mark. -1..1.
      var seed = seedOf(P.seed);
      function jit(k) { return jitter(seed, k); }
      var wob = P.rough * px * 0.045;
      var NS = "http://www.w3.org/2000/svg";
      function node(parent, tag, attrs) {
        var made = document.createElementNS(NS, tag);
        for (var key in attrs) made.setAttribute(key, attrs[key]);
        parent.appendChild(made);
        return made;
      }
      function pen(d) {
        return node(over, "path", { d: d, fill: "none", stroke: P.accent, "stroke-width": px * 0.075 * P.weight, "stroke-linecap": "round", "stroke-linejoin": "round", pathLength: 1, "stroke-dasharray": 1, "stroke-dashoffset": 1, opacity: 0 });
      }
      function line(pts) {
        return "M" + pts.map(function (p) { return Math.round(p[0] * 10) / 10 + " " + Math.round(p[1] * 10) / 10; }).join(" L");
      }

      // Rebuilt when the layout moves (a web font arriving re-wraps the words), from offsets that no transform changes.
      var cache = null;
      function scene() {
        var edge = spans[n - 1];
        var key = block.offsetHeight + ":" + edge.offsetLeft + ":" + edge.offsetTop + ":" + spans[0].offsetWidth;
        if (cache && cache.key === key) return cache;
        under.textContent = "";
        over.textContent = "";
        var segs = [];
        for (var k = first; k <= lastWord; k++) {
          var w = spans[k];
          var seg = segs[segs.length - 1];
          if (seg && Math.abs(seg.top - w.offsetTop) < 2) seg.r = w.offsetLeft + w.offsetWidth;
          else segs.push({ l: w.offsetLeft, r: w.offsetLeft + w.offsetWidth, top: w.offsetTop, h: w.offsetHeight });
        }
        var box = { l: segs[0].l, r: segs[0].r, t: segs[0].top, b: segs[0].top + segs[0].h };
        segs.forEach(function (seg) {
          box.l = Math.min(box.l, seg.l);
          box.r = Math.max(box.r, seg.r);
          box.t = Math.min(box.t, seg.top);
          box.b = Math.max(box.b, seg.top + seg.h);
        });
        // Each shape draws between fractions "from" and "to" of the mark's progress: lines one after another, the rest together.
        var shapes = [];
        var lengths = segs.map(function (seg) { return seg.r - seg.l; });
        var total = lengths.reduce(function (a, b) { return a + b; }, 0);
        var done = 0;
        var kind = P.marker;
        if (kind === "highlight" || kind === "underline" || kind === "strike") {
          segs.forEach(function (seg, k) {
            var from = done / total;
            done += lengths[k];
            var to = done / total;
            var l = seg.l - px * 0.12;
            var r = seg.r + px * 0.12;
            if (kind === "highlight") {
              var yTop = seg.top + seg.h * 0.1;
              var yBottom = seg.top + seg.h * 0.96;
              var shape = node(under, "path", { d: line([[l + wob * jit(k * 8), yTop + wob * jit(k * 8 + 1)], [r + wob * jit(k * 8 + 2), yTop + wob * jit(k * 8 + 3)], [r + wob * jit(k * 8 + 4), yBottom + wob * jit(k * 8 + 5)], [l + wob * jit(k * 8 + 6), yBottom + wob * jit(k * 8 + 7)]]) + " Z", fill: alpha(P.accent, 0.5), opacity: 0 });
              shapes.push({ el: shape, from: from, to: to, wipe: l });
            } else {
              var y = seg.top + seg.h * (kind === "underline" ? 0.93 : 0.58);
              var mid = (l + r) / 2;
              var d = line([[l, y + wob * jit(k * 4)], [mid, y + wob * jit(k * 4 + 1)], [r, y + wob * jit(k * 4 + 2)]]);
              shapes.push({ el: pen(d), from: from, to: to });
            }
          });
        } else {
          var pad = px * 0.2;
          var l = box.l - pad;
          var r = box.r + pad;
          var t = box.t + px * 0.04;
          var b = box.b - px * 0.02;
          if (kind === "box") {
            var path = line([[l + wob * jit(0), t + wob * jit(1)], [r + wob * jit(2), t + wob * jit(3)], [r + wob * jit(4), b + wob * jit(5)], [l + wob * jit(6), b + wob * jit(7)], [l + wob * jit(8), t + (b - t) * 0.14 + wob * jit(9)]]);
            shapes.push({ el: pen(path), from: 0, to: 1 });
          } else if (kind === "circle") {
            // An ellipse a little wider than the phrase, run for 1.1 turns from the upper left so the end overshoots the start.
            var cx = (l + r) / 2;
            var cy = (t + b) / 2;
            var rx = (r - l) / 2 * 1.08;
            var ry = Math.max((b - t) / 2 * 1.35, px * 0.9);
            var pts = [];
            var steps = 56;
            for (var s = 0; s <= steps; s++) {
              var turn = s / steps;
              var angle = (-2.5 + turn * 1.1 * 2 * Math.PI);
              var bulge = 1 + (P.rough * 0.05) * jit(2) * Math.sin(angle * 2 + 1) + 0.06 * turn;
              pts.push([cx + rx * bulge * Math.cos(angle), cy + ry * bulge * Math.sin(angle)]);
            }
            shapes.push({ el: pen(line(pts)), from: 0, to: 1 });
          } else {
            // Brackets either side, drawn together.
            var arm = px * 0.22;
            shapes.push({ el: pen(line([[l + arm, t + wob * jit(0)], [l + wob * jit(1), t + wob * jit(2)], [l + wob * jit(3), b + wob * jit(4)], [l + arm, b + wob * jit(5)]])), from: 0, to: 1 });
            shapes.push({ el: pen(line([[r - arm, t + wob * jit(6)], [r + wob * jit(7), t + wob * jit(8)], [r + wob * jit(9), b + wob * jit(10)], [r - arm, b + wob * jit(11)]])), from: 0, to: 1 });
          }
        }
        cache = { key: key, shapes: shapes };
        return cache;
      }

      var group = document.getElementById("content");
      var D = S.duration;
      var START = 0.1;
      var OUT = 0.3;
      var rise = px * 1.1;
      // The mark must finish, and show for a beat, before the exit: a late start is pulled in (never earlier than 0.5 s).
      var AT = Math.min(P.markAt, Math.max(0.5, D - OUT - 0.4 - P.drawTime));
      var stamp = function (v) { return String(Math.round(v * 1000) / 1000); };

      M.bind("${id}", function (t) {
        var out = M.ease("exit", (t - (D - OUT)) / OUT);
        put(backdrop, { opacity: P.backdrop * M.ease("enter", t / 0.3) * (1 - out) });
        put(group, { scale: 1 + 0.025 * Math.min(1, t / D) - 0.02 * out, opacity: 1 - out });
        var p = M.ease("enter", (t - AT) / P.drawTime);
        var strike = P.marker === "strike" ? 1 - 0.55 * M.ease("enter", (t - AT - 0.15) / 0.4) : 1;
        for (var i = 0; i < n; i++) {
          var d = M.stagger(i, n, M.STAGGER_STEPS.words);
          var dim = i >= first && i <= lastWord ? strike : 1;
          put(spans[i], { y: (1 - M.spring("heavy", t - START - d)) * rise, opacity: M.ease("enter", (t - START - d) / 0.2) * dim });
        }
        scene().shapes.forEach(function (shape) {
          var q = Math.min(1, Math.max(0, (p - shape.from) / (shape.to - shape.from)));
          if (shape.wipe === undefined) {
            shape.el.setAttribute("stroke-dashoffset", stamp(1 - q));
          } else {
            // The highlight is a pen wipe: scaled from its left edge.
            shape.el.setAttribute("transform", "translate(" + stamp(shape.wipe) + " 0) scale(" + stamp(flat(q)) + " 1) translate(" + stamp(-shape.wipe) + " 0)");
          }
          shape.el.setAttribute("opacity", q > 0 ? 1 : 0);
        });
      });
    </script>
  </body>
</html>
`;
    return trimScript(page);
  },
};
