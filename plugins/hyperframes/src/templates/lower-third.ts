import { COLOR_HELPERS, PLACEHOLDER, type Template, type TemplateInput, type TemplateVariable, fontSetup, pageHead } from "./kit.js";

/**
 * Lower third (#466): a card with an accent bar wipes in from its edge, the
 * name and the role rise through a mask, a slow slide while it holds, a short
 * exit. Transparent around the card, so it works over footage.
 */
export const lowerThird: Template = {
  id: "lower-third",
  description: "Lower third: name and role on a card with an accent bar; transparent over footage",
  defaultDuration: 4,
  overlay: true,
  variables({ tokens }: TemplateInput): TemplateVariable[] {
    return [
      { id: "name", type: "string", label: "Name", default: "Alex Rivera", maxLength: 40 },
      { id: "role", type: "string", label: "Role or line under the name", default: tokens.brand.product ? `Founder, ${tokens.brand.product}` : "Founder", maxLength: 60 },
      { id: "ink", type: "color", label: "Text colour", default: tokens.colors.ink ?? PLACEHOLDER.ink },
      { id: "accent", type: "color", label: "Bar colour", default: tokens.colors.accent ?? PLACEHOLDER.accent },
      { id: "card", type: "color", label: "Card colour", default: tokens.colors.card ?? PLACEHOLDER.bg },
      { id: "cardOpacity", type: "number", label: "How solid the card is, 1 = opaque", default: 0.85, min: 0.3, max: 1, step: 0.05 },
      { id: "size", type: "number", label: "Type size, 1 = the format's default", default: 1, min: 0.6, max: 1.6, step: 0.05 },
      {
        id: "side",
        type: "enum",
        label: "Side of the frame",
        default: "left",
        options: [
          { value: "left", label: "Left" },
          { value: "right", label: "Right" },
        ],
      },
    ];
  },
  render(input: TemplateInput): string {
    const { id, width, height, duration } = input;
    const fonts = fontSetup(input.tokens);
    const css = `
      #wrap { position: absolute; display: flex; align-items: stretch; max-width: 80%; }
      #panel { position: absolute; inset: 0; border-radius: 0.22em; }
      #bar { position: absolute; top: 0; bottom: 0; border-radius: 999px; }
      #text { position: relative; }
      /* The mask clips a line while it travels; the padding keeps accents and descenders inside it. */
      .mask { overflow: hidden; padding: 0.08em 0.04em 0.14em; margin: -0.08em -0.04em -0.14em; }
      #name { font-family: ${fonts.display}; font-weight: ${fonts.displayWeight}; line-height: 1.08; letter-spacing: -0.01em; }
      #role { font-family: ${fonts.ui}; font-weight: 500; line-height: 1.2; }`;
    return `${pageHead(input, this.variables(input), css)}
  <body>
    <!-- Root: size and length of the render. FrameshellMotion.bind below registers its timeline, so the render
         does not wait for one. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
      <div id="lower-third-clip" class="clip">
        <div id="wrap">
          <div id="panel"></div>
          <i id="bar"></i>
          <div id="text">
            <div class="mask"><div id="name"></div></div>
            <div class="mask"><div id="role"></div></div>
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

      // Layout per format (fractions of the frame; sizes are fractions of the short side). wide, square, tall.
      // The tall frames keep the card above the platform's own controls.
      var L = M.pick(
        { x: 0.06, bottom: 0.1, name: 0.062, role: 0.036, pad: 0.026 },
        { x: 0.07, bottom: 0.1, name: 0.07, role: 0.04, pad: 0.03 },
        { x: 0.06, bottom: 0.2, name: 0.064, role: 0.038, pad: 0.03 }
      );
      var right = P.side === "right";
      var dir = right ? -1 : 1;
      var pad = L.pad * unit;
      var barWidth = Math.max(4, L.name * unit * 0.12);

      var wrap = document.getElementById("wrap");
      wrap.style.bottom = L.bottom * S.height + "px";
      wrap.style[right ? "right" : "left"] = L.x * S.width + "px";
      wrap.style.padding = pad * 0.8 + "px " + pad + "px " + pad * 0.8 + "px " + (pad + barWidth * 1.6) + "px";
      if (right) wrap.style.padding = pad * 0.8 + "px " + (pad + barWidth * 1.6) + "px " + pad * 0.8 + "px " + pad + "px";
      wrap.style.color = P.ink;
      wrap.style.textAlign = right ? "right" : "left";

      var panel = document.getElementById("panel");
      panel.style.background = P.card;
      panel.style.transformOrigin = (right ? "100%" : "0%") + " 50%";

      var bar = document.getElementById("bar");
      bar.style.background = P.accent;
      bar.style.width = barWidth + "px";
      bar.style[right ? "right" : "left"] = pad * 0.55 + "px";
      bar.style.top = pad * 0.55 + "px";
      bar.style.bottom = pad * 0.55 + "px";
      bar.style.transformOrigin = "50% 100%";

      var nameEl = document.getElementById("name");
      nameEl.textContent = P.name;
      nameEl.style.fontSize = L.name * unit * P.size + "px";
      var role = document.getElementById("role");
      role.textContent = P.role;
      role.style.fontSize = L.role * unit * P.size + "px";
      role.style.color = mix(P.ink, P.card, 0.3);
      if (!P.role) role.parentNode.style.display = "none";

      var D = S.duration;
      var OUT = 0.3;
      var rise = L.name * unit * 1.4;

      M.bind("${id}", function (t) {
        var out = M.ease("exit", (t - (D - OUT)) / OUT);
        // Holds never stop: the card slides a few pixels toward the frame centre while it stays.
        M.write(wrap, { x: dir * unit * 0.012 * Math.min(1, t / D) + dir * out * unit * 0.02, opacity: 1 - out });
        M.write(panel, { scaleX: M.spring("snappy", t - 0.05), opacity: P.cardOpacity * M.ease("enter", (t - 0.05) / 0.15) });
        M.write(bar, { scaleY: M.spring("snappy", t), opacity: M.ease("enter", t / 0.1) });
        M.write(nameEl, { y: (1 - M.spring("heavy", t - 0.22)) * rise, opacity: M.ease("enter", (t - 0.22) / 0.2) });
        M.write(role, { y: (1 - M.spring("default", t - 0.34)) * rise * 0.8, opacity: 0.9 * M.ease("enter", (t - 0.34) / 0.25) });
      });
    </script>
  </body>
</html>
`;
  },
};
