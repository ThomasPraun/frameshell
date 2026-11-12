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
 * Logo lockup (#466): the logo springs in, the name and the tagline rise
 * through a mask and an accent rule draws between them. Side by side on wide
 * frames, stacked on square and tall ones. Transparent unless `backdrop` is
 * raised.
 */
export const logoLockup: Template = {
  id: "logo-lockup",
  description: "Logo lockup: logo, name, accent rule and tagline, side by side or stacked by format; transparent unless a background is set",
  defaultDuration: 3.5,
  overlay: true,
  variables({ tokens }: TemplateInput): TemplateVariable[] {
    return [
      { id: "name", type: "string", label: "Name", default: tokens.brand.product ?? "Your brand", maxLength: 40 },
      { id: "tagline", type: "string", label: "Tagline under the name", default: "Made for makers", maxLength: 60 },
      {
        id: "logo",
        type: "image",
        label: "Logo",
        default: "",
        description: "Path of an image inside this composition's directory, e.g. logo.png; empty shows no logo",
      },
      { id: "ink", type: "color", label: "Text colour", default: tokens.colors.ink ?? PLACEHOLDER.ink },
      { id: "accent", type: "color", label: "Rule colour", default: tokens.colors.accent ?? PLACEHOLDER.accent },
      { id: "size", type: "number", label: "Size, 1 = the format's default", default: 1, min: 0.5, max: 1.6, step: 0.05 },
      { id: "drift", type: "number", label: "Slow push while it holds, percent", default: 3, min: 0, max: 8, step: 0.5, unit: "%" },
      {
        id: "layout",
        type: "enum",
        label: "Arrangement",
        default: "auto",
        options: [
          { value: "auto", label: "By format" },
          { value: "side", label: "Logo beside the name" },
          { value: "stacked", label: "Logo above the name" },
        ],
      },
      ...backdropVariables(tokens),
    ];
  },
  render(input: TemplateInput): string {
    const { id, width, height, duration } = input;
    const fonts = fontSetup(input.tokens);
    const css = `
      ${BACKDROP_CSS}
      #content { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
      #lockup { display: flex; align-items: center; justify-content: center; max-width: 90%; }
      #logo { object-fit: contain; }
      #words { display: flex; flex-direction: column; }
      /* The mask clips a line while it travels; the padding keeps accents and descenders inside it. */
      .mask { overflow: hidden; padding: 0.08em 0.04em 0.14em; margin: -0.08em -0.04em -0.14em; }
      #name { font-family: ${fonts.display}; font-weight: ${fonts.displayWeight}; line-height: 1.05; letter-spacing: -0.01em; }
      #rule { display: block; height: 0.07em; border-radius: 999px; }
      #tagline { font-family: ${fonts.ui}; font-weight: 500; line-height: 1.2; }`;
    return `${pageHead(input, this.variables(input), css)}
  <body>
    <!-- Root: size and length of the render. FrameshellMotion.bind below registers its timeline, so the render
         does not wait for one. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
      <div id="logo-lockup-clip" class="clip">
        <div id="backdrop"></div>
        <div id="content">
          <div id="lockup">
            <img id="logo" alt="" />
            <div id="words">
              <div class="mask"><h1 id="name"></h1></div>
              <i id="rule"></i>
              <div class="mask"><p id="tagline"></p></div>
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
        { layout: "side", logo: 0.24, name: 0.12, tagline: 0.042, gap: 0.045 },
        { layout: "stacked", logo: 0.22, name: 0.11, tagline: 0.04, gap: 0.04 },
        { layout: "stacked", logo: 0.2, name: 0.1, tagline: 0.037, gap: 0.04 }
      );
      // Beside the name only makes sense with a logo to put beside it.
      var side = !!P.logo && (P.layout === "auto" ? L.layout : P.layout) === "side";
      var px = unit * P.size;

      var lockup = document.getElementById("lockup");
      lockup.style.flexDirection = side ? "row" : "column";
      lockup.style.gap = L.gap * px + "px";
      lockup.style.color = P.ink;
      lockup.style.textAlign = side ? "left" : "center";

      var logo = document.getElementById("logo");
      if (P.logo) logo.src = P.logo;
      else logo.style.display = "none";
      logo.style.height = L.logo * px + "px";
      logo.style.maxWidth = L.logo * px * 1.8 + "px";

      var words = document.getElementById("words");
      words.style.alignItems = side ? "flex-start" : "center";
      words.style.gap = L.name * px * 0.14 + "px";

      var nameEl = document.getElementById("name");
      nameEl.textContent = P.name;
      nameEl.style.fontSize = L.name * px + "px";

      var rule = document.getElementById("rule");
      rule.style.background = P.accent;
      rule.style.width = L.name * px * 2.2 + "px";
      rule.style.fontSize = L.name * px + "px";
      rule.style.transformOrigin = (side ? "0%" : "50%") + " 50%";

      var tagline = document.getElementById("tagline");
      tagline.textContent = P.tagline;
      tagline.style.fontSize = L.tagline * px + "px";
      if (!P.tagline) { tagline.parentNode.style.display = "none"; rule.style.display = "none"; }

      var D = S.duration;
      var OUT = 0.3;
      var rise = L.name * px * 1.3;

      M.bind("${id}", function (t) {
        var out = M.ease("exit", (t - (D - OUT)) / OUT);
        M.write(backdrop, { opacity: P.backdrop * M.ease("enter", t / 0.3) * (1 - out) });
        // Holds never stop: a slow push over the whole clip.
        M.write(lockup, { scale: 1 + (P.drift / 100) * Math.min(1, t / D) - 0.03 * out, opacity: 1 - out });
        var s = M.spring("heavy", t - 0.1);
        M.write(logo, { scale: 0.6 + 0.4 * s, opacity: M.ease("enter", (t - 0.1) / 0.25) });
        s = M.spring("heavy", t - 0.3);
        M.write(nameEl, { y: (1 - s) * rise, opacity: M.ease("enter", (t - 0.3) / 0.2) });
        M.write(rule, { scaleX: Math.min(1, Math.max(0, M.spring("snappy", t - 0.55))), opacity: M.ease("enter", (t - 0.55) / 0.15) });
        s = M.spring("default", t - 0.7);
        M.write(tagline, { y: (1 - s) * rise * 0.6, opacity: 0.85 * M.ease("enter", (t - 0.7) / 0.3) });
      });
    </script>
  </body>
</html>
`;
  },
};
