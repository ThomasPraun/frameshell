import { CAMERA_MATH, CURSOR_CSS, CURSOR_HTML, CURSOR_MATH, CURSOR_SCRIPT, cameraVariables, cursorVariables, hesitateVariable } from "./cursor-kit.js";
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
 * Select and resize (#466 TP5, UI demo): a cursor presses a card, so its
 * selection ring and its handles (4 corner squares or 8 dots) appear on the
 * click's own frame; it then drags the bottom-right handle outward or inward
 * until the card has the target size, lets go, and a badge with the final size
 * springs in. The box is written as `left`/`top`/`width`/`height` on a 0.01 px
 * grid (a scale would blur it) and its handles are its children, so they follow
 * its edges. Transparent unless `backdrop` is raised.
 */
export const selectResize: Template = {
  id: "select-resize",
  description: "Select and resize: a cursor presses a card, its handles appear on the click, it drags a corner to a target size and lets go, a badge shows the size; transparent unless a background is set",
  defaultDuration: 5,
  overlay: true,
  variables({ tokens }: TemplateInput): TemplateVariable[] {
    return [
      { id: "label", type: "string", label: "Title on the card", default: "Product card", maxLength: 28 },
      { id: "x", type: "number", label: "Card, left edge as a fraction of the frame width", default: 0.3, min: 0, max: 0.9, step: 0.01 },
      { id: "y", type: "number", label: "Card, top edge as a fraction of the frame height", default: 0.2, min: 0, max: 0.9, step: 0.01 },
      { id: "fromW", type: "number", label: "Card width before the drag, as a fraction of the frame width", default: 0.22, min: 0.08, max: 0.9, step: 0.01 },
      { id: "fromH", type: "number", label: "Card height before the drag, as a fraction of the frame height", default: 0.26, min: 0.08, max: 0.9, step: 0.01 },
      { id: "toW", type: "number", label: "Card width after the drag, as a fraction of the frame width", default: 0.42, min: 0.08, max: 0.9, step: 0.01 },
      { id: "toH", type: "number", label: "Card height after the drag, as a fraction of the frame height", default: 0.46, min: 0.08, max: 0.9, step: 0.01 },
      {
        id: "handles",
        type: "enum",
        label: "Handles",
        default: "corners",
        options: [
          { value: "corners", label: "4 corner squares" },
          { value: "all", label: "8 dots: corners and edges" },
        ],
      },
      hesitateVariable(0.25),
      ...cameraVariables(),
      { id: "ink", type: "color", label: "Text and handle colour", default: tokens.colors.ink ?? PLACEHOLDER.ink },
      { id: "accent", type: "color", label: "Selection colour", default: tokens.colors.accent ?? PLACEHOLDER.accent },
      { id: "card", type: "color", label: "Card colour", default: tokens.colors.card ?? PLACEHOLDER.bg },
      ...cursorVariables(),
      { id: "size", type: "number", label: "Type and handle size, 1 = the format's default", default: 1, min: 0.6, max: 1.6, step: 0.05 },
      ...backdropVariables(tokens),
    ];
  },
  render(input: TemplateInput): string {
    const { id, width, height, duration } = input;
    const fonts = fontSetup(input.tokens);
    const css = `
      ${BACKDROP_CSS}
      #world { position: absolute; inset: 0; }
      #box { position: absolute; left: 0; top: 0; width: 0; height: 0; border-radius: 0.5em; font-family: ${fonts.ui}; font-weight: 600; }
      #title { position: absolute; left: 0.8em; right: 0.8em; top: 0.65em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #thumb { position: absolute; left: 0.7em; right: 0.7em; top: 2.5em; bottom: 0.7em; border-radius: 0.3em; }
      #sel { position: absolute; inset: 0; border-radius: 0.5em; border: 0.14em solid; opacity: 0; }
      .handle { position: absolute; opacity: 0; }
      #badge { position: absolute; display: flex; align-items: center; justify-content: center; white-space: nowrap; font-family: ${fonts.ui}; font-weight: 600; font-variant-numeric: tabular-nums; }
      ${CURSOR_CSS}`;
    return `${pageHead(input, this.variables(input), css)}
  <body>
    <!-- Root: size and length of the render. FrameshellMotion.bind below registers its timeline, so the render
         does not wait for one. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
      <div id="select-resize-clip" class="clip">
        <div id="backdrop"></div>
        <div id="world">
          <div id="box"><span id="title"></span><i id="thumb"></i><i id="sel"></i></div>
          <div id="badge"></div>
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
      ${CAMERA_MATH}
      ${CURSOR_SCRIPT}

      // Layout per format: type size and handle size as fractions of the short side. wide, square, tall.
      var L = M.pick({ type: 0.03, hs: 0.017 }, { type: 0.032, hs: 0.018 }, { type: 0.034, hs: 0.02 });
      var px = L.type * unit * P.size;
      var hs = Math.max(5, L.hs * unit * P.size);
      var bh = px * 2.4;
      var gap = 0.02 * unit;
      var curW = (curH * 12) / 19;
      var stamp = function (v) { return String(Math.round(v * 100) / 100); };

      // The card, its handles, the cursor at the dragged corner and the badge under the final size all stay inside the frame (4 % margin).
      var edge = 0.04 * S.width + hs / 2;
      var maxR = 0.96 * S.width - curW - hs / 2;
      var maxB = 0.96 * S.height - Math.max(curH, bh + gap) - hs / 2;
      var minW = 5 * hs;
      var minH = 4 * hs;
      var w0 = Math.min(maxR - edge, Math.max(minW, P.fromW * S.width));
      var w1 = Math.min(maxR - edge, Math.max(minW, P.toW * S.width));
      var topEdge = 0.04 * S.height + hs / 2;
      var h0 = Math.min(maxB - topEdge, Math.max(minH, P.fromH * S.height));
      var h1 = Math.min(maxB - topEdge, Math.max(minH, P.toH * S.height));
      var bx = Math.min(Math.max(P.x * S.width, edge), maxR - Math.max(w0, w1));
      var by = Math.min(Math.max(P.y * S.height, topEdge), maxB - Math.max(h0, h1));

      var box = document.getElementById("box");
      box.style.fontSize = px + "px";
      box.style.background = P.card;
      box.style.color = P.ink;
      box.style.border = Math.max(1, 0.0025 * unit) + "px solid " + alpha(P.ink, 0.22);
      var titleEl = document.getElementById("title");
      titleEl.textContent = String(P.label).trim();
      document.getElementById("thumb").style.background = mix(P.card, onColor(P.card), 0.18);
      var sel = document.getElementById("sel");
      sel.style.borderColor = P.accent;

      // Handles are children of the card, on its edges: 4 corner squares, or 8 dots with the edge middles. [fx, fy] = 0, 0.5 or 1 of the card's width and height.
      var spots = P.handles === "all" ? [[0, 0], [0.5, 0], [1, 0], [1, 0.5], [1, 1], [0.5, 1], [0, 1], [0, 0.5]] : [[0, 0], [1, 0], [1, 1], [0, 1]];
      var round = P.handles === "all";
      var handles = spots.map(function (spot) {
        var el = document.createElement("i");
        el.className = "handle";
        el.style.cssText = "left:" + spot[0] * 100 + "%;top:" + spot[1] * 100 + "%;width:" + hs + "px;height:" + hs + "px;margin:" + -hs / 2 + "px 0 0 " + -hs / 2 + "px;background:" + P.ink + ";border:" + Math.max(1.5, hs * 0.2) + "px solid " + P.accent + ";border-radius:" + (round ? "50%" : hs * 0.15 + "px");
        box.appendChild(el);
        return { el: el, grabbed: spot[0] === 1 && spot[1] === 1 };
      });

      // The size badge reads the final size in pixels of a frame whose short side is 1080 (the film's own pixels at 1920 x 1080).
      var scalePx = 1080 / unit;
      var text = Math.round(w1 * scalePx) + " x " + Math.round(h1 * scalePx);
      var bw = text.length * 0.6 * px + 3 * px;
      var badge = document.getElementById("badge");
      badge.textContent = text;
      badge.style.cssText += "left:" + Math.max(0.04 * S.width, bx + w1 - bw) + "px;top:" + (by + h1 + hs / 2 + gap) + "px;width:" + bw + "px;height:" + bh + "px;border-radius:" + bh / 2 + "px;font-size:" + px + "px;background:" + P.accent + ";color:" + onColor(P.accent);

      // The cursor presses inside the card, goes to its bottom-right handle, drags it to the new corner and lets go; then it drifts aside.
      var press1 = { x: bx + 0.45 * w0, y: by + 0.55 * h0 };
      var grab = { x: bx + w0, y: by + h0 };
      var drop = { x: bx + w1, y: by + h1 };
      var rest = inFrame({ x: drop.x + 0.07 * unit, y: drop.y - 0.06 * unit }, 0.12);
      var made = fitFirst(CURSOR_TRIES, function (hesitate, rate) {
        var trip = journey(FROM, [
          { x: press1.x, y: press1.y, wait: 0.34 },
          { x: grab.x, y: grab.y, hesitate: P.hesitate * hesitate, weight: "light", bend: 0.1, wait: 0.1 },
          { x: drop.x, y: drop.y, weight: "heavy", bend: 0.03, wait: 0.5 },
          { x: rest.x, y: rest.y, weight: "light", bend: 0.2 }
        ], START, { x: 0.004 * unit, y: 0.003 * unit }, rate);
        return { trip: trip, ready: trip.legs[2].arrive + 0.08 };
      }, latest(0.7));
      var trip = made.trip;
      var clickAt = trip.legs[0].arrive + 0.04;
      var grabAt = trip.legs[1].arrive + 0.02;
      var upAt = trip.legs[2].arrive + 0.04;

      // The card's size at time t: the dragged corner is under the cursor, from the grab to the drop; the overshoot of the cursor is cut at the frame's margin.
      function sizeAt(t) {
        var c = trip.at(Math.min(trip.legs[2].arrive, Math.max(trip.legs[1].arrive, t)));
        return { w: Math.min(maxR - bx, Math.max(minW, c.x - bx)), h: Math.min(maxB - by, Math.max(minH, c.y - by)) };
      }

      // The follow camera: in by the first press, out again once the badge has been read.
      var follow = P.camera === "follow";
      var camIn = Math.max(0.5, clickAt - 0.1);
      var camOut = Math.max(upAt + 0.3, Math.min(upAt + 0.9, latest(0.7)));

      var world = document.getElementById("world");
      var D = S.duration;
      var OUT = 0.3;

      M.bind("${id}", function (t) {
        var out = M.ease("exit", (t - (D - OUT)) / OUT);
        put(backdrop, { opacity: P.backdrop * M.ease("enter", t / 0.3) * (1 - out) });
        // Holds never stop: a slow push over the whole clip, or the follow camera.
        if (follow) {
          var cam = camera(trip.at(Math.max(0, t - 0.12)), zoomAt(t, 0.1, camIn, camOut, camOut + 0.7), P.zoom);
          put(world, { x: cam.x, y: cam.y, scale: cam.scale * (1 - 0.02 * out), opacity: 1 - out });
        } else {
          put(world, { scale: 1 + 0.025 * Math.min(1, t / D) - 0.02 * out, opacity: 1 - out });
        }

        // The card comes up first; its box is written as layout, rounded to 0.01 px, so a resize never blurs it.
        var s = M.spring("default", t - 0.05);
        var size = sizeAt(t);
        box.style.left = stamp(bx) + "px";
        box.style.top = stamp(by) + "px";
        box.style.width = stamp(size.w) + "px";
        box.style.height = stamp(size.h) + "px";
        put(box, { y: (1 - s) * px * 1.2, scale: 0.94 + 0.06 * s, opacity: M.ease("enter", (t - 0.05) / 0.2) });

        // The press is the beat everything hangs on: the ring, the handles and the ripple start on its frame.
        put(sel, { opacity: M.ease("snap", (t - clickAt) / 0.12) });
        var held = M.ease("snap", (t - grabAt) / 0.1) * (1 - M.ease("enter", (t - upAt) / 0.15));
        for (var k = 0; k < handles.length; k++) {
          put(handles[k].el, { scale: M.spring("snappy", t - clickAt) * (handles[k].grabbed ? 1 + 0.3 * held : 1), opacity: M.ease("enter", (t - clickAt) / 0.1) });
        }

        // The release is the next beat: the size springs in on the same frame.
        var b = M.spring("default", t - upAt);
        put(badge, { y: (1 - b) * bh * 0.7, scale: 0.9 + 0.1 * b, opacity: M.ease("enter", (t - upAt) / 0.15) });

        drawRipple(t, clickAt, press1.x, press1.y);
        drawCursor(trip.at(t), Math.min(press(t, clickAt, clickAt + 0.1), press(t, grabAt, upAt)));
      });
    </script>
  </body>
</html>
`;
  },
};
