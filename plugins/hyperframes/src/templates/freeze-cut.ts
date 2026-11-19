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
 * Beat freeze cut (owner decision): a template over a still
 * picture, not a freeze-frame operation on the timeline. The picture drifts
 * and sways as if it were footage, then on the beat it freezes: a hard punch-in
 * toward a focus point, a white flash that falls away, and an optional label
 * that pops in. The still comes from an image prop; to freeze a moment of a
 * video, export that frame (`frame`) and name the file. With no image it shows a
 * plain placeholder figure. Paints its own background.
 */
export const freezeCut: Template = {
  id: "freeze-cut",
  description: "Beat freeze cut: a still picture drifts, then on the beat freezes with a punch-in, a white flash and an optional label; make the still with an exported frame; paints its own background",
  defaultDuration: 3.5,
  overlay: false,
  variables({ tokens }: TemplateInput): TemplateVariable[] {
    return [
      { id: "image", type: "image", label: "The still", default: "", description: "Path of an image inside this composition's directory, e.g. still.png (export a video frame with `frameshell frame`); empty shows a placeholder figure" },
      { id: "label", type: "string", label: "Label that pops in after the flash; empty for none", default: "Right there", maxLength: 40 },
      { id: "cutAt", type: "number", label: "Seconds until the freeze, on the beat (pulled in on a short clip)", default: 0.9, min: 0.3, max: 4, step: 0.05, unit: "s" },
      { id: "punch", type: "number", label: "Punch-in at the freeze, 1 = none", default: 1.14, min: 1, max: 1.6, step: 0.02 },
      { id: "flash", type: "number", label: "White flash at the freeze, 0 = none", default: 0.9, min: 0, max: 1, step: 0.05 },
      { id: "flashTime", type: "number", label: "Seconds the flash takes to fall away", default: 0.22, min: 0.1, max: 0.6, step: 0.02, unit: "s" },
      { id: "focusX", type: "number", label: "Where the punch-in goes, across the picture (0 = left, 1 = right)", default: 0.5, min: 0, max: 1, step: 0.05 },
      { id: "focusY", type: "number", label: "Where the punch-in goes, down the picture (0 = top, 1 = bottom)", default: 0.4, min: 0, max: 1, step: 0.05 },
      { id: "bg", type: "color", label: "Background colour (and the placeholder's)", default: tokens.colors.bg ?? PLACEHOLDER.bg },
      { id: "accent", type: "color", label: "Label colour", default: tokens.colors.accent ?? PLACEHOLDER.accent },
      { id: "size", type: "number", label: "Label size, 1 = the format's default", default: 1, min: 0.5, max: 1.6, step: 0.05 },
    ];
  },
  render(input: TemplateInput): string {
    const { id, width, height, duration } = input;
    const fonts = fontSetup(input.tokens);
    const css = `
      #bg { position: absolute; inset: 0; }
      #pic { position: absolute; inset: 0; }
      #pic img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
      #pic i { position: absolute; display: block; }
      #flash { position: absolute; inset: 0; background: #ffffff; opacity: 0; }
      #label { position: absolute; left: 0; right: 0; text-align: center; }
      #chip { display: inline-block; white-space: nowrap; padding: 0.3em 0.9em 0.36em; border-radius: 999px; font-family: ${fonts.display}; font-weight: ${fonts.displayWeight}; line-height: 1.1; letter-spacing: -0.01em; box-shadow: 0 0.2em 1em rgba(0, 0, 0, 0.35); }`;
    return `${pageHead(input, this.variables(input), css)}
  <body>
    <!-- Root: size and length of the render. FrameshellMotion.bind below registers its timeline, so the render
         does not wait for one. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
      <div id="freeze-cut-clip" class="clip">
        <div id="bg"></div>
        <div id="pic"></div>
        <div id="flash"></div>
        <div id="label"><span id="chip"></span></div>
      </div>
    </div>
    <script>
      var M = window.FrameshellMotion;
      var P = M.props();
      var S = M.stage();
      var unit = Math.min(S.width, S.height);
      ${COLOR_HELPERS}
      ${FLAT_HELPERS}

      // Layout per format: label size and its distance from the bottom edge, as fractions of the short side / the height. wide, square, tall.
      var L = M.pick({ type: 0.07, bottom: 0.14 }, { type: 0.07, bottom: 0.16 }, { type: 0.06, bottom: 0.22 });

      var bg = document.getElementById("bg");
      bg.style.background = "radial-gradient(ellipse at 50% 38%, " + mix(P.bg, "#ffffff", 0.12) + " 0%, " + P.bg + " 75%)";
      var pic = document.getElementById("pic");
      pic.style.transformOrigin = P.focusX * 100 + "% " + P.focusY * 100 + "%";
      if (P.image) {
        var img = document.createElement("img");
        img.alt = "";
        img.src = P.image;
        pic.appendChild(img);
      } else {
        // No still given: a plain figure (head and shoulders) at the focus point against a soft light, so the punch-in has something to hit.
        var fx = P.focusX * S.width;
        var fy = P.focusY * S.height;
        var head = unit * 0.22;
        [[fx - unit * 0.3, fy + head * 0.5, unit * 0.6, S.height - fy + unit * 0.3, mix(P.bg, "#000000", 0.4), "50% 50% 0 0"], [fx - head / 2, fy - head / 2, head, head, mix(P.bg, "#000000", 0.55), "50%"], [S.width * 0.72, S.height * 0.14, unit * 0.18, unit * 0.18, mix(P.bg, P.accent, 0.5), "50%"]].forEach(function (b) {
          var el = document.createElement("i");
          el.style.cssText = "left:" + b[0] + "px;top:" + b[1] + "px;width:" + b[2] + "px;height:" + b[3] + "px;background:" + b[4] + ";border-radius:" + b[5] + ";";
          pic.appendChild(el);
        });
      }

      var label = document.getElementById("label");
      var chip = document.getElementById("chip");
      var text = String(P.label).trim();
      chip.textContent = text;
      chip.style.background = P.accent;
      chip.style.color = onColor(P.accent);
      if (!text) label.style.display = "none";
      // Letters are about 0.6 em wide: the label shrinks until it fits inside the frame without measuring text.
      var px = Math.min(L.type * unit * P.size, (0.8 * S.width) / ((text.length + 2) * 0.6));
      label.style.fontSize = px + "px";
      label.style.top = S.height * (1 - L.bottom) - px * 0.9 + "px";

      var flash = document.getElementById("flash");
      var D = S.duration;
      var OUT = 0.3;
      // The freeze needs room after it for the flash to fall and the label to land: a late one is pulled in.
      var CUT = Math.min(P.cutAt, Math.max(0.3, D - OUT - 0.8));

      M.bind("${id}", function (t) {
        var out = M.ease("exit", (t - (D - OUT)) / OUT);
        // Before the cut the picture lives: a push of 4 % and a sway, both stopping dead at the cut. After it the picture is held,
        // punched in hard (out-expo) and pushing very slowly, so the hold is not a dead frame.
        var live = Math.min(t, CUT) / CUT;
        var base = 1 + 0.04 * live;
        var after = Math.max(0, t - CUT);
        var punch = 1 + (P.punch - 1) * M.ease("snap", after / 0.18);
        var push = 1 + 0.02 * Math.min(1, after / (D - CUT));
        var scale = base * punch * push;
        // The scale grows from the focus point, so the edge nearest it does not move: the sway may only use the room the scale has
        // gained on each side, else a sliver of the background shows at that edge.
        var room = (flat(scale) - 1) * S.width;
        var sway = Math.max(-(1 - P.focusX) * room, Math.min(P.focusX * room, Math.sin(Math.min(t, CUT) * 2.2) * unit * 0.006 * live));
        put(pic, { x: sway, scale: scale, opacity: 1 - out });
        // The flash is white at the cut and falls away on a square (half gone after about two frames at 30 fps); it never starts before it.
        M.write(flash, { opacity: t < CUT ? 0 : P.flash * Math.pow(1 - M.ease("progress", after / P.flashTime), 2) });
        // The label pops after the flash has cleared the worst of it.
        var pop = M.spring("playful", t - CUT - 0.12);
        put(chip, { x: 0, y: (1 - pop) * px * 0.8, scale: 0.7 + 0.3 * pop, opacity: M.ease("enter", (t - CUT - 0.12) / 0.12) * (1 - out) });
      });
    </script>
  </body>
</html>
`;
  },
};
