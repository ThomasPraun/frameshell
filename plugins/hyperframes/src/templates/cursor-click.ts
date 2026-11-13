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
 * Cursor click (#466, UI demo): a cursor enters from outside the frame, hesitates,
 * clicks a button, and on that same frame the button presses, a ring spreads and
 * a confirmation springs in; then the cursor drifts aside. With `camera` set to
 * follow, the frame zooms in with the cursor to the click and pulls back after it.
 * A clip too short for the click gets a cursor without its hesitation, then a
 * faster one (timing guard). Transparent unless `backdrop` is raised.
 */
export const cursorClick: Template = {
  id: "cursor-click",
  description: "Cursor click: a cursor arrives on an arc, hesitates, presses a button and a confirmation appears on that frame; transparent unless a background is set",
  defaultDuration: 4,
  overlay: true,
  variables({ tokens }: TemplateInput): TemplateVariable[] {
    return [
      { id: "button", type: "string", label: "Button text", default: tokens.brand.cta ?? "Start free trial", maxLength: 28 },
      { id: "result", type: "string", label: "Confirmation that appears under the button; empty for none", default: "You're in. Welcome aboard", maxLength: 40 },
      hesitateVariable(0.3),
      ...cameraVariables(),
      { id: "ink", type: "color", label: "Confirmation text colour", default: tokens.colors.ink ?? PLACEHOLDER.ink },
      { id: "accent", type: "color", label: "Button colour", default: tokens.colors.accent ?? PLACEHOLDER.accent },
      { id: "card", type: "color", label: "Confirmation card colour", default: tokens.colors.card ?? PLACEHOLDER.bg },
      ...cursorVariables(),
      { id: "size", type: "number", label: "Button size, 1 = the format's default", default: 1, min: 0.6, max: 1.6, step: 0.05 },
      ...backdropVariables(tokens),
    ];
  },
  render(input: TemplateInput): string {
    const { id, width, height, duration } = input;
    const fonts = fontSetup(input.tokens);
    const css = `
      ${BACKDROP_CSS}
      #world { position: absolute; inset: 0; }
      #button { position: absolute; display: flex; align-items: center; justify-content: center; white-space: nowrap; font-family: ${fonts.ui}; font-weight: 700; letter-spacing: -0.005em; }
      #toast { position: absolute; display: flex; align-items: center; justify-content: center; gap: 0.55em; white-space: nowrap; font-family: ${fonts.ui}; font-weight: 600; }
      #check { position: relative; flex: none; width: 1.35em; height: 1.35em; border-radius: 50%; }
      #check b { position: absolute; left: 36%; top: 17%; width: 26%; height: 50%; border: solid; border-width: 0 0.14em 0.14em 0; transform: rotate(45deg); }
      ${CURSOR_CSS}`;
    return `${pageHead(input, this.variables(input), css)}
  <body>
    <!-- Root: size and length of the render. FrameshellMotion.bind below registers its timeline, so the render
         does not wait for one. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
      <div id="cursor-click-clip" class="clip">
        <div id="backdrop"></div>
        <div id="world">
          <div id="button"></div>
          <div id="toast"><i id="check"><b></b></i><span id="toast-text"></span></div>
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

      // Layout per format (sizes are fractions of the short side, y of the frame height). wide, square, tall.
      var L = M.pick({ y: 0.46, size: 0.05 }, { y: 0.44, size: 0.05 }, { y: 0.42, size: 0.048 });
      var label = String(P.button);
      var result = String(P.result);
      // Text is about 0.6 em per character, so the button and its card are fitted to the frame without measuring text.
      var px = Math.min(L.size * unit * P.size, (0.84 * S.width) / (label.length * 0.6 + 2.8));
      var bw = label.length * 0.6 * px + 2.8 * px;
      var bh = px * 2.5;
      var cx = S.width / 2;
      var by = L.y * S.height;
      var pxT = Math.min(px * 0.8, (0.9 * S.width) / (result.length * 0.58 + 4));
      var tw = result.length * 0.58 * pxT + 4 * pxT;
      var th = pxT * 2.5;
      var ty = by + bh / 2 + px * 0.9 + th / 2;

      var button = document.getElementById("button");
      button.innerHTML = '<span></span>';
      button.firstChild.textContent = label;
      button.style.cssText += "left:" + (cx - bw / 2) + "px;top:" + (by - bh / 2) + "px;width:" + bw + "px;height:" + bh + "px;border-radius:" + bh / 2 + "px;font-size:" + px + "px;background:" + P.accent + ";color:" + onColor(P.accent);

      var toast = document.getElementById("toast");
      var toastText = document.getElementById("toast-text");
      var check = document.getElementById("check");
      toastText.textContent = result;
      toast.style.cssText += "left:" + (cx - tw / 2) + "px;top:" + (ty - th / 2) + "px;width:" + tw + "px;height:" + th + "px;border-radius:" + th / 2 + "px;font-size:" + pxT + "px;background:" + P.card + ";color:" + P.ink + ";" + (result ? "" : "display:none;");
      check.style.background = P.accent;
      check.firstChild.style.borderColor = onColor(P.accent);

      // The cursor arrives on an arc, hesitates, and clicks a little right of the button's centre; then it drifts aside.
      var target = { x: cx + 0.15 * bw, y: by + 0.1 * bh };
      var rest = inFrame({ x: cx + Math.max(bw, result ? tw : 0) / 2 + 0.04 * unit, y: ty + th * 0.2 }, 0.06);
      var stops = function (hesitate) {
        return [
          { x: target.x, y: target.y, hesitate: P.hesitate * hesitate, wait: 0.54 },
          { x: rest.x, y: rest.y, weight: "light", bend: 0.2 }
        ];
      };
      // The click is the one moment everything else hangs on: the press, the ring and the confirmation share it.
      var made = fitFirst(CURSOR_TRIES, function (hesitate, rate) {
        var trip = journey(FROM, stops(hesitate), START, { x: 0.004 * unit, y: 0.003 * unit }, rate);
        return { trip: trip, ready: trip.legs[0].arrive + 0.04 };
      }, latest(0.5));
      var trip = made.trip;
      var clickAt = made.ready;

      // The follow camera: in by the press, out again once the confirmation has been read.
      var follow = P.camera === "follow";
      var camIn = Math.max(0.5, clickAt - 0.1);
      var camOut = Math.max(clickAt + 0.3, Math.min(clickAt + 0.9, latest(0.7)));

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

        var cp = press(t, clickAt, clickAt + 0.1);
        var hover = M.ease("enter", (t - (trip.legs[0].arrive - 0.2)) / 0.25);
        var rise = M.spring("heavy", t - 0.05);
        put(button, { scale: (0.9 + 0.1 * rise) * (1 + 0.03 * hover) * (1 - 0.375 * (1 - cp)), opacity: M.ease("enter", (t - 0.05) / 0.2) });

        // The next beat, on the click's own frame.
        var s = M.spring("default", t - clickAt);
        put(toast, { y: (1 - s) * th * 0.7, scale: 0.9 + 0.1 * s, opacity: M.ease("enter", (t - clickAt) / 0.15) });
        put(check, { scale: 0.4 + 0.6 * M.spring("snappy", t - clickAt - 0.08), opacity: M.ease("enter", (t - clickAt - 0.08) / 0.1) });
        drawRipple(t, clickAt, target.x, target.y);
        drawCursor(trip.at(t), cp);
      });
    </script>
  </body>
</html>
`;
  },
};
