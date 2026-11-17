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
 * Locked on (#466 TP4): four corner brackets that start far outside a target
 * box, snap onto its corners with an overshoot (they pass the corner a little
 * and come back), then a hairline outline, a one-off pulse and a small label
 * confirm the lock. The target is `x`, `y`, `w`, `h` as fractions of the frame,
 * so one box suits every format; where the label sits and how thick the lines
 * are are per format. The box is kept inside the frame with a margin. Holds
 * never stop: the brackets creep inward over the clip. Transparent, nothing
 * else drawn.
 */
export const lockedOn: Template = {
  id: "locked-on",
  description: "Locked on: four corner brackets snap onto a target box (x, y, w, h as fractions of the frame) with an overshoot, then a pulse and a small label; transparent, for pointing at something in footage",
  defaultDuration: 3.5,
  overlay: true,
  variables({ tokens }: TemplateInput): TemplateVariable[] {
    return [
      { id: "x", type: "number", label: "Target box, left edge as a fraction of the frame width", default: 0.56, min: 0, max: 0.95, step: 0.01 },
      { id: "y", type: "number", label: "Target box, top edge as a fraction of the frame height", default: 0.3, min: 0, max: 0.95, step: 0.01 },
      { id: "w", type: "number", label: "Target box width as a fraction of the frame width", default: 0.26, min: 0.05, max: 0.92, step: 0.01 },
      { id: "h", type: "number", label: "Target box height as a fraction of the frame height", default: 0.34, min: 0.05, max: 0.92, step: 0.01 },
      { id: "label", type: "string", label: "Small label by the box; empty for none", default: "Locked on", maxLength: 28 },
      { id: "lockAt", type: "number", label: "Seconds until the brackets start to snap (pulled in on a short clip)", default: 0.6, min: 0.1, max: 3, step: 0.1, unit: "s" },
      { id: "from", type: "number", label: "How far outside the box the brackets start, 1 = on it", default: 1.9, min: 1.2, max: 3, step: 0.1 },
      { id: "accent", type: "color", label: "Bracket and label colour", default: tokens.colors.accent ?? PLACEHOLDER.accent },
      { id: "size", type: "number", label: "Line and label size, 1 = the format's default", default: 1, min: 0.5, max: 1.6, step: 0.05 },
    ];
  },
  render(input: TemplateInput): string {
    const { id, width, height, duration } = input;
    const fonts = fontSetup(input.tokens);
    const css = `
      #box, #pulse { position: absolute; opacity: 0; }
      .bracket { position: absolute; opacity: 0; border: 0 solid; }
      #label { position: absolute; white-space: nowrap; max-width: 60%; overflow: hidden; text-overflow: ellipsis; font-family: ${fonts.ui}; font-weight: 700; line-height: 1.1; padding: 0.3em 0.75em 0.36em; border-radius: 0.4em; opacity: 0; }`;
    return `${pageHead(input, this.variables(input), css)}
  <body>
    <!-- Root: size and length of the render. FrameshellMotion.bind below registers its timeline, so the render
         does not wait for one. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
      <div id="locked-on-clip" class="clip">
        <i id="box"></i>
        <i id="pulse"></i>
        <i class="bracket" id="b0"></i><i class="bracket" id="b1"></i><i class="bracket" id="b2"></i><i class="bracket" id="b3"></i>
        <span id="label"></span>
      </div>
    </div>
    <script>
      var M = window.FrameshellMotion;
      var P = M.props();
      var S = M.stage();
      var unit = Math.min(S.width, S.height);
      ${COLOR_HELPERS}
      ${FLAT_HELPERS}

      // Layout per format: line thickness and label size as fractions of the short side. wide, square, tall.
      var L = M.pick({ line: 0.007, fs: 0.026 }, { line: 0.0075, fs: 0.03 }, { line: 0.008, fs: 0.03 });
      var th = Math.max(3, L.line * unit * P.size);
      var fs = L.fs * unit * P.size;

      // The box, kept inside the frame with a margin of 4 %.
      var bw = Math.min(P.w, 0.92) * S.width;
      var bh = Math.min(P.h, 0.92) * S.height;
      var bx = Math.min(Math.max(P.x * S.width, 0.04 * S.width), 0.96 * S.width - bw);
      var by = Math.min(Math.max(P.y * S.height, 0.04 * S.height), 0.96 * S.height - bh);
      // Arm of a bracket: a third of the short side of the box, within bounds.
      var arm = Math.min(Math.max(0.3 * Math.min(bw, bh), 0.035 * unit), 0.1 * unit);

      var box = document.getElementById("box");
      var pulse = document.getElementById("pulse");
      [box, pulse].forEach(function (el, i) {
        el.style.left = bx + "px";
        el.style.top = by + "px";
        el.style.width = bw + "px";
        el.style.height = bh + "px";
        el.style.border = (i ? th * 0.6 : Math.max(1.5, th * 0.4)) + "px solid " + alpha(P.accent, i ? 0.7 : 0.4);
      });

      // Corner k: sx, sy are -1 on the left and top edge, 1 on the right and bottom; the bracket's two borders are the two outer sides.
      var corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
      var brackets = corners.map(function (c, k) {
        var el = document.getElementById("b" + k);
        el.style.width = arm + "px";
        el.style.height = arm + "px";
        el.style.left = (c[0] < 0 ? bx : bx + bw - arm) + "px";
        el.style.top = (c[1] < 0 ? by : by + bh - arm) + "px";
        el.style[c[0] < 0 ? "borderLeftWidth" : "borderRightWidth"] = th + "px";
        el.style[c[1] < 0 ? "borderTopWidth" : "borderBottomWidth"] = th + "px";
        el.style.borderColor = P.accent;
        return el;
      });

      // The label sits above the box's left edge, or below the box when there is no room above.
      var label = document.getElementById("label");
      var text = String(P.label).trim();
      label.textContent = text;
      label.style.fontSize = fs + "px";
      label.style.background = P.accent;
      label.style.color = onColor(P.accent);
      label.style.left = bx + "px";
      var above = by - 2.2 * fs - th >= 0.03 * S.height;
      if (above) label.style.bottom = S.height - by + th * 0.8 + "px";
      else label.style.top = by + bh + th * 0.8 + "px";
      if (!text) label.style.display = "none";

      var D = S.duration;
      var OUT = 0.3;
      // The snap and the label need about a second: a late lock is pulled in so it is done before the exit.
      var AT = Math.min(P.lockAt, Math.max(0.1, D - OUT - 1));
      // A spring with about 12 % overshoot: the brackets pass the corners a little and settle back onto them.
      var SNAP = { response: 0.34, damping: 0.55 };
      var LOCK = 0.2;

      M.bind("${id}", function (t) {
        var out = M.ease("exit", (t - (D - OUT)) / OUT);
        var creep = 0.015 * Math.min(bw, bh) * Math.min(1, t / D);
        for (var k = 0; k < 4; k++) {
          var c = corners[k];
          var at = AT + 0.04 * k;
          var s = M.spring(SNAP, t - at);
          // From the corner of a larger box; the overshoot carries it inside the corner and back. Only a translation: a bracket that also turns and scales is drawn differently by Chrome depending on the frame painted before it.
          put(brackets[k], {
            x: c[0] * (P.from - 1) * (bw / 2) * (1 - s) - c[0] * creep,
            y: c[1] * (P.from - 1) * (bh / 2) * (1 - s) - c[1] * creep,
            opacity: M.ease("enter", (t - at) / 0.12) * (1 - out),
          });
        }
        // The lock: the outline appears, one pulse leaves it and the label rises, a moment after the first bracket lands.
        var lock = AT + LOCK;
        var f = (t - lock) / 0.45;
        put(box, { opacity: M.ease("enter", (t - lock) / 0.25) * (1 - out) });
        put(pulse, { scale: 1 + 0.1 * M.ease("enter", f), opacity: f > 0 && f < 1 ? 0.8 * (1 - f) * (1 - out) : 0 });
        var up = M.spring("default", t - lock - 0.1);
        put(label, { y: (1 - up) * fs * (above ? 0.9 : -0.9), opacity: M.ease("enter", (t - lock - 0.1) / 0.2) * (1 - out) });
      });
    </script>
  </body>
</html>
`;
  },
};
