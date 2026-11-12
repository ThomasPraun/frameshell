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

/**
 * Comparison (#466): the rejected option rises in, a line strikes it out and
 * it dims, then the chosen option springs in on a solid accent pill. Side by
 * side on wide frames, stacked on square and tall ones. Transparent unless
 * `backdrop` is raised.
 */
export const comparison: Template = {
  id: "comparison",
  description: "Comparison: the old option is crossed out, the chosen one springs in on an accent pill; transparent unless a background is set",
  defaultDuration: 4,
  overlay: true,
  variables({ tokens }: TemplateInput): TemplateVariable[] {
    return [
      { id: "rejected", type: "string", label: "Option that gets crossed out", default: "Manual editing", maxLength: 40 },
      { id: "chosen", type: "string", label: "Chosen option", default: tokens.brand.product ?? "Frameshell", maxLength: 40 },
      { id: "strikeAt", type: "number", label: "Seconds until the strike-through", default: 1.1, min: 0.5, max: 4, step: 0.1, unit: "s" },
      { id: "ink", type: "color", label: "Text colour", default: tokens.colors.ink ?? PLACEHOLDER.ink },
      { id: "accent", type: "color", label: "Chosen pill colour", default: tokens.colors.accent ?? PLACEHOLDER.accent },
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
      #pair { display: flex; align-items: center; justify-content: center; max-width: 92%; }
      #old, #new { position: relative; font-family: ${fonts.display}; font-weight: ${fonts.displayWeight}; line-height: 1.05; letter-spacing: -0.01em; text-align: center; }
      /* The mask clips a line while it travels; the padding keeps accents and descenders inside it. */
      .mask { overflow: hidden; padding: 0.1em 0.04em 0.16em; margin: -0.1em -0.04em -0.16em; }
      #strike { position: absolute; left: -0.06em; right: -0.06em; top: 52%; height: 0.07em; margin-top: -0.035em; border-radius: 999px; transform-origin: 0 50%; }
      #pill { position: absolute; inset: -0.14em -0.4em; border-radius: 0.42em; }
      #new-mask { position: relative; }
      #old-text, #new-text { display: inline-block; }`;
    return `${pageHead(input, this.variables(input), css)}
  <body>
    <!-- Root: size and length of the render. FrameshellMotion.bind below registers its timeline, so the render
         does not wait for one. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
      <div id="comparison-clip" class="clip">
        <div id="backdrop"></div>
        <div id="content">
          <div id="pair">
            <div id="old">
              <div class="mask"><span id="old-text"></span></div>
              <i id="strike"></i>
            </div>
            <div id="new">
              <i id="pill"></i>
              <div class="mask" id="new-mask"><span id="new-text"></span></div>
            </div>
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

      // Layout per format (sizes are fractions of the short side). wide, square, tall.
      var L = M.pick(
        { row: true, old: 0.085, chosen: 0.12, gap: 0.13 },
        { row: false, old: 0.08, chosen: 0.115, gap: 0.1 },
        { row: false, old: 0.085, chosen: 0.115, gap: 0.09 }
      );
      var px = unit * P.size;

      var pair = document.getElementById("pair");
      pair.style.flexDirection = L.row ? "row" : "column";
      pair.style.gap = L.gap * px + "px";
      pair.style.color = P.ink;

      var old = document.getElementById("old");
      old.style.fontSize = L.old * px + "px";
      var oldText = document.getElementById("old-text");
      oldText.textContent = P.rejected;
      var strike = document.getElementById("strike");
      strike.style.background = P.ink;

      var chosen = document.getElementById("new");
      chosen.style.fontSize = L.chosen * px + "px";
      chosen.style.color = onColor(P.accent);
      var pill = document.getElementById("pill");
      pill.style.background = P.accent;
      var chosenText = document.getElementById("new-text");
      chosenText.textContent = P.chosen;

      var D = S.duration;
      var OUT = 0.3;
      var rise = L.old * px * 1.3;
      var AT = P.strikeAt;

      M.bind("${id}", function (t) {
        var out = M.ease("exit", (t - (D - OUT)) / OUT);
        M.write(backdrop, { opacity: P.backdrop * M.ease("enter", t / 0.3) * (1 - out) });
        // Holds never stop: a slow push over the whole clip.
        M.write(pair, { scale: 1 + 0.025 * Math.min(1, t / D) - 0.02 * out, opacity: 1 - out });
        var struck = M.ease("camera", (t - AT - 0.15) / 0.35);
        M.write(old, { scale: 1 - 0.06 * struck });
        M.write(oldText, { y: (1 - M.spring("heavy", t - 0.1)) * rise, opacity: M.ease("enter", (t - 0.1) / 0.2) * (1 - 0.5 * struck) });
        M.write(strike, { scaleX: M.ease("snap", (t - AT) / 0.3), opacity: 0.9 * M.ease("enter", (t - AT) / 0.05) });
        var at = AT + 0.35;
        M.write(pill, { scale: 0.7 + 0.3 * M.spring("snappy", t - at), opacity: M.ease("enter", (t - at) / 0.15) });
        M.write(chosenText, { y: (1 - M.spring("heavy", t - at - 0.05)) * rise * 1.2, opacity: M.ease("enter", (t - at - 0.05) / 0.2) });
      });
    </script>
  </body>
</html>
`;
  },
};
