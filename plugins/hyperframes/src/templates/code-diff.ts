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
 * Code diff (#466): one window shows the change between two snippets as a
 * unified diff. The unchanged and the removed lines come in; then each change is
 * lit in turn, a removed line on a red wash with a line struck through it, an
 * added line sliding in on a green one. Lines are matched by exact text, a
 * removed line before the one that replaces it. Every row has its place from
 * the first frame, so the window never changes size. Transparent around the
 * window unless `backdrop` is raised.
 */
export const codeDiff: Template = {
  id: "code-diff",
  description: "Code diff: removed and added lines of a change are highlighted one after another in a code window; transparent unless a background is set",
  defaultDuration: 5,
  overlay: true,
  variables({ tokens }: TemplateInput): TemplateVariable[] {
    return [
      {
        id: "before",
        type: "string",
        label: "The code before the change (up to 10 lines)",
        default: "async function load(id) {\n  const user = await getUser(id);\n  const name = user.name;\n  if (!name) return null;\n  render(name);\n}",
        maxLength: 600,
      },
      {
        id: "after",
        type: "string",
        label: "The code after the change (up to 10 lines)",
        default: 'async function load(id) {\n  const user = await getUser(id);\n  const name = user?.name ?? "Guest";\n  render(name);\n  logView(id);\n}',
        maxLength: 600,
      },
      { id: "changeAt", type: "number", label: "Seconds until the first change is lit", default: 1.2, min: 0.3, max: 4, step: 0.1, unit: "s" },
      { id: "lineGap", type: "number", label: "Seconds between one change and the next", default: 0.5, min: 0.15, max: 1.5, step: 0.05, unit: "s" },
      { id: "addColor", type: "color", label: "Added lines", default: "#3ddc97" },
      { id: "removeColor", type: "color", label: "Removed lines", default: "#ff5d6c" },
      ...codeVariables(tokens, "load.ts"),
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
      <div id="code-diff-clip" class="clip">
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
      var L = M.pick({ fs: 0.034, w: 0.74 }, { fs: 0.032, w: 0.8 }, { fs: 0.034, w: 0.88 });
      var before = codeLines(P.before, 10);
      var after = codeLines(P.after, 10);
      var diff = align(before, after, function (x, y) { return x === y; });
      var n = diff.length;
      var texts = diff.map(function (d) { return d.k === "add" ? after[d.b] : before[d.a]; });
      var cols = Math.max.apply(null, texts.map(function (text) { return text.length; }));
      var digits = P.numbers === "on" ? String(Math.max(before.length, after.length)).length : 0;
      var lay = codeLayout({ cols: cols, count: n, digits: digits, sign: 2, ratio: monoRatio(), fs: L.fs, w: L.w, scale: P.size, W: S.width, H: S.height, unit: unit });
      var colors = codeColors(P.card, P.accent, P.highlight === "quiet");
      var parts = codeWindow(lay, P.card, P.title, n, true);
      var win = document.getElementById("win");

      // Each row: its line number (the old one for a removed line), its colouring, and for a change its wash, edge, sign and strike-through.
      diff.forEach(function (d, i) {
        var part = parts[i];
        part.no.textContent = digits ? String((d.k === "del" ? d.a : d.b) + 1) : "";
        part.tx.innerHTML = tokenHtml(tokenize(texts[i], P.language), colors);
        if (d.k === "ctx") return;
        var hue = d.k === "add" ? P.addColor : P.removeColor;
        var body = texts[i].replace(/ +$/, "");
        var lead = body.length - body.replace(/^ +/, "").length;
        part.wash.style.background = alpha(hue, 0.17);
        part.edge.style.background = hue;
        part.sg.textContent = d.k === "add" ? "+" : "-";
        part.sg.style.color = hue;
        if (d.k === "del") part.cut.style.cssText += "left:" + (lay.pad + lay.gw + lay.sg + lead * lay.cw) + "px;width:" + (body.length - lead) * lay.cw + "px;background:" + hue;
      });

      var D = S.duration;
      var OUT = 0.3;
      var START = 0.15;
      var rise = lay.fs * 0.5;
      // The changes are lit one after another; a clip too short for them gets a shorter gap, then an earlier first change, so the last one is lit before the exit.
      var changes = [];
      diff.forEach(function (d, i) { if (d.k !== "ctx") changes.push(i); });
      var last = D - OUT - 0.45;
      var many = changes.length - 1;
      var first = many > 0 ? Math.max(0.1, Math.min(P.changeAt, last - many * 0.12)) : Math.min(P.changeAt, Math.max(0.1, last));
      var gap = many > 0 ? Math.max(0, Math.min(P.lineGap, (last - first) / many)) : P.lineGap;
      var turn = diff.map(function () { return 0; });
      changes.forEach(function (row, order) { turn[row] = first + order * gap; });

      M.bind("${id}", function (t) {
        var out = M.ease("exit", (t - (D - OUT)) / OUT);
        M.write(backdrop, { opacity: P.backdrop * M.ease("enter", t / 0.3) * (1 - out) });
        // Holds never stop: a slow push over the whole clip.
        var s = M.spring("heavy", t - 0.05);
        M.write(win, { y: (1 - s) * unit * 0.04, scale: 0.95 + 0.05 * s + 0.02 * Math.min(1, t / D) - 0.02 * out, opacity: M.ease("enter", t / 0.25) * (1 - out) });
        diff.forEach(function (d, i) {
          var part = parts[i];
          var come = START + M.stagger(i, n, M.STAGGER_STEPS.items);
          if (d.k !== "add") M.write(part.row, { y: (1 - M.spring("default", t - come)) * rise, opacity: M.ease("enter", (t - come) / 0.2) });
          if (d.k === "ctx") return;
          var f = t - turn[i];
          // The wash flashes in and settles back; the edge and the sign stay.
          M.write(part.wash, { opacity: M.ease("snap", f / 0.25) * (1 - 0.35 * M.ease("color", (f - 0.3) / 0.5)) });
          M.write(part.edge, { opacity: M.ease("snap", f / 0.2) });
          M.write(part.sg, { opacity: M.ease("enter", f / 0.2) });
          if (d.k === "add") {
            M.write(part.row, { x: (1 - M.spring("default", f)) * -lay.fs * 0.8, opacity: M.ease("enter", f / 0.2) });
          } else {
            put(part.cut, { scaleX: M.ease("camera", f / 0.35) });
            M.write(part.tx, { opacity: 1 - 0.45 * M.ease("color", (f - 0.1) / 0.4) });
          }
        });
      });
    </script>
  </body>
</html>
`;
  },
};
