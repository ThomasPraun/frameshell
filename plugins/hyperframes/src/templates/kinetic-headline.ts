import { PLACEHOLDER, type Template, type TemplateInput, type TemplateVariable, fontSetup, pageHead } from "./kit.js";

/**
 * Kinetic headline (#466): the words rise one by one through a mask, the
 * keyword in the accent colour, a slow drift while it holds, an exit through
 * the same mask. Transparent background, so it works over footage.
 */
export const kineticHeadline: Template = {
  id: "kinetic-headline",
  description: "Headline whose words rise through a mask, keyword in the accent colour; transparent over footage",
  defaultDuration: 3,
  overlay: true,
  variables({ tokens }: TemplateInput): TemplateVariable[] {
    return [
      { id: "headline", type: "string", label: "Headline", default: "Say it with motion", maxLength: 80 },
      { id: "keyword", type: "string", label: "Keyword in the accent colour (one or more words of the headline)", default: "motion", maxLength: 40 },
      { id: "ink", type: "color", label: "Text colour", default: tokens.colors.ink ?? PLACEHOLDER.ink },
      { id: "accent", type: "color", label: "Keyword colour", default: tokens.colors.accent ?? PLACEHOLDER.accent },
      { id: "size", type: "number", label: "Type size, 1 = the format's default", default: 1, min: 0.5, max: 1.6, step: 0.05 },
      { id: "shade", type: "number", label: "Dark glow behind the text, 0 = none", default: 0.35, min: 0, max: 0.8, step: 0.05 },
      { id: "drift", type: "number", label: "Slow push while it holds, percent", default: 2, min: 0, max: 6, step: 0.5, unit: "%" },
      {
        id: "align",
        type: "enum",
        label: "Alignment",
        default: "auto",
        options: [
          { value: "auto", label: "By format" },
          { value: "left", label: "Left" },
          { value: "center", label: "Centre" },
        ],
      },
    ];
  },
  render(input: TemplateInput): string {
    const { id, width, height, duration } = input;
    const fonts = fontSetup(input.tokens);
    const css = `
      #shade { position: absolute; inset: 0; }
      #headline {
        position: absolute; display: flex; flex-wrap: wrap; align-content: center; column-gap: 0.26em; row-gap: 0.02em;
        font-family: ${fonts.display}; font-weight: ${fonts.displayWeight}; line-height: 1.06; letter-spacing: -0.01em;
        text-shadow: 0 0.04em 0.3em rgba(0, 0, 0, 0.25);
      }
      /* The mask clips a word while it travels; the padding keeps accents and descenders inside it. */
      .mask { display: inline-block; overflow: hidden; padding: 0.1em 0.04em 0.16em; margin: -0.1em -0.04em -0.16em; }
      .word { display: inline-block; }`;
    return `${pageHead(input, this.variables(input), css)}
  <body>
    <!-- Root: size and length of the render. FrameshellMotion.bind below registers its timeline, so the render
         does not wait for one. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
      <div id="headline-clip" class="clip">
        <div id="shade"></div>
        <h1 id="headline"></h1>
      </div>
    </div>
    <script>
      var M = window.FrameshellMotion;
      var P = M.props();
      var S = M.stage();
      var unit = Math.min(S.width, S.height);

      // Layout per format (fractions of the frame; size is a fraction of the short side). wide, square, tall.
      var L = M.pick(
        { x: 0.08, y: 0.5, w: 0.62, size: 0.11, align: "left" },
        { x: 0.09, y: 0.5, w: 0.82, size: 0.105, align: "left" },
        { x: 0.08, y: 0.44, w: 0.84, size: 0.088, align: "center" }
      );
      var align = P.align === "auto" ? L.align : P.align;
      var px = L.size * unit * P.size;

      var head = document.getElementById("headline");
      head.style.left = (align === "center" ? (1 - L.w) / 2 : L.x) * S.width + "px";
      head.style.width = L.w * S.width + "px";
      head.style.top = (L.y - 0.5) * S.height + "px";
      head.style.height = S.height + "px";
      head.style.fontSize = px + "px";
      head.style.color = P.ink;
      head.style.textAlign = align;
      head.style.justifyContent = align === "center" ? "center" : "flex-start";
      head.style.transformOrigin = (align === "center" ? "50%" : "0%") + " 50%";

      var shade = document.getElementById("shade");
      var shadeX = align === "center" ? 50 : (L.x + L.w / 2) * 100;
      shade.style.background =
        "radial-gradient(ellipse 80% 70% at " + shadeX + "% " + L.y * 100 + "%, rgba(0, 0, 0, " + P.shade + ") 0%, rgba(0, 0, 0, 0) 100%)";

      function bare(word) { return word.replace(/[^\\p{L}\\p{N}]/gu, "").toLowerCase(); }
      var keys = String(P.keyword).split(/\\s+/).map(bare).filter(Boolean);
      var marks = [];
      String(P.headline).split(/\\s+/).filter(Boolean).forEach(function (text) {
        var mask = document.createElement("span");
        var word = document.createElement("span");
        mask.className = "mask";
        word.className = "word";
        word.textContent = text;
        if (keys.indexOf(bare(text)) >= 0) word.style.color = P.accent;
        mask.appendChild(word);
        head.appendChild(mask);
        marks.push(word);
      });

      var D = S.duration;
      var START = 0.15;  // first word starts rising
      var OUT = 0.3;     // exit: 60 % of the 0.5 s enter
      var rise = px * 1.3;
      var n = marks.length;
      var lag = M.stagger(n - 1, n, M.STAGGER_STEPS.words);

      M.bind("${id}", function (t) {
        for (var i = 0; i < n; i++) {
          var d = M.stagger(i, n, M.STAGGER_STEPS.words);
          var enter = M.spring("heavy", t - START - d);
          var exit = M.ease("exit", (t - (D - OUT - lag + d)) / OUT);
          M.write(marks[i], { y: (1 - enter) * rise - exit * rise, opacity: M.ease("enter", (t - START - d) / 0.2) });
        }
        // Holds never stop: a slow push over the whole clip.
        M.write(head, { scale: 1 + (P.drift / 100) * Math.min(1, t / D) });
        M.write(shade, { opacity: M.ease("enter", t / 0.4) * (1 - M.ease("exit", (t - (D - OUT)) / OUT)) });
      });
    </script>
  </body>
</html>
`;
  },
};
