import {
  COLOR_HELPERS,
  PLACEHOLDER,
  type Template,
  type TemplateInput,
  type TemplateVariable,
  pageHead,
} from "./kit.js";
import { UI_HELPERS } from "./ui-parts.js";

/**
 * Scene background (#466): a full-screen backdrop for the clips above it.
 * Soft gradient orbs drift on closed loops, a grid (120 px at 1080 p) fades
 * out toward the edges under a radial mask and slides one cell over the clip,
 * a vignette darkens the corners and film grain flickers on. Radial gradients
 * for the orbs, vignette and mask (smooth dark ramps band in H.264 as linear
 * ones do; the grid's hard-stop lines do not), no blend modes and no blur.
 * Opaque from the first frame, so it can sit under a cut. Paints its own
 * background.
 */
export const sceneBackground: Template = {
  id: "scene-background",
  description: "Full-screen scene background: drifting gradient orbs, a masked grid, vignette and grain; opaque, for a track under other clips",
  defaultDuration: 8,
  overlay: false,
  variables({ tokens }: TemplateInput): TemplateVariable[] {
    return [
      { id: "bg", type: "color", label: "Background colour", default: tokens.colors.bg ?? PLACEHOLDER.bg },
      { id: "accent", type: "color", label: "First orb colour", default: tokens.colors.accent ?? PLACEHOLDER.accent },
      { id: "accent2", type: "color", label: "Second orb colour", default: "#4f7cff" },
      { id: "seed", type: "string", label: "Any text; a different one moves the orbs to other phases, for variants of the same look", default: "frameshell", maxLength: 40 },
      { id: "orbs", type: "number", label: "Number of orbs", default: 3, min: 1, max: 4, step: 1 },
      { id: "glow", type: "number", label: "Orb strength", default: 0.4, min: 0.2, max: 1, step: 0.05 },
      { id: "motion", type: "number", label: "How far the orbs drift, 0 = still", default: 0.5, min: 0, max: 1, step: 0.05 },
      { id: "grid", type: "number", label: "Grid strength, 0 = no grid", default: 0.5, min: 0, max: 1, step: 0.05 },
      { id: "gridSize", type: "number", label: "Grid cell at 1080 p", default: 120, min: 40, max: 300, step: 10, unit: "px" },
      { id: "vignette", type: "number", label: "Darkening of the corners, 0 = none", default: 0.55, min: 0, max: 1, step: 0.05 },
      { id: "grain", type: "number", label: "Film grain, 0 = none", default: 0.5, min: 0, max: 1, step: 0.05 },
    ];
  },
  render(input: TemplateInput): string {
    const { id, width, height, duration } = input;
    const css = `
      #base, #orbs, #mask, #vig, #grain { position: absolute; inset: 0; }
      .orb { position: absolute; border-radius: 50%; }
      #orbs, #mask { overflow: hidden; }
      #grid { position: absolute; }`;
    return `${pageHead(input, this.variables(input), css)}
  <body>
    <!-- Root: size and length of the render. FrameshellMotion.bind below registers its timeline, so the render
         does not wait for one. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
      <div id="scene-background-clip" class="clip">
        <div id="base"></div>
        <div id="orbs"></div>
        <div id="mask"><div id="grid"></div></div>
        <div id="vig"></div>
        <div id="grain"></div>
      </div>
    </div>
    <script>
      var M = window.FrameshellMotion;
      var P = M.props();
      var S = M.stage();
      var unit = Math.min(S.width, S.height);
      ${COLOR_HELPERS}
      ${UI_HELPERS}

      var D = S.duration || 1;
      // Frame size per format: the short side stands for 1080 p, and orbs are a bit smaller on wide frames.
      var L = M.pick({ orb: 1.0 }, { orb: 1.1 }, { orb: 1.1 });
      var scale = unit / 1080;
      // The seed text becomes one number in 0..1 (a small string hash) that offsets every orb's phase.
      var hash = 0;
      String(P.seed).split("").forEach(function (ch) { hash = (hash * 31 + ch.charCodeAt(0)) % 9973; });
      var shift = hash / 9973;
      document.getElementById("base").style.background = P.bg;

      // Orbs: radial gradients (no blur), spread over the frame, each on a closed loop of the clip (1 or 2 turns), so the clip repeats without a seam.
      var HOME = [[0.25, 0.3], [0.75, 0.35], [0.5, 0.8], [0.15, 0.85]];
      var holder = document.getElementById("orbs");
      var diameter = Math.max(unit * L.orb, Math.max(S.width, S.height) * 0.6);
      var orbs = [];
      for (var i = 0; i < Math.round(P.orbs); i++) {
        var el = document.createElement("i");
        el.className = "orb";
        el.style.width = diameter + "px";
        el.style.height = diameter + "px";
        el.style.left = HOME[i][0] * S.width - diameter / 2 + "px";
        el.style.top = HOME[i][1] * S.height - diameter / 2 + "px";
        el.style.background = "radial-gradient(circle at center, " + rgba(i % 2 ? P.accent2 : P.accent, P.glow) + " 0%, " + rgba(i % 2 ? P.accent2 : P.accent, 0) + " 64%)";
        holder.appendChild(el);
        orbs.push(el);
      }

      // The grid: thin lines every gridSize px, oversized by one cell so sliding it a cell never shows an edge; a static radial mask fades it toward the edges.
      var cell = Math.max(24, P.gridSize * scale);
      var line = Math.max(1, Math.round(scale));
      var grid = document.getElementById("grid");
      var maskBox = document.getElementById("mask");
      if (P.grid > 0) {
        var ink = rgba(onColor(P.bg), 0.06 + 0.18 * P.grid);
        grid.style.left = -cell + "px";
        grid.style.top = -cell + "px";
        grid.style.width = S.width + 2 * cell + "px";
        grid.style.height = S.height + 2 * cell + "px";
        grid.style.backgroundImage = "linear-gradient(to right, " + ink + " " + line + "px, rgba(0, 0, 0, 0) " + line + "px), linear-gradient(to bottom, " + ink + " " + line + "px, rgba(0, 0, 0, 0) " + line + "px)";
        grid.style.backgroundSize = cell + "px " + cell + "px";
        var fade = "radial-gradient(ellipse at 50% 50%, #000 0%, rgba(0, 0, 0, 0) 72%)";
        maskBox.style.webkitMaskImage = fade;
        maskBox.style.maskImage = fade;
      } else {
        maskBox.style.display = "none";
      }

      var vig = document.getElementById("vig");
      if (P.vignette > 0) vig.style.background = "radial-gradient(ellipse at 50% 50%, rgba(0, 0, 0, 0) 42%, rgba(0, 0, 0, " + 0.7 * P.vignette + ") 100%)";
      else vig.style.display = "none";

      // Grain: one tile of fractal noise, moved to a new place every 1/24 s, so it flickers like film and is the same on every seek.
      var TILE = 220;
      var grain = document.getElementById("grain");
      if (P.grain > 0) {
        var svg = "<svg xmlns='http://www.w3.org/2000/svg' width='" + TILE + "' height='" + TILE + "'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='100%' height='100%' filter='url(#n)'/></svg>";
        grain.style.backgroundImage = 'url("data:image/svg+xml;utf8,' + encodeURIComponent(svg) + '")';
        grain.style.backgroundSize = TILE + "px " + TILE + "px";
        grain.style.opacity = String(0.03 + 0.12 * P.grain);
      } else {
        grain.style.display = "none";
      }

      var TWO_PI = Math.PI * 2;
      M.bind("${id}", function (t) {
        var turn = t / D;
        for (var i = 0; i < orbs.length; i++) {
          var loops = 1 + (i % 2);
          var reach = P.motion * 0.14;
          M.write(orbs[i], {
            x: Math.sin(TWO_PI * (loops * turn + i * 0.37 + shift)) * reach * S.width,
            y: Math.cos(TWO_PI * (loops * turn + i * 0.21 + shift)) * reach * S.height,
            scale: 1 + 0.06 * P.motion * Math.sin(TWO_PI * (turn + i * 0.25 + shift)),
          });
        }
        // Holds never stop: the grid slides one cell over the clip.
        M.write(grid, { x: (turn % 1) * cell, y: (turn % 1) * cell });
        var frame = Math.floor(t * 24);
        grain.style.backgroundPosition = ((frame * 47) % TILE) + "px " + ((frame * 91) % TILE) + "px";
      });
    </script>
  </body>
</html>
`;
  },
};
