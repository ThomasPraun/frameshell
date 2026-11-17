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
import { SCREEN_HELPERS, SKELETON_HTML } from "./ui-parts.js";

/**
 * Phone fan (#466 TP4): three phones that start as a stack and fan out, the
 * outer two turning about a point below the middle one (a hand of cards), each
 * showing one picture. A phone with no picture shows the plain app screen
 * `device-frame` shows (`paintSkeleton`, `dressPhone` in `ui-parts.ts`). The
 * fan is sized so its farthest corner stays inside the frame in every format,
 * and an optional caption sits under it. Transparent unless `backdrop` is raised.
 */
export const phoneFan: Template = {
  id: "phone-fan",
  description: "Phone fan: three phones start as a stack and fan out like a hand of cards, one picture each (a plain app screen when empty), optional caption; transparent unless a background is set",
  defaultDuration: 4.5,
  overlay: true,
  variables({ tokens }: TemplateInput): TemplateVariable[] {
    const shot = (id: string, label: string): TemplateVariable => ({
      id,
      type: "image",
      label,
      default: "",
      description: "Path of an image inside this composition's directory, e.g. shot.png; empty shows a plain app screen",
    });
    return [
      shot("shotLeft", "Screenshot on the left phone"),
      shot("shotMiddle", "Screenshot on the middle phone, the one in front"),
      shot("shotRight", "Screenshot on the right phone"),
      { id: "caption", type: "string", label: "Line under the fan; empty for none", default: "", maxLength: 60 },
      { id: "fan", type: "number", label: "How far the outer phones turn, degrees", default: 12, min: 4, max: 24, step: 1, unit: "°" },
      { id: "fanAt", type: "number", label: "Seconds until the fan opens (pulled in on a short clip)", default: 1, min: 0.3, max: 4, step: 0.1, unit: "s" },
      { id: "ink", type: "color", label: "Caption colour", default: tokens.colors.ink ?? PLACEHOLDER.ink },
      { id: "accent", type: "color", label: "Header colour of the plain app screen", default: tokens.colors.accent ?? PLACEHOLDER.accent },
      { id: "size", type: "number", label: "Phone size, 1 = the format's default (never larger than fits the frame)", default: 1, min: 0.5, max: 1.2, step: 0.05 },
      ...backdropVariables(tokens),
    ];
  },
  render(input: TemplateInput): string {
    const { id, width, height, duration } = input;
    const fonts = fontSetup(input.tokens);
    const css = `
      ${BACKDROP_CSS}
      .phone { position: absolute; overflow: hidden; box-shadow: 0 0.7em 1.6em rgba(0, 0, 0, 0.4); }
      .screen { position: relative; overflow: hidden; }
      .skeleton, .shot { position: absolute; inset: 0; width: 100%; height: 100%; }
      .shot { object-fit: cover; }
      .skeleton i { position: absolute; display: block; border-radius: 0.5em; }
      .island { position: absolute; left: 50%; top: 2.2%; width: 28%; height: 3.2%; margin-left: -14%; border-radius: 999px; background: #05060a; }
      #caption { position: absolute; left: 0; right: 0; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-family: ${fonts.display}; font-weight: ${fonts.displayWeight}; line-height: 1.15; text-shadow: 0 0.06em 0.4em rgba(0, 0, 0, 0.45); }`;
    return `${pageHead(input, this.variables(input), css)}
  <body>
    <!-- Root: size and length of the render. FrameshellMotion.bind below registers its timeline, so the render
         does not wait for one. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
      <div id="phone-fan-clip" class="clip">
        <div id="backdrop"></div>
        <span id="caption"></span>
      </div>
    </div>
    <script>
      var M = window.FrameshellMotion;
      var P = M.props();
      var S = M.stage();
      var unit = Math.min(S.width, S.height);
      ${COLOR_HELPERS}
      ${FLAT_HELPERS}
      ${SCREEN_HELPERS}
      ${BACKDROP_SETUP}

      // Layout per format: phone height as a fraction of the frame height, the caption's size as a fraction of the short side. wide, square, tall.
      var L = M.pick({ h: 0.74, fs: 0.05 }, { h: 0.72, fs: 0.05 }, { h: 0.5, fs: 0.05 });
      var ASPECT = 9 / 19.5;
      var caption = document.getElementById("caption");
      var text = String(P.caption).trim();
      var room = text ? 0.12 : 0;
      if (!text) caption.style.display = "none";

      // Phones turn about a point 0.55 of their height below their centre. The fan's reach for a phone 1 high: the corners of the three phones, turned.
      var turn = (P.fan * Math.PI) / 180;
      var PIVOT = 0.55;
      var reach = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
      [-turn, 0, turn].forEach(function (angle) {
        [[-ASPECT / 2, -0.5], [ASPECT / 2, -0.5], [-ASPECT / 2, 0.5], [ASPECT / 2, 0.5]].forEach(function (c) {
          var rx = c[0], ry = c[1] - PIVOT;
          var x = rx * Math.cos(angle) - ry * Math.sin(angle);
          var y = PIVOT + rx * Math.sin(angle) + ry * Math.cos(angle);
          reach.minX = Math.min(reach.minX, x);
          reach.maxX = Math.max(reach.maxX, x);
          reach.minY = Math.min(reach.minY, y);
          reach.maxY = Math.max(reach.maxY, y);
        });
      });
      // The phone shrinks until the fan fits in 90 % of the width and the height left under the caption.
      var h = Math.min(L.h * S.height * P.size, (0.9 * S.width) / (reach.maxX - reach.minX), ((0.88 - room) * S.height) / (reach.maxY - reach.minY));
      var w = h * ASPECT;
      var cx = S.width / 2 - ((reach.minX + reach.maxX) / 2) * h;
      var cy = (0.5 - room / 2) * S.height - ((reach.minY + reach.maxY) / 2) * h;
      var clip = document.getElementById("phone-fan-clip");

      var shots = [P.shotLeft, P.shotRight, P.shotMiddle];
      // Back to front: the middle phone is the last child, so it is on top.
      var phones = shots.map(function (shot, k) {
        var el = document.createElement("div");
        el.className = "phone";
        el.innerHTML = '<div class="screen"><div class="skeleton">${SKELETON_HTML}</div><img class="shot" alt="" /><div class="island"></div></div>';
        el.style.left = cx - w / 2 + "px";
        el.style.top = cy - h / 2 + "px";
        el.style.width = w + "px";
        el.style.height = h + "px";
        el.style.transformOrigin = w / 2 + "px " + (h / 2 + PIVOT * h) + "px";
        var scr = el.firstChild;
        dressPhone(el, scr, w, h);
        var skeleton = scr.firstChild;
        var img = skeleton.nextSibling;
        paintSkeleton(skeleton, P.accent);
        if (shot) img.src = shot;
        else img.style.display = "none";
        clip.appendChild(el);
        return el;
      });

      caption.style.top = cy + reach.maxY * h + 0.03 * S.height + "px";
      caption.style.fontSize = L.fs * unit + "px";
      caption.style.color = P.ink;
      caption.textContent = text;

      var D = S.duration;
      var OUT = 0.3;
      // The rise and the fan take about a second: a late fan is pulled in so it is open before the exit.
      var OPEN = Math.min(P.fanAt, Math.max(0.3, D - OUT - 1));
      // Per phone, back to front (left, right, middle): the angle's sign, where it sits in the stack (fractions of its width and height), and how long after the middle phone it fans.
      var plan = [{ sign: -1, sx: -0.06, sy: 0.02, rise: 0.14, lag: 0.06 }, { sign: 1, sx: 0.06, sy: 0.02, rise: 0.18, lag: 0.1 }, { sign: 0, sx: 0, sy: 0, rise: 0.1, lag: 0 }];

      M.bind("${id}", function (t) {
        var out = M.ease("exit", (t - (D - OUT)) / OUT);
        M.write(backdrop, { opacity: P.backdrop * M.ease("enter", t / 0.3) * (1 - out) });
        for (var k = 0; k < 3; k++) {
          var p = plan[k];
          // They come up from below as a stack with a heavy spring, then fan; holds never stop, so they also push in slowly.
          var up = M.spring("heavy", t - p.rise);
          var f = M.spring("default", t - OPEN - p.lag);
          var lift = (1 - up) * 0.12 * h;
          put(phones[k], {
            x: p.sx * w * (1 - f),
            y: p.sy * h * (1 - f) + lift + out * 0.05 * h,
            rotate: p.sign * P.fan * f,
            scale: 0.94 + 0.06 * Math.min(1, f) + 0.02 * Math.min(1, t / D) - 0.03 * out,
            opacity: M.ease("enter", (t - p.rise) / 0.25) * (1 - out),
          });
        }
        put(caption, { y: (1 - M.spring("default", t - OPEN - 0.3)) * 0.02 * unit, opacity: M.ease("enter", (t - OPEN - 0.3) / 0.3) * (1 - out) });
      });
    </script>
  </body>
</html>
`;
  },
};
