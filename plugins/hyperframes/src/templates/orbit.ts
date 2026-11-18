import {
  BACKDROP_CSS,
  BACKDROP_SETUP,
  COLOR_HELPERS,
  FLAT_HELPERS,
  PLACEHOLDER,
  SEED_HELPERS,
  type Template,
  type TemplateInput,
  type TemplateVariable,
  backdropVariables,
  fontSetup,
  pageHead,
} from "./kit.js";
import { UI_HELPERS } from "./ui-parts.js";

/**
 * Orbit (#466 TP4): labels circling a logo or a word in the middle. They fly
 * out of the centre onto an ellipse, circle it and slow to a stop with the
 * long tail of the enter ease, so the clip ends on a still, evenly spaced ring
 * (the held frame is the one a viewer reads). The phase the circling starts
 * from and its direction come from a seeded hash, so one `seed` always paints
 * the same frames while the resting ring never depends on it. Chips at the
 * back are smaller and dimmer: depth from the sine of the angle, no 3D.
 * Transparent unless `backdrop` is raised.
 */
export const orbit: Template = {
  id: "orbit",
  description: "Orbit: labels circle a logo or a word, seeded start phase, and slow to a hold on an evenly spaced ring; transparent unless a background is set",
  defaultDuration: 4,
  overlay: true,
  variables({ tokens }: TemplateInput): TemplateVariable[] {
    return [
      {
        id: "logo",
        type: "image",
        label: "Logo in the middle",
        default: "",
        description: "Path of an image inside this composition's directory, e.g. logo.png; empty shows the word",
      },
      { id: "word", type: "string", label: "Word in the middle when there is no logo; empty for none", default: tokens.brand.product ?? "Your brand", maxLength: 30 },
      { id: "items", type: "string", label: "Labels that circle, separated by | (the first 8 are shown)", default: "Edit|Captions|Music|Export|Share", maxLength: 300 },
      { id: "seed", type: "string", label: "Any text; a different one starts the circling from another phase and may turn it the other way", default: "frameshell", maxLength: 40 },
      { id: "turns", type: "number", label: "Turns it makes before it stops", default: 1.25, min: 0.25, max: 4, step: 0.25 },
      { id: "spinTime", type: "number", label: "Seconds the circling takes to slow to a stop (shortened on a short clip)", default: 2.4, min: 0.8, max: 6, step: 0.1, unit: "s" },
      { id: "card", type: "color", label: "Label colour", default: tokens.colors.card ?? "#f1f3f9" },
      { id: "ink", type: "color", label: "Word colour", default: tokens.colors.ink ?? PLACEHOLDER.ink },
      { id: "accent", type: "color", label: "Path and word underline colour", default: tokens.colors.accent ?? PLACEHOLDER.accent },
      { id: "size", type: "number", label: "Size, 1 = the format's default", default: 1, min: 0.5, max: 1.5, step: 0.05 },
      ...backdropVariables(tokens),
    ];
  },
  render(input: TemplateInput): string {
    const { id, width, height, duration } = input;
    const fonts = fontSetup(input.tokens);
    const css = `
      ${BACKDROP_CSS}
      #group { position: absolute; inset: 0; }
      #path { position: absolute; border-radius: 50%; opacity: 0; }
      #core { position: absolute; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
      #logo { display: block; object-fit: contain; }
      #word { white-space: nowrap; font-family: ${fonts.display}; font-weight: ${fonts.displayWeight}; line-height: 1.05; letter-spacing: -0.01em; text-shadow: 0 0.06em 0.4em rgba(0, 0, 0, 0.45); }
      #rule { margin-top: 0.12em; height: 0.07em; width: 55%; border-radius: 999px; }
      /* Each slot is a zero-size anchor on the ring's centre; its chip centres on the anchor and the pose moves it. */
      .slot { position: absolute; width: 0; height: 0; display: flex; align-items: center; justify-content: center; }
      .chip { flex: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-family: ${fonts.ui}; font-weight: 700; line-height: 1.1; padding: 0.4em 0.95em 0.46em; border-radius: 999px; box-shadow: 0 0.3em 1em rgba(0, 0, 0, 0.3); }`;
    return `${pageHead(input, this.variables(input), css)}
  <body>
    <!-- Root: size and length of the render. FrameshellMotion.bind below registers its timeline, so the render
         does not wait for one. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
      <div id="orbit-clip" class="clip">
        <div id="backdrop"></div>
        <div id="group">
          <i id="path"></i>
          <div id="core"><img id="logo" alt="" /><span id="word"></span><i id="rule"></i></div>
        </div>
      </div>
    </div>
    <script>
      var M = window.FrameshellMotion;
      var P = M.props();
      var S = M.stage();
      var unit = Math.min(S.width, S.height);
      ${COLOR_HELPERS}
      ${UI_HELPERS}
      ${FLAT_HELPERS}
      ${SEED_HELPERS}
      ${BACKDROP_SETUP}

      // Layout per format: the ring's half width and half height as fractions of the frame, where its centre is as a fraction of the height, the label size as a fraction of the short side. wide, square, tall.
      var L = M.pick({ rx: 0.3, ry: 0.32, y: 0.5, fs: 0.034 }, { rx: 0.34, ry: 0.33, y: 0.5, fs: 0.036 }, { rx: 0.33, ry: 0.2, y: 0.46, fs: 0.036 });
      var cx = S.width / 2;
      var cy = L.y * S.height;
      var rx = L.rx * S.width;
      var ry = L.ry * S.height;
      var fs = L.fs * unit * P.size;

      var labels = parts(P.items, 8);
      var n = labels.length;

      var group = document.getElementById("group");
      group.style.transformOrigin = cx + "px " + cy + "px";

      // The path the labels follow: a hairline ellipse in the accent colour.
      var path = document.getElementById("path");
      path.style.left = cx - rx + "px";
      path.style.top = cy - ry + "px";
      path.style.width = 2 * rx + "px";
      path.style.height = 2 * ry + "px";
      path.style.border = Math.max(1, unit * 0.003) + "px solid " + alpha(P.accent, 0.4);

      // The middle: the logo, or the word on an accent rule. Its width stays inside the ring's left and right labels.
      var core = document.getElementById("core");
      var logo = document.getElementById("logo");
      var word = document.getElementById("word");
      var rule = document.getElementById("rule");
      var text = String(P.word).trim();
      var room = 1.1 * rx;
      if (P.logo) {
        logo.src = P.logo;
        logo.style.height = Math.min(0.2 * unit * P.size, 0.8 * ry) + "px";
        logo.style.maxWidth = room + "px";
        word.style.display = "none";
        rule.style.display = "none";
      } else {
        logo.style.display = "none";
        word.textContent = text;
        // Letters are about 0.6 em wide: the word shrinks until it fits inside the ring without measuring text.
        var wordPx = Math.min(0.075 * unit * P.size, room / (Math.max(1, text.length) * 0.6));
        word.style.fontSize = wordPx + "px";
        word.style.color = P.ink;
        core.style.fontSize = wordPx + "px";
        rule.style.background = P.accent;
        if (!text) {
          word.style.display = "none";
          rule.style.display = "none";
        }
      }
      core.style.left = cx + "px";
      core.style.top = cy + "px";
      core.style.width = "0px";
      core.style.height = "0px";

      // The labels share the room left of the frame edge beside the ring's far points.
      var chipMax = 2 * (0.5 - L.rx * 1.03 - 0.045) * S.width;
      var seed = seedOf(P.seed);
      // Where the circling starts, in turns past the resting ring, and which way it goes: from the seed only.
      var phase = (jitter(seed, 1) + 1) * Math.PI;
      var dir = jitter(seed, 2) >= 0 ? 1 : -1;
      // Resting angles: evenly spaced, the first label at the front (bottom of the ring).
      var rest = labels.map(function (_label, i) { return Math.PI / 2 + (2 * Math.PI * i) / n; });
      var slots = labels.map(function (label) {
        var slot = document.createElement("div");
        slot.className = "slot";
        slot.style.left = cx + "px";
        slot.style.top = cy + "px";
        var chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = label;
        chip.style.fontSize = fs + "px";
        chip.style.maxWidth = chipMax + "px";
        chip.style.background = P.card;
        chip.style.color = onColor(P.card);
        slot.appendChild(chip);
        group.appendChild(slot);
        return chip;
      });

      var D = S.duration;
      var OUT = 0.3;
      var FIRST = 0.15;
      // The circling starts as the first label leaves the middle and has stopped, with a beat of hold, before the exit.
      var spinTime = Math.min(P.spinTime, Math.max(0.6, D - OUT - FIRST - 0.4));

      M.bind("${id}", function (t) {
        var out = M.ease("exit", (t - (D - OUT)) / OUT);
        M.write(backdrop, { opacity: P.backdrop * M.ease("enter", t / 0.3) * (1 - out) });
        // Holds never stop: the whole ring pushes in slowly.
        put(group, { scale: 1 + 0.025 * Math.min(1, t / D) - 0.025 * out, opacity: 1 - out });
        M.write(path, { opacity: M.ease("enter", (t - FIRST) / 0.5) });
        var s = M.spring("playful", t - 0.05);
        put(core, { scale: 0.6 + 0.4 * s, opacity: M.ease("enter", (t - 0.05) / 0.2) });
        // The turns still to go: all of them at the start, none once the ease has run out.
        var left = 1 - M.ease("enter", (t - FIRST) / spinTime);
        for (var i = 0; i < n; i++) {
          var k = M.spring("default", t - FIRST - 0.06 * i);
          var a = rest[i] + dir * (P.turns * 2 * Math.PI + phase) * left;
          // 0 at the back of the ring, 1 at the front.
          var depth = (1 + Math.sin(a)) / 2;
          put(slots[i], {
            x: rx * Math.cos(a) * k,
            y: ry * Math.sin(a) * k,
            scale: (0.78 + 0.22 * depth) * (0.5 + 0.5 * k),
            opacity: (0.5 + 0.5 * depth) * M.ease("enter", (t - FIRST - 0.06 * i) / 0.2),
          });
        }
      });
    </script>
  </body>
</html>
`;
  },
};
