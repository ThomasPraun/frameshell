import { CODE_CSS, CODE_MATH, CODE_WINDOW_HTML, codeVariables } from "./code-kit.js";
import {
  BACKDROP_CSS,
  BACKDROP_SETUP,
  COLOR_HELPERS,
  FLAT_HELPERS,
  type Template,
  type TemplateInput,
  type TemplateVariable,
  backdropVariables,
  pageHead,
} from "./kit.js";

/**
 * Code morph (#466): one snippet turns into another inside the same window.
 * Tokens (never spaces) of both snippets are matched in order by kind and text;
 * a matched token travels from its place in the first snippet to its place in
 * the second, a token only the first has fades out, one only the second has
 * rises in. The window is as large as the larger snippet from the first frame.
 * Transparent around the window unless `backdrop` is raised.
 */
export const codeMorph: Template = {
  id: "code-morph",
  description: "Code morph: one snippet morphs into another, matching tokens travel to their new place; transparent unless a background is set",
  defaultDuration: 5,
  overlay: true,
  variables({ tokens }: TemplateInput): TemplateVariable[] {
    return [
      {
        id: "before",
        type: "string",
        label: "The first snippet (up to 12 lines)",
        default: "const sum = a + b;\nreturn sum;",
        maxLength: 600,
      },
      {
        id: "after",
        type: "string",
        label: "The snippet it becomes (up to 12 lines)",
        default: "function add(a, b) {\n  const sum = a + b;\n  return sum;\n}",
        maxLength: 600,
      },
      { id: "morphAt", type: "number", label: "Seconds the first snippet holds before it morphs", default: 1.4, min: 0.5, max: 4, step: 0.1, unit: "s" },
      { id: "morphTime", type: "number", label: "Seconds the morph takes", default: 1, min: 0.3, max: 3, step: 0.05, unit: "s" },
      ...codeVariables(tokens, "math.js"),
      ...backdropVariables(tokens),
    ];
  },
  render(input: TemplateInput): string {
    const { id, width, height, duration } = input;
    const css = `
      ${BACKDROP_CSS}
      ${CODE_CSS}`;
    return `${pageHead(input, this.variables(input), css)}
  <body>
    <!-- Root: size and length of the render. FrameshellMotion.bind below registers its timeline, so the render
         does not wait for one. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
      <div id="code-morph-clip" class="clip">
        <div id="backdrop"></div>
        <div id="content">
          ${CODE_WINDOW_HTML}
        </div>
      </div>
    </div>
    <script>
      var M = window.FrameshellMotion;
      var P = M.props();
      var S = M.stage();
      var unit = Math.min(S.width, S.height);
      ${COLOR_HELPERS}
      ${FLAT_HELPERS}
      ${BACKDROP_SETUP}
      ${CODE_MATH}

      // Layout per format: type size as a fraction of the short side, widest window as a fraction of the frame. wide, square, tall.
      var L = M.pick({ fs: 0.036, w: 0.74 }, { fs: 0.034, w: 0.9 }, { fs: 0.036, w: 0.92 });
      var first = codeRows(P.before, P.language, 12);
      var second = codeRows(P.after, P.language, 12);
      // Every token that is not a space, with the row it sits on.
      function solid(rows) {
        var list = [];
        rows.forEach(function (row, r) { row.tokens.forEach(function (token) { if (token.k !== "ws") list.push({ k: token.k, s: token.s, c: token.c, r: r }); }); });
        return list;
      }
      var tokensA = solid(first);
      var tokensB = solid(second);
      var pairs = align(tokensA, tokensB, function (x, y) { return x.k === y.k && x.s === y.s; });
      var count = Math.max(first.length, second.length);
      var cols = Math.max.apply(null, first.concat(second).map(function (row) { return row.text.length; }));
      var digits = P.numbers === "on" ? String(count).length : 0;
      var lay = codeLayout({ cols: cols, count: count, digits: digits, sign: 0, ratio: monoRatio(), fs: L.fs, w: L.w, scale: P.size, W: S.width, H: S.height, unit: unit });
      var colors = codeColors(P.card, P.accent, P.highlight === "quiet");
      var parts = codeWindow(lay, P.card, P.title, count, false);
      parts.forEach(function (part, i) { part.no.textContent = digits ? String(i + 1) : ""; });
      var win = document.getElementById("win");
      var layer = document.getElementById("layer");
      layer.style.cssText += "left:" + (lay.pad + lay.gw) + "px";

      // One span per pairing: from and to are the token's place (pixels in the layer) in the first and the second snippet, or null where it has none.
      var at = function (token) { return token ? { x: token.c * lay.cw, y: token.r * lay.lh } : null; };
      var moving = 0;
      var marks = pairs.map(function (pair) {
        var token = pair.k === "add" ? tokensB[pair.b] : tokensA[pair.a];
        var span = document.createElement("span");
        span.className = "tk";
        span.style.cssText += "color:" + colors[token.k];
        span.textContent = token.s;
        layer.appendChild(span);
        return { span: span, kind: pair.k, from: at(pair.k === "add" ? null : tokensA[pair.a]), to: at(pair.k === "del" ? null : tokensB[pair.b]), order: pair.k === "ctx" ? moving++ : 0 };
      });
      var D = S.duration;
      var OUT = 0.3;
      var START = 0.15;
      var rise = lay.fs * 0.5;
      var rank = 0;
      var begins = marks.map(function (mark) { return mark.kind === "add" ? 0 : rank++; });

      M.bind("${id}", function (t) {
        var out = M.ease("exit", (t - (D - OUT)) / OUT);
        M.write(backdrop, { opacity: P.backdrop * M.ease("enter", t / 0.3) * (1 - out) });
        // Holds never stop: a slow push over the whole clip.
        var s = M.spring("heavy", t - 0.05);
        M.write(win, { y: (1 - s) * unit * 0.04, scale: 0.95 + 0.05 * s + 0.02 * Math.min(1, t / D) - 0.02 * out, opacity: M.ease("enter", t / 0.25) * (1 - out) });
        var go = t - P.morphAt;
        var len = P.morphTime;
        marks.forEach(function (mark, i) {
          if (mark.kind === "add") {
            var up = M.ease("enter", (go - 0.4 * len) / (0.5 * len));
            put(mark.span, { x: mark.to.x, y: mark.to.y + (1 - up) * rise, opacity: up });
            return;
          }
          // The first snippet comes in token by token.
          var seen = M.ease("enter", (t - START - M.stagger(begins[i], rank, 0.012, { maxTotal: 0.4 })) / 0.25);
          if (mark.kind === "del") {
            var gone = M.ease("color", go / (0.35 * len));
            put(mark.span, { x: mark.from.x, y: mark.from.y, scale: 1 - 0.08 * gone, opacity: seen * (1 - gone) });
            return;
          }
          var e = M.ease("camera", (go - M.stagger(mark.order, moving, 0.03, { maxTotal: 0.3 * len })) / (0.7 * len));
          put(mark.span, { x: mark.from.x + (mark.to.x - mark.from.x) * e, y: mark.from.y + (mark.to.y - mark.from.y) * e, opacity: seen });
        });
        // Line numbers of rows only one snippet has fade out or in with the morph.
        parts.forEach(function (part, i) {
          var gone = i >= second.length ? M.ease("color", go / (0.35 * len)) : 0;
          var born = i >= first.length ? M.ease("enter", (go - 0.4 * len) / (0.5 * len)) : 1;
          M.write(part.no, { opacity: 0.38 * (1 - gone) * born * M.ease("enter", t / 0.3) });
        });
      });
    </script>
  </body>
</html>
`;
  },
};
