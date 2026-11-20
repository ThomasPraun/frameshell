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
 * Picture-in-picture card (owner decision, ADR 0033): a still picture
 * (a screenshot, a product shot, a face) in a rounded card in one corner over
 * the talking head, with an optional caption chip. Image prop only: a live
 * video in a corner stays the multicam picture-in-picture layout. The card
 * slides in from its own edge with a heavy spring, floats and pushes in slowly
 * while it holds, and leaves. Transparent outside the card.
 */
export const pipCard: Template = {
  id: "pip-card",
  description: "Picture-in-picture card: a still picture in a rounded card in one corner over footage, slides in from its edge, optional caption chip; transparent outside the card; a live video in a corner is the multicam pip layout",
  defaultDuration: 4,
  overlay: true,
  variables({ tokens }: TemplateInput): TemplateVariable[] {
    return [
      {
        id: "image",
        type: "image",
        label: "Picture",
        default: "",
        description: "Path of an image inside this composition's directory, e.g. shot.png; empty shows a placeholder figure",
      },
      { id: "caption", type: "string", label: "Caption on the card; empty for none", default: "Live demo", maxLength: 30 },
      {
        id: "corner",
        type: "enum",
        label: "Corner",
        default: "auto",
        options: [
          { value: "auto", label: "Bottom right, top right on a tall frame (clear of the app's own buttons)" },
          { value: "bottom-right", label: "Bottom right" },
          { value: "bottom-left", label: "Bottom left" },
          { value: "top-right", label: "Top right" },
          { value: "top-left", label: "Top left" },
        ],
      },
      {
        id: "shape",
        type: "enum",
        label: "Shape of the card",
        default: "landscape",
        options: [
          { value: "landscape", label: "Landscape, 4:3" },
          { value: "square", label: "Square" },
          { value: "portrait", label: "Portrait, 3:4" },
        ],
      },
      { id: "enterAt", type: "number", label: "Seconds until the card slides in (pulled in on a short clip)", default: 0.3, min: 0.1, max: 3, step: 0.1, unit: "s" },
      { id: "card", type: "color", label: "Card edge and placeholder colour", default: tokens.colors.card ?? "#1b2236" },
      { id: "accent", type: "color", label: "Caption colour", default: tokens.colors.accent ?? PLACEHOLDER.accent },
      { id: "size", type: "number", label: "Card size, 1 = the format's default", default: 1, min: 0.5, max: 1.5, step: 0.05 },
    ];
  },
  render(input: TemplateInput): string {
    const { id, width, height, duration } = input;
    const fonts = fontSetup(input.tokens);
    const css = `
      #card { position: absolute; overflow: hidden; box-shadow: 0 0.5em 1.6em rgba(0, 0, 0, 0.4); }
      #pic { position: absolute; inset: 0; }
      #pic img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
      #pic i { position: absolute; display: block; }
      #chip { position: absolute; white-space: nowrap; max-width: 88%; overflow: hidden; text-overflow: ellipsis; font-family: ${fonts.ui}; font-weight: 700; line-height: 1.1; padding: 0.3em 0.75em 0.36em; border-radius: 999px; }`;
    return `${pageHead(input, this.variables(input), css)}
  <body>
    <!-- Root: size and length of the render. FrameshellMotion.bind below registers its timeline, so the render
         does not wait for one. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
      <div id="pip-card-clip" class="clip">
        <div id="card">
          <div id="pic"></div>
          <span id="chip"></span>
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

      // Layout per format: card width as a fraction of the frame width, the side margin as a fraction of the width, the top and bottom margins as fractions of the height. wide, square, tall.
      var L = M.pick({ w: 0.27, mx: 0.04, top: 0.07, bottom: 0.08 }, { w: 0.38, mx: 0.05, top: 0.06, bottom: 0.07 }, { w: 0.46, mx: 0.05, top: 0.1, bottom: 0.2 });
      var RATIO = { landscape: 0.75, square: 1, portrait: 4 / 3 };
      var ratio = RATIO[P.shape] || RATIO.landscape;
      // A portrait card on a wide frame would be taller than a third of it: it gets narrower instead.
      var cw = Math.min(L.w * S.width * P.size, (0.4 * S.height * Math.max(1, P.size)) / ratio);
      var ch = cw * ratio;
      var corner = P.corner === "auto" ? (S.format === "tall" ? "top-right" : "bottom-right") : P.corner;
      var right = corner.indexOf("right") >= 0;
      var bottom = corner.indexOf("bottom") >= 0;

      var card = document.getElementById("card");
      card.style.width = cw + "px";
      card.style.height = ch + "px";
      card.style.left = (right ? S.width - L.mx * S.width - cw : L.mx * S.width) + "px";
      card.style.top = (bottom ? S.height - L.bottom * S.height - ch : L.top * S.height) + "px";
      card.style.borderRadius = cw * 0.06 + "px";
      card.style.background = P.card;
      card.style.border = Math.max(2, cw * 0.012) + "px solid " + mix(P.card, "#ffffff", 0.28);
      card.style.fontSize = cw * 0.06 + "px";

      var pic = document.getElementById("pic");
      if (P.image) {
        var img = document.createElement("img");
        img.alt = "";
        img.src = P.image;
        pic.appendChild(img);
      } else {
        // No picture given: a soft light, a head and shoulders and a small accent dot, so the card is not an empty frame.
        pic.style.background = "radial-gradient(ellipse at 50% 30%, " + mix(P.card, "#ffffff", 0.2) + " 0%, " + mix(P.card, "#000000", 0.2) + " 80%)";
        [[0.2, 0.6, 0.6, 0.7, mix(P.card, "#000000", 0.45), "50% 50% 0 0"], [0.36, 0.22, 0.28, 0.28 / ratio, mix(P.card, "#000000", 0.55), "50%"], [0.78, 0.1, 0.1, 0.1 / ratio, mix(P.card, P.accent, 0.55), "50%"]].forEach(function (b) {
          var el = document.createElement("i");
          el.style.cssText = "left:" + b[0] * 100 + "%;top:" + b[1] * 100 + "%;width:" + b[2] * 100 + "%;height:" + b[3] * 100 + "%;background:" + b[4] + ";border-radius:" + b[5] + ";";
          pic.appendChild(el);
        });
      }

      var chip = document.getElementById("chip");
      var text = String(P.caption).trim();
      chip.textContent = text;
      chip.style.left = "6%";
      chip.style.bottom = "6%";
      chip.style.background = P.accent;
      chip.style.color = onColor(P.accent);
      if (!text) chip.style.display = "none";

      var D = S.duration;
      var OUT = 0.3;
      // The slide-in and its settle take about 0.7 s: a late card is pulled in so it has landed before the exit.
      var ENTER = Math.min(P.enterAt, Math.max(0.1, D - OUT - 0.7));
      var dir = right ? 1 : -1;

      M.bind("${id}", function (t) {
        var out = M.ease("exit", (t - (D - OUT)) / OUT);
        // It slides in from its own edge with a heavy spring; holds never stop, so it floats and pushes in slowly.
        var s = M.spring("heavy", t - ENTER);
        put(card, {
          x: dir * ((1 - s) * cw * 0.45 + out * cw * 0.25),
          y: Math.sin(t * 1.6) * unit * 0.004,
          scale: 0.88 + 0.12 * s + 0.03 * Math.min(1, t / D) - 0.03 * out,
          opacity: M.ease("enter", (t - ENTER) / 0.25) * (1 - out),
        });
      });
    </script>
  </body>
</html>
`;
  },
};
