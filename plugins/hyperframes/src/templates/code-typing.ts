import { CODE_CSS, CODE_MATH, CODE_WINDOW_HTML, codeVariables } from "./code-kit.js";
import {
  BACKDROP_CSS,
  BACKDROP_SETUP,
  COLOR_HELPERS,
  type Template,
  type TemplateInput,
  type TemplateVariable,
  backdropVariables,
  pageHead,
} from "./kit.js";
import { TYPING_MATH } from "./typing-kit.js";

/**
 * Code typing: a code window where the snippet types out key by key
 * with the seeded rhythm of `typing-field` and a caret that blinks when it
 * rests. The indentation of a line appears with the Enter before it, as an
 * editor does. `pauses` names lines the typing waits after. The window keeps its
 * final size from the first frame; a snippet too long for the clip types faster
 * (timing guard). Transparent around the window unless `backdrop` is raised.
 */
export const codeTyping: Template = {
  id: "code-typing",
  description: "Code typing: a snippet types out in a code window with a caret, speed and pauses from props; transparent unless a background is set",
  defaultDuration: 6,
  overlay: true,
  variables({ tokens }: TemplateInput): TemplateVariable[] {
    return [
      {
        id: "code",
        type: "string",
        label: "The code that is typed (up to 14 lines)",
        default: 'const clip = await project.addClip("intro.mp4");\nawait clip.trim({ start: 2, end: 8 });\nawait project.export("reels");',
        maxLength: 600,
      },
      { id: "speed", type: "number", label: "Characters typed per second", default: 22, min: 6, max: 80, step: 1 },
      { id: "startAt", type: "number", label: "Seconds until the first key", default: 0.7, min: 0.2, max: 3, step: 0.1, unit: "s" },
      { id: "pauses", type: "string", label: "Line numbers to wait after, separated by commas; empty for none", default: "", maxLength: 40 },
      { id: "pauseTime", type: "number", label: "Seconds each wait lasts", default: 0.6, min: 0.1, max: 2, step: 0.05, unit: "s" },
      ...codeVariables(tokens, "clip.ts"),
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
      <div id="code-typing-clip" class="clip">
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
      ${BACKDROP_SETUP}
      ${TYPING_MATH}
      ${CODE_MATH}

      // Layout per format: type size as a fraction of the short side, widest window as a fraction of the frame. wide, square, tall.
      var L = M.pick({ fs: 0.036, w: 0.74 }, { fs: 0.034, w: 0.9 }, { fs: 0.036, w: 0.92 });
      var rows = codeRows(P.code, P.language, 14);
      var count = rows.length;
      var cols = Math.max.apply(null, rows.map(function (r) { return r.text.length; }));
      var digits = P.numbers === "on" ? String(count).length : 0;
      var lay = codeLayout({ cols: cols, count: count, digits: digits, sign: 0, ratio: monoRatio(), fs: L.fs, w: L.w, scale: P.size, W: S.width, H: S.height, unit: unit });
      var colors = codeColors(P.card, P.accent, P.highlight === "quiet");
      var parts = codeWindow(lay, P.card, P.title, count, false);
      parts.forEach(function (part, i) { part.no.textContent = digits ? String(i + 1) : ""; });
      var win = document.getElementById("win");
      var caret = document.getElementById("caret");
      caret.style.cssText += "height:" + lay.fs * 1.2 + "px;background:" + P.accent;
      var barH = lay.fs * 1.2;

      // One entry per key (a character, or Enter); states[k] is where the caret is after k keys: the row and how many characters of it show. An indent appears with the Enter before it.
      var indent = rows.map(function (r) { return r.text.length - r.text.replace(/^ +/, "").length; });
      var keys = [];
      var states = [{ row: 0, upto: indent[0] }];
      var lineOf = [];
      rows.forEach(function (r, i) {
        for (var c = indent[i]; c < r.text.length; c++) {
          keys.push(r.text.charAt(c));
          lineOf.push(i);
          states.push({ row: i, upto: c + 1 });
        }
        if (i < count - 1) {
          keys.push("\\n");
          lineOf.push(i);
          states.push({ row: i + 1, upto: indent[i + 1] });
        }
      });
      var waits = String(P.pauses).split(",").map(function (v) { return Math.round(Number(v)) - 1; }).filter(function (v) { return v >= 0 && v < count - 1; });

      var D = S.duration;
      var OUT = 0.3;
      // In a clip too short for the typing and the waits, both speed up together (never past a sixth of the time asked).
      var asked = rhythm(keys, P.startAt, P.speed);
      var needed = asked.end - P.startAt + waits.length * P.pauseTime;
      var fit = Math.max(0.15, Math.min(1, (D - OUT - P.startAt - 0.5) / Math.max(needed, 0.1)));
      var typing = rhythm(keys, P.startAt, P.speed / fit);
      var when = typing.when.map(function (at, k) {
        var late = 0;
        waits.forEach(function (w) { if (lineOf[k] > w || (lineOf[k] === w && keys[k] === "\\n")) late += P.pauseTime * fit; });
        return at + late;
      });
      var shown = -1;

      M.bind("${id}", function (t) {
        var out = M.ease("exit", (t - (D - OUT)) / OUT);
        M.write(backdrop, { opacity: P.backdrop * M.ease("enter", t / 0.3) * (1 - out) });
        // Holds never stop: a slow push over the whole clip.
        var s = M.spring("heavy", t - 0.05);
        M.write(win, { y: (1 - s) * unit * 0.04, scale: 0.95 + 0.05 * s + 0.02 * Math.min(1, t / D) - 0.02 * out, opacity: M.ease("enter", t / 0.25) * (1 - out) });

        // Keys pressed so far, and the text they leave: whole rows above the caret, a prefix of its own row.
        var k = 0;
        while (k < when.length && when[k] <= t) k++;
        var at = states[k];
        if (k !== shown) {
          shown = k;
          parts.forEach(function (part, i) {
            part.tx.innerHTML = i < at.row ? tokenHtml(rows[i].tokens, colors) : i === at.row ? tokenHtml(rows[i].tokens, colors, at.upto) : "";
          });
        }
        // Solid for 0.4 s after a key, then blinking from that key on: a function of t and the keys alone.
        var held = t - (k ? when[k - 1] : 0);
        var lit = held < 0.4 || Math.floor((held - 0.4) / 0.53) % 2 === 0;
        M.write(caret, { x: lay.pad + lay.gw + at.upto * lay.cw, y: at.row * lay.lh + (lay.lh - barH) / 2, opacity: lit ? M.ease("enter", (t - 0.1) / 0.2) : 0 });
      });
    </script>
  </body>
</html>
`;
  },
};
