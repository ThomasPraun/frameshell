import { type TemplateVariable, kitScript } from "./kit.js";

/** The two props every template with a cursor shares: the arrow's colour and its size. */
export function cursorVariables(): TemplateVariable[] {
  return [
    { id: "pointer", type: "color", label: "Cursor colour", default: "#ffffff" },
    { id: "cursorSize", type: "number", label: "Cursor height as a fraction of the short side of the frame", default: 0.055, min: 0.04, max: 0.07, step: 0.005 },
  ];
}

/** The prop that makes the cursor stop short of its target before the last small move. */
export function hesitateVariable(defaultSeconds: number): TemplateVariable {
  return { id: "hesitate", type: "number", label: "Seconds the cursor hesitates just before its target, 0 = none", default: defaultSeconds, min: 0, max: 1, step: 0.05, unit: "s" };
}

/** The two props of a template that can zoom in and follow its cursor to the click (needs {@link CAMERA_MATH}). */
export function cameraVariables(): TemplateVariable[] {
  return [
    {
      id: "camera",
      type: "enum",
      label: "Camera",
      default: "still",
      options: [
        { value: "still", label: "Still: a slow push over the whole clip" },
        { value: "follow", label: "Follow: zooms in and follows the cursor to the click, then pulls back" },
      ],
    },
    { id: "zoom", type: "number", label: "How far the follow camera zooms in, 1 = not at all", default: 1.6, min: 1.1, max: 2.4, step: 0.05 },
  ];
}

/** The prop of a template whose cursor is optional: on, or the action happens without one. */
export function cursorModeVariable(): TemplateVariable {
  return {
    id: "cursor",
    type: "enum",
    label: "Show the cursor that causes the action",
    default: "on",
    options: [
      { value: "on", label: "On" },
      { value: "off", label: "Off: the action happens by itself" },
    ],
  };
}

/** CSS of the cursor and the click ring; both are the last children of the clip. */
export const CURSOR_CSS = `
      #cursor { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
      #cursor svg { display: block; overflow: visible; }
      .ripple { position: absolute; left: 0; top: 0; border-radius: 50%; border: 0.18em solid; opacity: 0; }`;

/** HTML of the cursor and the click ring: after the scene, so they draw above it. */
export const CURSOR_HTML = `<i id="ripple" class="ripple"></i>
        <div id="cursor"></div>`;

/**
 * Page-script math of the cursor (pure: needs `M`, `S` and `unit` only). A cursor
 * is a carrier (#466): it travels leg by leg on quadratic arcs whose control
 * point sits 15 % of the leg's length off the chord, eases in and out with a
 * tiny overshoot, and may hesitate near its target. A click scales it to 0.84
 * in 0.1 s and back in 0.22 s.
 */
export const CURSOR_MATH = kitScript(String.raw`
      // Eases in and out and settles with a tiny overshoot (control points of a cubic-bezier).
      var CURSOR_EASE = [0.55, 0, 0.25, 1.1];

      // The cursor's travel: it leaves "from", visits the stops in order and waits at each for spot.wait seconds.
      // "rate" (1 when left out) shortens every leg: 2 moves twice as fast; the timing guard (fitFirst) raises it.
      // A stop is { x, y, wait, hesitate, bend, weight }; "hesitate" seconds of pause close to the target before the
      // last small move; "bend" is how far the arc bows as a fraction of the leg (0.15 default); "weight" is "light",
      // "normal" or "heavy". After the last stop it keeps drifting by "drift" ({ x, y } pixels per second).
      function journey(from, stops, start, drift, rate) {
        var legs = [];
        var clock = start;
        var prev = from;
        for (var i = 0; i < stops.length; i++) {
          var spot = stops[i];
          var dx = spot.x - prev.x;
          var dy = spot.y - prev.y;
          var dist = Math.sqrt(dx * dx + dy * dy);
          // Travel time depends on the distance at a 1080-pixel frame, so every render size moves alike.
          var dur = M.durationFromDistance((dist * 1080) / unit, spot.weight || "normal") / (rate || 1);
          var hold = spot.hesitate || 0;
          var travel = hold > 0 ? dur * 1.2 + hold : dur;
          var bend = (i % 2 === 0 ? 1 : -1) * (spot.bend === undefined ? 0.15 : spot.bend) * dist;
          legs.push({
            x0: prev.x, y0: prev.y, x1: spot.x, y1: spot.y,
            cx: (prev.x + spot.x) / 2 + (dist ? -dy / dist : 0) * bend,
            cy: (prev.y + spot.y) / 2 + (dist ? dx / dist : 0) * bend,
            start: clock, dur: dur, hold: hold,
            arrive: clock + travel,
            leave: clock + travel + (spot.wait || 0)
          });
          clock += travel + (spot.wait || 0);
          prev = spot;
        }
        // Fraction of a leg done u seconds after it starts.
        function progress(leg, u) {
          if (u <= 0) return 0;
          if (leg.hold <= 0) return M.ease(CURSOR_EASE, u / leg.dur);
          var a = leg.dur * 0.7;
          var b = leg.dur * 0.5;
          if (u < a) return 0.86 * M.ease("camera", u / a);
          if (u < a + leg.hold) return 0.86 + 0.02 * ((u - a) / leg.hold);
          return 0.88 + 0.12 * M.ease(CURSOR_EASE, (u - a - leg.hold) / b);
        }
        return {
          legs: legs,
          end: clock,
          at: function (t) {
            var leg = legs[0];
            for (var j = 0; j < legs.length; j++) {
              leg = legs[j];
              if (t < leg.leave) break;
            }
            var f = t >= leg.arrive ? 1 : progress(leg, t - leg.start);
            var g = 1 - f;
            var last = leg === legs[legs.length - 1] && t >= leg.arrive && drift;
            var after = last ? t - leg.arrive : 0;
            return {
              x: g * g * leg.x0 + 2 * g * f * leg.cx + f * f * leg.x1 + (last ? drift.x * after : 0),
              y: g * g * leg.y0 + 2 * g * f * leg.cy + f * f * leg.y1 + (last ? drift.y * after : 0)
            };
          }
        };
      }

      // Timing guard: the first of the "tries" (argument lists of build) whose result is "ready" by the deadline.
      // Nothing fits: the last try is returned, so a clip too short for the action still shows it as fast as it can.
      function fitFirst(tries, build, deadline) {
        var made;
        for (var i = 0; i < tries.length; i++) {
          made = build.apply(null, tries[i]);
          if (made.ready <= deadline) return made;
        }
        return made;
      }
      // Tries for a template whose cursor travels: as asked, then without the hesitation, then with faster legs. Arguments are (hesitate factor, rate).
      var CURSOR_TRIES = [[1, 1], [0, 1], [0, 1.25], [0, 1.6], [0, 2.2]];
      // Latest moment a beat may happen so that "tail" seconds of its aftermath show before the clip's 0.3 s exit.
      function latest(tail) {
        return S.duration - 0.3 - tail;
      }

      // Scale of the cursor: pressed down at "down" (0.84 in 0.1 s), let go at "up" (back in 0.22 s). A click is up = down + 0.1.
      function press(t, down, up) {
        var d = M.ease("snap", (t - down) / 0.1);
        var r = M.ease("pop", (t - up) / 0.22);
        return 1 - 0.16 * d * (1 - r);
      }

      // Chrome keeps a layer's earlier raster for a scale within about 0.6 % of 1, so the same time would paint one pixel
      // differently depending on where the player came from. A scale that close to 1 is written as exactly 1.
      function flat(scale) {
        return scale !== undefined && Math.abs(scale - 1) < 0.006 ? 1 : scale;
      }
      // M.write with every scale made flat.
      function put(element, pose) {
        M.write(element, { x: pose.x, y: pose.y, rotate: pose.rotate, scale: flat(pose.scale), scaleX: flat(pose.scaleX), scaleY: flat(pose.scaleY), opacity: pose.opacity });
      }

      // Keeps a point inside the frame, "margin" (a fraction of the short side) from every edge.
      function inFrame(p, margin) {
        var m = margin * unit;
        return { x: Math.min(S.width - m, Math.max(m, p.x)), y: Math.min(S.height - m, Math.max(m, p.y)) };
      }`);

/**
 * Page-script math of the follow camera (needs `M`, `S`): the scene scales about
 * the frame's centre and slides so the cursor comes toward the centre, never so
 * far that the scene's edge shows inside the frame.
 */
export const CAMERA_MATH = kitScript(String.raw`
      // "e" is how far the camera has zoomed (0 = the whole frame, 1 = full zoom); "focus" is the scene point it brings toward the centre. Returns a pose for put().
      function camera(focus, e, zoom) {
        var z = 1 + (zoom - 1) * e;
        var mx = (S.width / 2) * (z - 1);
        var my = (S.height / 2) * (z - 1);
        return {
          x: Math.min(mx, Math.max(-mx, -z * (focus.x - S.width / 2) * e)),
          y: Math.min(my, Math.max(-my, -z * (focus.y - S.height / 2) * e)),
          scale: z
        };
      }
      // How far the camera has zoomed at t: in over [a, b], held, out over [c, d] (b > a, d > c).
      function zoomAt(t, a, b, c, d) {
        return M.ease("camera", (t - a) / (b - a)) * (1 - M.ease("camera", (t - c) / (d - c)));
      }`);

/**
 * Page-script setup and painters of the cursor (needs {@link COLOR_HELPERS},
 * {@link CURSOR_MATH} and the template's `P`, `S`, `unit`): draws the arrow and
 * the click ring, and starts just outside the frame so it never fades in.
 */
export const CURSOR_SCRIPT = kitScript(String.raw`
      var cursorEl = document.getElementById("cursor");
      var rippleEl = document.getElementById("ripple");
      var curH = P.cursorSize * unit;
      cursorEl.innerHTML = '<svg width="' + (curH * 12 / 19) + '" height="' + curH + '" viewBox="0 0 12 19" style="margin: ' + (-0.6 * curH / 19) + 'px 0 0 ' + (-0.6 * curH / 19) + 'px"><path d="M0.6 0.6 L0.6 15.4 L4.2 12.2 L6.7 17.9 L9 16.9 L6.6 11.3 L11.2 11.3 Z" fill="' + P.pointer + '" stroke="' + onColor(P.pointer) + '" stroke-width="1" stroke-linejoin="round"/></svg>';
      var rippleSize = unit * 0.1;
      rippleEl.style.width = rippleSize + "px";
      rippleEl.style.height = rippleSize + "px";
      rippleEl.style.marginLeft = -rippleSize / 2 + "px";
      rippleEl.style.marginTop = -rippleSize / 2 + "px";
      rippleEl.style.borderColor = P.accent;
      rippleEl.style.fontSize = unit * 0.03 + "px";

      // Where the cursor starts: just outside the frame. wide, square, tall.
      var ENTRY = M.pick({ x: 1.05, y: 0.88 }, { x: 1.05, y: 0.94 }, { x: 0.86, y: 1.05 });
      var FROM = { x: ENTRY.x * S.width, y: ENTRY.y * S.height };
      var START = 0.05;

      // Puts the cursor at p, pressed or not; it is fully opaque from the first frame and leaves with the clip.
      function drawCursor(p, scale) {
        put(cursorEl, { x: p.x, y: p.y, scale: scale });
      }

      // The ring that spreads from a click at (x, y) at time "at".
      function drawRipple(t, at, x, y) {
        var f = (t - at) / 0.55;
        put(rippleEl, { x: x, y: y, scale: 0.25 + 1.1 * M.ease("enter", f), opacity: f <= 0 ? 0 : 0.5 * (1 - M.ease("progress", f)) });
      }`);
