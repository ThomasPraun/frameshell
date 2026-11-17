import {
  COLOR_HELPERS,
  FLAT_HELPERS,
  PLACEHOLDER,
  type Template,
  type TemplateInput,
  type TemplateVariable,
  fontSetup,
  pageHead,
} from "./kit.js";

/**
 * Spotlight (#466 TP4): the whole frame dims except a soft round pool of light
 * on a target, which travels to a second target and lands there. The dim is one
 * layer of plain alpha (a radial gradient, clear in the middle, rewritten from the
 * time on every frame; no blend mode, which once rendered a whole film white), so
 * it needs no mask and no compositing trick. The layer is clear at the first
 * frame and from the exit on: the pool opens from a wide one as the dim comes in.
 * Targets are the centres `x`, `y` and `x2`, `y2` as fractions of the frame and a
 * radius as a fraction of the short side, so one pair suits every format; each
 * target may carry a small label that is lit with it. Equal targets mean no move.
 * Transparent clip over footage, dim only.
 */
export const spotlight: Template = {
  id: "spotlight",
  description: "Spotlight: the frame dims except a soft pool of light on a target, which moves to a second target; optional labels; a dim layer for footage, transparent where the light is",
  defaultDuration: 4.5,
  overlay: true,
  variables({ tokens }: TemplateInput): TemplateVariable[] {
    return [
      { id: "x", type: "number", label: "First target, centre from the left as a fraction of the frame width", default: 0.3, min: 0, max: 1, step: 0.01 },
      { id: "y", type: "number", label: "First target, centre from the top as a fraction of the frame height", default: 0.5, min: 0, max: 1, step: 0.01 },
      { id: "x2", type: "number", label: "Second target, centre from the left as a fraction of the frame width; equal to the first for no move", default: 0.7, min: 0, max: 1, step: 0.01 },
      { id: "y2", type: "number", label: "Second target, centre from the top as a fraction of the frame height", default: 0.5, min: 0, max: 1, step: 0.01 },
      { id: "radius", type: "number", label: "Radius of the pool of light as a fraction of the short side", default: 0.22, min: 0.05, max: 0.6, step: 0.01 },
      { id: "label", type: "string", label: "Label of the first target; empty for none", default: "", maxLength: 30 },
      { id: "label2", type: "string", label: "Label of the second target; empty for none", default: "", maxLength: 30 },
      { id: "dim", type: "number", label: "How dark the rest of the frame gets, 1 = black", default: 0.75, min: 0.2, max: 0.95, step: 0.05 },
      { id: "soft", type: "number", label: "Softness of the pool's edge, 0.1 = crisp, 1 = a glow", default: 0.5, min: 0.1, max: 1, step: 0.05 },
      { id: "moveAt", type: "number", label: "Seconds until the light leaves the first target (pulled in on a short clip)", default: 1.7, min: 0.5, max: 6, step: 0.1, unit: "s" },
      { id: "moveTime", type: "number", label: "Seconds the light takes to reach the second target (shortened on a short clip)", default: 0.9, min: 0.3, max: 3, step: 0.1, unit: "s" },
      { id: "shade", type: "color", label: "Colour of the dim", default: "#000000" },
      { id: "accent", type: "color", label: "Label colour", default: tokens.colors.accent ?? PLACEHOLDER.accent },
    ];
  },
  render(input: TemplateInput): string {
    const { id, width, height, duration } = input;
    const fonts = fontSetup(input.tokens);
    const css = `
      #dim { position: absolute; inset: 0; }
      .tag { position: absolute; width: 0; height: 0; display: flex; align-items: flex-start; justify-content: center; }
      .label { flex: none; white-space: nowrap; max-width: 60vw; overflow: hidden; text-overflow: ellipsis; font-family: ${fonts.ui}; font-weight: 700; line-height: 1.1; padding: 0.3em 0.8em 0.36em; border-radius: 999px; opacity: 0; }`;
    return `${pageHead(input, this.variables(input), css)}
  <body>
    <!-- Root: size and length of the render. FrameshellMotion.bind below registers its timeline, so the render
         does not wait for one. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
      <div id="spotlight-clip" class="clip">
        <div id="dim"></div>
        <div class="tag" id="tag0"><span class="label" id="l0"></span></div>
        <div class="tag" id="tag1"><span class="label" id="l1"></span></div>
      </div>
    </div>
    <script>
      var M = window.FrameshellMotion;
      var P = M.props();
      var S = M.stage();
      var unit = Math.min(S.width, S.height);
      ${COLOR_HELPERS}
      ${FLAT_HELPERS}

      // Layout per format: label size as a fraction of the short side, the gap between the pool's edge and its label as a fraction of the radius. wide, square, tall.
      var L = M.pick({ fs: 0.03, gap: 0.12 }, { fs: 0.034, gap: 0.12 }, { fs: 0.034, gap: 0.1 });
      var fs = L.fs * unit;
      var r = P.radius * unit;
      var a = { x: P.x * S.width, y: P.y * S.height };
      var b = { x: P.x2 * S.width, y: P.y2 * S.height };
      var dim = document.getElementById("dim");

      // A label is lit with its target: under the pool, or above it when there is no room below.
      var tags = [[a, String(P.label).trim()], [b, String(P.label2).trim()]].map(function (target, k) {
        var tag = document.getElementById("tag" + k);
        var chip = document.getElementById("l" + k);
        var below = target[0].y + r * (1 + L.gap) + 2.2 * fs < 0.97 * S.height;
        tag.style.left = target[0].x + "px";
        if (below) tag.style.top = target[0].y + r * (1 + L.gap) + "px";
        else tag.style.top = target[0].y - r * (1 + L.gap) - 1.8 * fs + "px";
        chip.textContent = target[1];
        chip.style.fontSize = fs + "px";
        chip.style.background = P.accent;
        chip.style.color = onColor(P.accent);
        if (!target[1]) chip.style.display = "none";
        return chip;
      });

      var D = S.duration;
      var OUT = 0.3;
      // The light has to arrive and its label to show for 0.4 s before the exit: a late move is pulled in, a slow one shortened.
      var travel = Math.min(P.moveTime, Math.max(0.3, D - OUT - 0.9));
      var AT = Math.min(P.moveAt, Math.max(0.5, D - OUT - travel - 0.4));
      var moves = a.x !== b.x || a.y !== b.y;

      M.bind("${id}", function (t) {
        var out = M.ease("exit", (t - (D - OUT)) / OUT);
        var opened = M.ease("enter", t / 0.6);
        var go = moves ? M.ease("camera", (t - AT) / travel) : 0;
        // The pool opens from a wide one, narrows a little on the way between targets and swells slowly while it holds.
        var bump = go > 0 && go < 1 ? Math.sin(Math.PI * go) : 0;
        var rr = r * (1 + 1.2 * (1 - opened) - 0.1 * bump + 0.04 * Math.min(1, t / D));
        var cx = a.x + (b.x - a.x) * go;
        var cy = a.y + (b.y - a.y) * go;
        // Clear in the middle, the full dim at the far side of the edge; plain alpha, rewritten from t alone.
        var clear = rr * (1 - 0.9 * P.soft);
        var full = rr * (1 + 0.7 * P.soft);
        var tint = rgb(P.shade).join(", ");
        var alphaNow = Math.round(P.dim * M.ease("enter", t / 0.35) * (1 - out) * 1000) / 1000;
        dim.style.background = "radial-gradient(circle at " + cx.toFixed(2) + "px " + cy.toFixed(2) + "px, rgba(" + tint + ", 0) " + clear.toFixed(2) + "px, rgba(" + tint + ", " + alphaNow + ") " + full.toFixed(2) + "px)";
        // The first label is lit until the light leaves it, the second once the light has arrived.
        var gone = moves ? M.ease("enter", (t - AT) / 0.2) : 0;
        var came = moves ? M.ease("enter", (t - AT - travel) / 0.25) : 0;
        put(tags[0], { y: (1 - M.ease("enter", (t - 0.35) / 0.3)) * fs * 0.6, opacity: M.ease("enter", (t - 0.35) / 0.3) * (1 - gone) * (1 - out) });
        put(tags[1], { y: (1 - came) * fs * 0.6, opacity: came * (1 - out) });
      });
    </script>
  </body>
</html>
`;
  },
};
