import {
  COLOR_HELPERS,
  FLAT_HELPERS,
  SEED_HELPERS,
  type Template,
  type TemplateInput,
  type TemplateVariable,
  pageHead,
} from "./kit.js";

/**
 * Light leak (#466, owner decision 2026-11-16): a warm glow that swells in from
 * a corner of the frame and falls away, laid over a cut on a track above. It is
 * an overlay clip, never a timeline operation, so the cut underneath keeps its
 * length. Three soft radial gradients (no blend mode: one once rendered a whole
 * film white), the corner and the offsets chosen by a seeded hash, so one `seed`
 * always paints the same frame. Transparent outside the glow, and every pixel
 * clear at the first frame and for the last tenth of a second (a render's last
 * frame is a frame short of the clip's length): the clip's length is the leak's
 * length and the peak sits at `peak` of it.
 */
export const lightLeak: Template = {
  id: "light-leak",
  description: "Light leak over a cut: a warm glow swells in from a corner and falls away, seeded, hue-shiftable, clear at the start and just before the end; an overlay for a track above, never shortens the timeline",
  defaultDuration: 1,
  overlay: true,
  variables(_input: TemplateInput): TemplateVariable[] {
    return [
      { id: "seed", type: "string", label: "Any text; a different one moves the leak to another corner and shape, for variants of the same look", default: "frameshell", maxLength: 40 },
      { id: "tint", type: "color", label: "Leak colour", default: "#ff8a3d" },
      { id: "hue", type: "number", label: "Hue shift of the leak colour, degrees", default: 0, min: -180, max: 180, step: 5, unit: "°" },
      { id: "intensity", type: "number", label: "Strength at the peak, 1 = the strongest the template paints (still see-through)", default: 0.7, min: 0.1, max: 1, step: 0.05 },
      { id: "peak", type: "number", label: "Where the peak falls in the clip, 0.5 = the middle", default: 0.5, min: 0.25, max: 0.75, step: 0.05 },
      { id: "size", type: "number", label: "Size of the glow, 1 = the format's default", default: 1, min: 0.6, max: 1.6, step: 0.05 },
    ];
  },
  render(input: TemplateInput): string {
    const { id, width, height, duration } = input;
    const css = `
      #leak { position: absolute; inset: 0; overflow: hidden; }
      .blob { position: absolute; border-radius: 50%; }`;
    return `${pageHead(input, this.variables(input), css)}
  <body>
    <!-- Root: size and length of the render. FrameshellMotion.bind below registers its timeline, so the render
         does not wait for one. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
      <div id="light-leak-clip" class="clip">
        <div id="leak"></div>
      </div>
    </div>
    <script>
      var M = window.FrameshellMotion;
      var P = M.props();
      var S = M.stage();
      var unit = Math.min(S.width, S.height);
      ${COLOR_HELPERS}
      ${FLAT_HELPERS}
      ${SEED_HELPERS}

      // Layout per format: diameter of the main glow as a multiple of the short side. wide, square, tall.
      var L = M.pick({ d: 1.5 }, { d: 1.25 }, { d: 1.4 });
      var D = S.duration || 1;
      // The glow is gone this long before the clip ends: the last rendered frame is a frame before D, and the leak must not pop off at the cut-out.
      var END = Math.min(0.1, 0.12 * D);
      // The most any pixel is covered at the peak: a leak shows the picture through it, it never whites it out.
      var CAP = 0.55;

      // Hue rotation of a hex colour, the matrix of the CSS hue-rotate() filter.
      function turn(hex, deg) {
        var a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), v = rgb(hex);
        var m = [0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928, 0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283, 0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072];
        return "#" + [0, 1, 2].map(function (i) { return ("0" + Math.max(0, Math.min(255, Math.round(m[3 * i] * v[0] + m[3 * i + 1] * v[1] + m[3 * i + 2] * v[2]))).toString(16)).slice(-2); }).join("");
      }
      var tint = turn(P.tint, P.hue);
      // The main glow in the tint, a second one a step toward red, a small light core that is cream, never white.
      var colors = [tint, turn(tint, -24), mix(tint, "#fff0cf", 0.6)];

      // The seed picks the corner and nudges each glow: all of it decided before the first frame, nothing drawn from a clock.
      var seed = seedOf(P.seed);
      var corner = seed % 4;
      var side = corner % 2 ? 1 : 0;
      var row = corner > 1 ? 1 : 0;
      var diameter = L.d * unit * P.size;
      // [centre x, centre y, diameter, share of the strength], as fractions of the frame for the centres.
      var blobs = [
        [side + (0.5 - side) * 0.1 * (1 + jitter(seed, 1)), row + (0.5 - row) * 0.1 * (1 + jitter(seed, 2)), 1, 1],
        [side + (0.5 - side) * (0.55 + 0.2 * jitter(seed, 3)), row + (0.5 - row) * (0.12 + 0.1 * jitter(seed, 4)), 0.7, 0.7],
        [side + (0.5 - side) * (0.12 + 0.05 * jitter(seed, 5)), row + (0.5 - row) * (0.12 + 0.05 * jitter(seed, 6)), 0.4, 0.8],
      ];
      var leak = document.getElementById("leak");
      var els = blobs.map(function (b, i) {
        var el = document.createElement("i");
        var d = diameter * b[2];
        el.className = "blob";
        el.style.width = d + "px";
        el.style.height = d + "px";
        el.style.left = b[0] * S.width - d / 2 + "px";
        el.style.top = b[1] * S.height - d / 2 + "px";
        el.style.background = "radial-gradient(circle at center, " + alpha(colors[i], 0.95) + " 0%, " + alpha(colors[i], 0.5) + " 32%, " + alpha(colors[i], 0) + " 68%)";
        leak.appendChild(el);
        return el;
      });
      // How far the glow slides toward the middle of the frame over the clip, and which way.
      var drift = 0.07 + 0.03 * jitter(seed, 7);

      M.bind("${id}", function (t) {
        // Rise to the peak and fall away: a smoothstep on each side, exactly 0 at the first frame and from D - END on.
        var f = t / (D - END);
        var u = Math.min(1, Math.max(0, f < P.peak ? f / P.peak : (1 - f) / (1 - P.peak)));
        var env = u * u * (3 - 2 * u);
        for (var i = 0; i < els.length; i++) {
          put(els[i], {
            x: (0.5 - side) * drift * S.width * Math.min(1, Math.max(0, f)) * (1 + 0.5 * i),
            y: (0.5 - row) * drift * S.height * Math.min(1, Math.max(0, f)),
            scale: 0.85 + 0.2 * env,
            opacity: CAP * P.intensity * blobs[i][3] * env,
          });
        }
      });
    </script>
  </body>
</html>
`;
  },
};
