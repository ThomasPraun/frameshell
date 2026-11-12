import { CURSOR_CSS, CURSOR_HTML, CURSOR_MATH, CURSOR_SCRIPT, cursorVariables, hesitateVariable } from "./cursor-kit.js";
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
 * Cursor drag and drop (#466, UI demo): a cursor grabs a card, carries it on an
 * arc to a drop zone and lets go; the drop is the beat the zone answers on the
 * same frame (it fills, rings, a check pops in). Side by side on wide frames,
 * stacked on the others. Transparent unless `backdrop` is raised.
 */
export const cursorDragDrop: Template = {
  id: "cursor-drag-drop",
  description: "Cursor drag and drop: a cursor carries a card into a drop zone and the zone answers on the release; transparent unless a background is set",
  defaultDuration: 4.5,
  overlay: true,
  variables({ tokens }: TemplateInput): TemplateVariable[] {
    return [
      { id: "item", type: "string", label: "Text on the card that is dragged", default: "Q3 launch.mp4", maxLength: 28 },
      { id: "target", type: "string", label: "Label of the drop zone", default: "Shared with the team", maxLength: 32 },
      hesitateVariable(0.25),
      { id: "ink", type: "color", label: "Text colour", default: tokens.colors.ink ?? PLACEHOLDER.ink },
      { id: "accent", type: "color", label: "Drop zone and icon colour", default: tokens.colors.accent ?? PLACEHOLDER.accent },
      { id: "card", type: "color", label: "Card colour", default: tokens.colors.card ?? PLACEHOLDER.bg },
      ...cursorVariables(),
      { id: "size", type: "number", label: "Type size, 1 = the format's default", default: 1, min: 0.6, max: 1.6, step: 0.05 },
      ...backdropVariables(tokens),
    ];
  },
  render(input: TemplateInput): string {
    const { id, width, height, duration } = input;
    const fonts = fontSetup(input.tokens);
    const css = `
      ${BACKDROP_CSS}
      #world { position: absolute; inset: 0; }
      .box { position: absolute; }
      .layer { position: absolute; inset: 0; border-radius: inherit; }
      #zone { border-radius: 0.6em; }
      #zone-line { border: 0.1em dashed; }
      #zone-solid { border: 0.1em solid; }
      #zone-label { position: absolute; left: 0; right: 0; top: 0.55em; text-align: center; white-space: nowrap; font-family: ${fonts.ui}; font-weight: 600; letter-spacing: 0.01em; }
      #done { position: absolute; right: -0.7em; top: -0.7em; width: 1.5em; height: 1.5em; border-radius: 50%; }
      #done b { position: absolute; left: 36%; top: 17%; width: 26%; height: 50%; border: solid; border-width: 0 0.14em 0.14em 0; transform: rotate(45deg); }
      #card { display: flex; align-items: center; gap: 0.7em; padding: 0 1em; white-space: nowrap; font-family: ${fonts.ui}; font-weight: 600; border-radius: 0.5em; }
      #card-shadow { box-shadow: 0 0.7em 1.6em rgba(0, 0, 0, 0.5); }
      #card-icon { position: relative; flex: none; width: 1.1em; height: 1.4em; border-radius: 0.2em; }
      #card-text { position: relative; }
      ${CURSOR_CSS}`;
    return `${pageHead(input, this.variables(input), css)}
  <body>
    <!-- Root: size and length of the render. FrameshellMotion.bind below registers its timeline, so the render
         does not wait for one. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
      <div id="cursor-drag-drop-clip" class="clip">
        <div id="backdrop"></div>
        <div id="world">
          <div id="zone" class="box">
            <i id="zone-bg" class="layer"></i>
            <i id="zone-fill" class="layer"></i>
            <i id="zone-line" class="layer"></i>
            <i id="zone-solid" class="layer"></i>
            <span id="zone-label"></span>
            <i id="done"><b></b></i>
          </div>
          <div id="card" class="box">
            <i id="card-shadow" class="layer"></i>
            <i id="card-icon"></i>
            <span id="card-text"></span>
          </div>
          ${CURSOR_HTML}
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
      ${CURSOR_MATH}
      ${CURSOR_SCRIPT}

      // Layout per format: size is a fraction of the short side; card and zone are centres as fractions of the frame; maxW is the widest the zone may be.
      var L = M.pick(
        { size: 0.042, card: { x: 0.27, y: 0.5 }, zone: { x: 0.7, y: 0.5 }, maxW: 0.44 },
        { size: 0.042, card: { x: 0.5, y: 0.27 }, zone: { x: 0.5, y: 0.66 }, maxW: 0.8 },
        { size: 0.04, card: { x: 0.5, y: 0.27 }, zone: { x: 0.5, y: 0.65 }, maxW: 0.84 }
      );
      var itemText = String(P.item);
      var targetText = String(P.target);
      // Text is about 0.58 em per character: the card and the zone are fitted to the frame without measuring text.
      var cardEm = itemText.length * 0.58 + 4.2;
      var zoneEm = Math.max(cardEm * 1.2, targetText.length * 0.4 + 2.4);
      var px = Math.min(L.size * unit * P.size, (L.maxW * S.width) / zoneEm);
      var cw = cardEm * px;
      var ch = px * 2.6;
      var zw = zoneEm * px;
      var zh = ch * 2.3;
      var cardAt = { x: L.card.x * S.width, y: L.card.y * S.height };
      var zoneAt = { x: L.zone.x * S.width, y: L.zone.y * S.height };

      var zone = document.getElementById("zone");
      zone.style.cssText += "left:" + (zoneAt.x - zw / 2) + "px;top:" + (zoneAt.y - zh / 2) + "px;width:" + zw + "px;height:" + zh + "px;font-size:" + px * 0.62 + "px;color:" + P.ink;
      var zoneBg = document.getElementById("zone-bg");
      var zoneFill = document.getElementById("zone-fill");
      var zoneLine = document.getElementById("zone-line");
      var zoneSolid = document.getElementById("zone-solid");
      var done = document.getElementById("done");
      zoneBg.style.background = P.card;
      zoneFill.style.background = P.accent;
      zoneLine.style.borderColor = P.ink;
      zoneSolid.style.borderColor = P.accent;
      done.style.background = P.accent;
      done.firstChild.style.borderColor = onColor(P.accent);
      document.getElementById("zone-label").textContent = targetText;
      // The border radius of the layers follows the zone.
      zoneBg.style.borderRadius = zoneFill.style.borderRadius = zoneLine.style.borderRadius = zoneSolid.style.borderRadius = "0.6em";

      var card = document.getElementById("card");
      card.style.cssText += "left:" + (cardAt.x - cw / 2) + "px;top:" + (cardAt.y - ch / 2) + "px;width:" + cw + "px;height:" + ch + "px;font-size:" + px + "px;color:" + P.ink + ";background:" + mix(P.card, onColor(P.card), 0.12);
      var shadow = document.getElementById("card-shadow");
      shadow.style.borderRadius = "0.5em";
      document.getElementById("card-icon").style.background = P.accent;
      document.getElementById("card-text").textContent = itemText;

      // Grab near the right of the card's centre; the drop point keeps that offset, so the card lands centred in the zone.
      var grab = { x: cardAt.x + 0.18 * cw, y: cardAt.y + 0.05 * ch };
      var offset = { x: cardAt.x - grab.x, y: cardAt.y - grab.y };
      var drop = { x: zoneAt.x - offset.x, y: zoneAt.y - offset.y };
      var rest = inFrame({ x: zoneAt.x + zw * 0.3, y: zoneAt.y + zh / 2 + 0.07 * unit }, 0.06);
      var trip = journey(FROM, [
        { x: grab.x, y: grab.y, hesitate: P.hesitate, wait: 0.3 },
        { x: drop.x, y: drop.y, weight: "heavy", bend: 0.12, wait: 0.5 },
        { x: rest.x, y: rest.y, weight: "light", bend: 0.2 }
      ], START, { x: 0.004 * unit, y: 0.003 * unit });
      // Pressed from the grab to the drop; the release is the beat the zone answers.
      var grabAt = trip.legs[0].arrive + 0.04;
      var dropAt = trip.legs[1].arrive + 0.1;

      var world = document.getElementById("world");
      var D = S.duration;
      var OUT = 0.3;

      M.bind("${id}", function (t) {
        var out = M.ease("exit", (t - (D - OUT)) / OUT);
        put(backdrop, { opacity: P.backdrop * M.ease("enter", t / 0.3) * (1 - out) });
        // Holds never stop: a slow push over the whole clip.
        put(world, { scale: 1 + 0.025 * Math.min(1, t / D) - 0.02 * out, opacity: 1 - out });

        var cur = trip.at(t);
        // The card rests, rides the cursor while it is held, then sits in the zone.
        var at = t < grabAt ? cardAt : t < dropAt ? { x: cur.x + offset.x, y: cur.y + offset.y } : zoneAt;
        var lift = t < dropAt ? M.ease("snap", (t - grabAt) / 0.12) : M.spring("snappy", t - dropAt, 1, 0);
        var enter = M.spring("heavy", t - 0.05);
        put(card, { x: at.x - cardAt.x, y: at.y - cardAt.y + (1 - enter) * px * 0.8, rotate: -2.5 * lift, scale: (0.9 + 0.1 * enter) * (1 + 0.06 * lift), opacity: M.ease("enter", (t - 0.05) / 0.2) });
        put(shadow, { opacity: 0.6 * Math.max(0, lift) });

        // The zone warms up as the card nears, and answers on the release.
        var near = t < grabAt ? 0 : Math.max(0, 1 - Math.hypot(at.x - zoneAt.x, at.y - zoneAt.y) / (0.45 * unit));
        var landed = M.ease("enter", (t - dropAt) / 0.2);
        var warm = t < dropAt ? near : 1;
        var zin = M.spring("default", t - 0.1);
        put(zone, { scale: (0.94 + 0.06 * zin) * (t < dropAt ? 1 : 1 + 0.03 * (1 - M.spring("snappy", t - dropAt))), opacity: M.ease("enter", (t - 0.1) / 0.2) });
        put(zoneBg, { opacity: 0.6 });
        put(zoneFill, { opacity: 0.18 * warm });
        put(zoneLine, { opacity: (1 - landed) * (0.35 + 0.3 * warm) });
        put(zoneSolid, { opacity: landed });
        put(done, { scale: 0.3 + 0.7 * M.spring("snappy", t - dropAt - 0.05), opacity: M.ease("enter", (t - dropAt - 0.05) / 0.1) });

        drawRipple(t, dropAt, drop.x, drop.y);
        drawCursor(cur, press(t, grabAt, dropAt), 0);
      });
    </script>
  </body>
</html>
`;
  },
};
