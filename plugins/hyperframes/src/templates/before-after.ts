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
 * Before / after wipe: two pictures in one rounded card, the "before"
 * showing; after a beat a divider with a handle sweeps across and the "after"
 * appears behind it, labels trading places. Each picture is an image of the
 * composition directory or, when empty, a plain app skeleton (rough for the
 * before, tidy for the after). Paints its own background.
 */
export const beforeAfter: Template = {
  id: "before-after",
  description: "Before/after wipe: a divider with a handle sweeps across a card and reveals the second picture; paints its own background",
  defaultDuration: 5,
  overlay: false,
  variables({ tokens }: TemplateInput): TemplateVariable[] {
    return [
      { id: "before", type: "image", label: "Before picture", default: "", description: "Path of an image inside this composition's directory, e.g. before.png; empty shows a rough app skeleton" },
      { id: "after", type: "image", label: "After picture", default: "", description: "Path of an image inside this composition's directory, e.g. after.png; empty shows a tidy app skeleton" },
      { id: "beforeLabel", type: "string", label: "Label of the before picture; empty for none", default: "Before", maxLength: 24 },
      { id: "afterLabel", type: "string", label: "Label of the after picture; empty for none", default: "After", maxLength: 24 },
      { id: "wipeAt", type: "number", label: "Seconds until the divider starts to move (pulled in on a short clip)", default: 1.3, min: 0.5, max: 4, step: 0.1, unit: "s" },
      { id: "wipeTime", type: "number", label: "Seconds the divider takes to cross", default: 1.2, min: 0.5, max: 3, step: 0.1, unit: "s" },
      {
        id: "direction",
        type: "enum",
        label: "Direction of the wipe",
        default: "auto",
        options: [
          { value: "auto", label: "By format: across on 16:9 and 1:1, down on 4:5 and 9:16" },
          { value: "across", label: "Left to right" },
          { value: "down", label: "Top to bottom" },
        ],
      },
      { id: "bg", type: "color", label: "Background colour", default: tokens.colors.bg ?? PLACEHOLDER.bg },
      { id: "card", type: "color", label: "Label chip colour", default: tokens.colors.card ?? "#1b2236" },
      { id: "ink", type: "color", label: "Label text colour", default: tokens.colors.ink ?? PLACEHOLDER.ink },
      { id: "accent", type: "color", label: "Divider and after-label colour", default: tokens.colors.accent ?? PLACEHOLDER.accent },
      { id: "size", type: "number", label: "Card size, 1 = the format's default", default: 1, min: 0.6, max: 1.1, step: 0.05 },
    ];
  },
  render(input: TemplateInput): string {
    const { id, width, height, duration } = input;
    const fonts = fontSetup(input.tokens);
    const css = `
      #bg { position: absolute; inset: 0; }
      #content { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
      #card { position: relative; flex: none; overflow: hidden; box-shadow: 0 2.2em 5em rgba(0, 0, 0, 0.45); }
      .pane { position: absolute; inset: 0; width: 100%; height: 100%; }
      .pane img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
      .pane .skeleton { position: absolute; inset: 0; }
      .skeleton i { position: absolute; display: block; }
      #divider { position: absolute; left: 0; top: 0; }
      #handle { position: absolute; display: flex; align-items: center; justify-content: center; border-radius: 50%; font-family: ${fonts.ui}; font-weight: 700; line-height: 1; letter-spacing: 0.04em; box-shadow: 0 0.2em 0.9em rgba(0, 0, 0, 0.35); }
      .chip { position: absolute; padding: 0.35em 0.9em; border-radius: 999px; white-space: nowrap; font-family: ${fonts.ui}; font-weight: 600; letter-spacing: 0.02em; }`;
    return `${pageHead(input, this.variables(input), css)}
  <body>
    <!-- Root: size and length of the render. FrameshellMotion.bind below registers its timeline, so the render
         does not wait for one. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
      <div id="before-after-clip" class="clip">
        <div id="bg"></div>
        <div id="content">
          <div id="card">
            <div class="pane" id="before-pane"></div>
            <div class="pane" id="after-pane"></div>
            <i id="divider"></i>
            <i id="handle"></i>
            <span class="chip" id="before-chip"></span>
            <span class="chip" id="after-chip"></span>
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
      ${FLAT_HELPERS}

      // Layout per format: the box the card fills, as fractions of the frame. wide, square, tall.
      var L = M.pick({ w: 0.76, h: 0.74 }, { w: 0.82, h: 0.72 }, { w: 0.86, h: 0.64 });
      var cardW = L.w * S.width * P.size;
      var cardH = L.h * S.height * P.size;
      var down = P.direction === "down" || (P.direction === "auto" && S.format === "tall");
      var em = unit * 0.026;

      var bg = document.getElementById("bg");
      bg.style.background = "radial-gradient(ellipse at 50% 40%, " + mix(P.bg, "#ffffff", 0.09) + " 0%, " + P.bg + " 72%)";
      var card = document.getElementById("card");
      card.style.width = cardW + "px";
      card.style.height = cardH + "px";
      card.style.borderRadius = unit * 0.022 + "px";
      card.style.fontSize = em + "px";

      // A picture, or a plain app skeleton: blocks as [left, top, width, height, colour] in percent. The rough one has grey
      // blocks off the grid; the tidy one an accent header and an aligned grid.
      var ROUGH = [[4, 8, 55, 10, "#b9bdc6"], [4, 24, 30, 24, "#c9ccd3"], [40, 27, 50, 8, "#d3d6dc"], [37, 42, 38, 8, "#c2c5cc"], [8, 58, 70, 6, "#d3d6dc"], [12, 70, 44, 6, "#c2c5cc"]];
      var TIDY = [[0, 0, 100, 14, P.accent], [6, 22, 40, 34, "#d9deea"], [54, 22, 40, 34, "#d9deea"], [6, 64, 88, 6, "#d9deea"], [6, 76, 60, 6, "#d9deea"]];
      function picture(pane, source, blocks, ground) {
        if (source) {
          var img = document.createElement("img");
          img.alt = "";
          img.src = source;
          pane.appendChild(img);
          return;
        }
        var sk = document.createElement("div");
        sk.className = "skeleton";
        sk.style.background = ground;
        blocks.forEach(function (b) {
          var el = document.createElement("i");
          el.style.cssText = "left:" + b[0] + "%;top:" + b[1] + "%;width:" + b[2] + "%;height:" + b[3] + "%;background:" + b[4] + ";border-radius:" + (b[2] === 100 ? 0 : 0.5) + "em";
          sk.appendChild(el);
        });
        pane.appendChild(sk);
      }
      var beforePane = document.getElementById("before-pane");
      var afterPane = document.getElementById("after-pane");
      picture(beforePane, P.before, ROUGH, "#e6e8ec");
      picture(afterPane, P.after, TIDY, "#eef1f7");

      // The divider is a line across the card with a round handle on it; both travel as one distance along the wipe axis.
      var span = down ? cardH : cardW;
      var divider = document.getElementById("divider");
      var handle = document.getElementById("handle");
      var lineW = Math.max(2, unit * 0.004);
      divider.style.background = P.accent;
      if (down) {
        divider.style.width = "100%";
        divider.style.height = lineW + "px";
        divider.style.marginTop = -lineW / 2 + "px";
      } else {
        divider.style.height = "100%";
        divider.style.width = lineW + "px";
        divider.style.marginLeft = -lineW / 2 + "px";
      }
      var hs = unit * 0.07;
      handle.style.cssText += "width:" + hs + "px;height:" + hs + "px;background:" + P.accent + ";color:" + onColor(P.accent) + ";font-size:" + hs * 0.38 + "px;";
      handle.style.left = (down ? cardW / 2 : 0) - hs / 2 + "px";
      handle.style.top = (down ? 0 : cardH / 2) - hs / 2 + "px";
      handle.textContent = down ? "\\u2191\\u2193" : "\\u2190\\u2192";

      // Labels: the after chip sits on the side the wipe reveals first (left or top), the before chip on the far side.
      var beforeChip = document.getElementById("before-chip");
      var afterChip = document.getElementById("after-chip");
      [[beforeChip, P.beforeLabel, P.card, P.ink], [afterChip, P.afterLabel, P.accent, onColor(P.accent)]].forEach(function (c) {
        c[0].textContent = c[1];
        c[0].style.background = c[2];
        c[0].style.color = c[3];
        if (!c[1]) c[0].style.display = "none";
      });
      var gap = unit * 0.022;
      afterChip.style.left = gap + "px";
      afterChip.style.top = gap + "px";
      if (down) {
        beforeChip.style.left = gap + "px";
        beforeChip.style.bottom = gap + "px";
      } else {
        beforeChip.style.right = gap + "px";
        beforeChip.style.top = gap + "px";
      }

      var D = S.duration;
      var OUT = 0.3;
      // The wipe must finish, and the after picture show for a beat, before the exit: a late start is pulled in.
      var AT = Math.min(P.wipeAt, Math.max(0.5, D - OUT - 0.6 - P.wipeTime));
      var content = document.getElementById("content");
      var stamp = function (v) { return String(Math.round(v * 1000) / 1000); };

      M.bind("${id}", function (t) {
        var out = M.ease("exit", (t - (D - OUT)) / OUT);
        M.write(bg, { opacity: M.ease("enter", t / 0.3) });
        // The card comes up from below with a heavy spring; holds never stop, so it also pushes in slowly.
        var s = M.spring("heavy", t - 0.1);
        put(content, { y: (1 - s) * unit * 0.05, scale: 0.94 + 0.06 * s + 0.02 * Math.min(1, t / D) - 0.02 * out, opacity: M.ease("enter", (t - 0.1) / 0.3) * (1 - out) });
        // The after picture shows behind the divider: its clip grows with the wipe (in-out, so it starts and lands softly).
        var q = M.ease("camera", (t - AT) / P.wipeTime);
        var pos = q * span;
        var shown = stamp((1 - q) * 100);
        afterPane.style.clipPath = down ? "inset(0 0 " + shown + "% 0)" : "inset(0 " + shown + "% 0 0)";
        var edge = M.ease("enter", (t - AT + 0.15) / 0.15) * (1 - M.ease("enter", (t - AT - P.wipeTime) / 0.2));
        M.write(divider, { x: down ? 0 : pos, y: down ? pos : 0, opacity: edge });
        put(handle, { x: down ? 0 : pos, y: down ? pos : 0, scale: 0.6 + 0.4 * M.spring("snappy", t - AT + 0.15), opacity: edge });
        M.write(beforeChip, { opacity: M.ease("enter", (t - 0.4) / 0.25) * (1 - M.ease("enter", (t - AT - P.wipeTime * 0.75) / 0.2)) });
        M.write(afterChip, { opacity: M.ease("enter", (t - AT - P.wipeTime * 0.25) / 0.25) });
      });
    </script>
  </body>
</html>
`;
  },
};
