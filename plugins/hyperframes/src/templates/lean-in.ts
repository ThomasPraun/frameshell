import {
  BACKDROP_CSS,
  BACKDROP_SETUP,
  COLOR_HELPERS,
  FLAT_HELPERS,
  PLACEHOLDER,
  type Template,
  type TemplateInput,
  type TemplateVariable,
  backdropVariables,
  fontSetup,
  pageHead,
} from "./kit.js";

/**
 * Lean in (#466 TP5, owner decision Q3): a headline or quote card that slides in
 * from a side with a heavy spring, tilts away as it comes and leans back toward
 * the viewer, then holds with a slow lean (scale 1 to 1.06, rotation 1 to 2
 * degrees). 2D scale and rotation only (ADR 0033: no 3D transform), no matte.
 * Transparent unless `backdrop` is raised; a late `at` is pulled in so the card
 * has landed before the exit.
 */
export const leanIn: Template = {
  id: "lean-in",
  description: "Lean in: a headline or quote card slides in from the side with a heavy spring, tilts and leans toward the viewer, then holds with a slow lean; transparent unless a background is set",
  defaultDuration: 4,
  overlay: true,
  variables({ tokens }: TemplateInput): TemplateVariable[] {
    return [
      { id: "text", type: "string", label: "Headline or quote", default: "Editing should feel like writing", maxLength: 120 },
      { id: "kicker", type: "string", label: "Small line above the text; empty for none", default: "The idea", maxLength: 32 },
      {
        id: "side",
        type: "enum",
        label: "Side it comes in from",
        default: "left",
        options: [
          { value: "left", label: "Left" },
          { value: "right", label: "Right" },
        ],
      },
      { id: "at", type: "number", label: "Seconds until the card starts to slide in (pulled in on a short clip)", default: 0.15, min: 0, max: 3, step: 0.05, unit: "s" },
      { id: "ink", type: "color", label: "Text colour", default: tokens.colors.ink ?? PLACEHOLDER.ink },
      { id: "accent", type: "color", label: "Rule and kicker colour", default: tokens.colors.accent ?? PLACEHOLDER.accent },
      { id: "card", type: "color", label: "Card colour", default: tokens.colors.card ?? PLACEHOLDER.bg },
      { id: "size", type: "number", label: "Type size, 1 = the format's default (a long text shrinks to fit)", default: 1, min: 0.6, max: 1.6, step: 0.05 },
      ...backdropVariables(tokens),
    ];
  },
  render(input: TemplateInput): string {
    const { id, width, height, duration } = input;
    const fonts = fontSetup(input.tokens);
    const css = `
      ${BACKDROP_CSS}
      #row { position: absolute; inset: 0; display: flex; align-items: center; }
      #card { position: relative; flex: none; padding: 0.8em 0.95em 0.9em; border-radius: 0.4em; transform-origin: 50% 100%; }
      #rule { display: block; width: 2.2em; height: 0.2em; border-radius: 999px; margin-bottom: 0.55em; }
      #kicker { display: block; margin-bottom: 0.4em; font-family: ${fonts.ui}; font-weight: 700; font-size: 0.42em; letter-spacing: 0.14em; text-transform: uppercase; }
      #text { font-family: ${fonts.display}; font-weight: ${fonts.displayWeight}; line-height: 1.12; letter-spacing: -0.015em; overflow-wrap: break-word; }`;
    return `${pageHead(input, this.variables(input), css)}
  <body>
    <!-- Root: size and length of the render. FrameshellMotion.bind below registers its timeline, so the render
         does not wait for one. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
      <div id="lean-in-clip" class="clip">
        <div id="backdrop"></div>
        <div id="row">
          <div id="card"><i id="rule"></i><span id="kicker"></span><div id="text"></div></div>
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

      // Layout per format: the card's side margin and width as fractions of the frame width, the type size as a fraction of the short side. wide, square, tall.
      // The widest card still has room for the lean (scale 1.06, 2 degrees) inside the frame.
      var L = M.pick({ x: 0.07, w: 0.5, fs: 0.07 }, { x: 0.08, w: 0.68, fs: 0.075 }, { x: 0.08, w: 0.8, fs: 0.07 });
      var right = P.side === "right";
      var dir = right ? -1 : 1;
      var text = String(P.text).trim() || "Lean in";
      var kicker = String(P.kicker).trim();

      var row = document.getElementById("row");
      row.style.justifyContent = right ? "flex-end" : "flex-start";
      row.style.padding = "0 " + L.x * S.width + "px";
      var card = document.getElementById("card");
      var cw = L.w * S.width;
      card.style.width = cw + "px";
      card.style.background = P.card;
      card.style.color = P.ink;
      card.style.textAlign = "left";
      document.getElementById("rule").style.background = P.accent;
      var kickerEl = document.getElementById("kicker");
      kickerEl.textContent = kicker;
      kickerEl.style.color = P.accent;
      if (!kicker) kickerEl.style.display = "none";
      document.getElementById("text").textContent = text;
      // The text shrinks until the card takes at most 62 % of the frame's height (the layout is measured, a transform never changes it).
      var px = L.fs * unit * P.size;
      card.style.fontSize = px + "px";
      for (var tries = 0; tries < 12 && card.offsetHeight > 0.62 * S.height && px > 0.02 * unit; tries++) {
        px *= 0.92;
        card.style.fontSize = px + "px";
      }

      var D = S.duration;
      var OUT = 0.3;
      // The slide and the tilt need about a second to land: a late start is pulled in so the card is still before the exit.
      var AT = Math.min(P.at, Math.max(0, D - OUT - 1));
      // Where the card starts: its whole width and margin outside the frame, on its own side.
      var away = L.x * S.width + cw * 1.1;
      // A spring with about 9 % overshoot: the card leans past its resting tilt toward the viewer and settles back.
      var LEAN = { response: 0.6, damping: 0.62 };
      var BACK = 9;

      M.bind("${id}", function (t) {
        var out = M.ease("exit", (t - (D - OUT)) / OUT);
        put(backdrop, { opacity: P.backdrop * M.ease("enter", t / 0.3) * (1 - out) });
        var slide = M.spring("heavy", t - AT);
        var q = M.spring(LEAN, t - AT - 0.05);
        // The slow lean over the hold: scale 1 to 1.06, rotation 1 to 2 degrees toward the frame's centre.
        var hold = M.ease("camera", (t - AT) / (D - AT));
        put(card, {
          x: -dir * (1 - slide) * away - dir * out * 0.04 * S.width,
          rotate: dir * (-(1 - q) * BACK + 1 + hold),
          scale: (0.88 + 0.12 * q) * (1 + 0.06 * hold),
          opacity: M.ease("enter", (t - AT) / 0.15) * (1 - out),
        });
      });
    </script>
  </body>
</html>
`;
  },
};
