import {
  COLOR_HELPERS,
  PLACEHOLDER,
  SEED_HELPERS,
  STEP_TIMES,
  type Template,
  type TemplateInput,
  type TemplateVariable,
  onBeatsVariable,
  pageHead,
} from "./kit.js";

/**
 * What one overlay effect of the `fx-*` family (#802) adds to the shared page: its own defaults, a description, and the
 * page-script body of `draw(age, hit, seed)` that paints one hit `age` seconds after it, on `ctx`. The body sees `P`
 * (props), `S` (stage), `unit` (short side, px), `LIFE` (seconds a hit lasts), `X`, `Y` (centre, px), `colors` (three
 * hex colours: the main one, the second one, a light core), `jitter`, `mix`, `alpha`, and `fade` (1 down to 0 over the
 * clip's last moments, already applied by the caller to `ctx.globalAlpha`).
 */
export interface FxEffect {
  id: string;
  description: string;
  /** Particles or rays per hit; null when the effect has no count. */
  count: { default: number; min: number; max: number } | null;
  /** Default seconds one hit lasts. */
  life: number;
  /** Default centre, as fractions of the frame. */
  at: { x: number; y: number };
  /** `lighter` (additive light) or `source-over` (solid pieces). */
  blend: "lighter" | "source-over";
  /** Page-script statements run once before the first frame (per-effect constants). */
  setup?: string;
  /** Page-script body of `function draw(age, hit, seed)`. */
  draw: string;
}

/** The typed props every `fx-*` template shares; `count` only when the effect has one. */
function fxVariables(effect: FxEffect, input: TemplateInput): TemplateVariable[] {
  const { colors } = input.tokens;
  const variables: TemplateVariable[] = [
    { id: "seed", type: "string", label: "Any text; a different one scatters the pieces another way, for variants of the same look", default: "frameshell", maxLength: 40 },
    { id: "color", type: "color", label: "Main colour", default: colors.accent ?? PLACEHOLDER.accent },
    { id: "color2", type: "color", label: "Second colour", default: colors.ink ?? PLACEHOLDER.ink },
    { id: "x", type: "number", label: "Centre across the frame, 0 = left edge, 1 = right edge", default: effect.at.x, min: 0, max: 1, step: 0.01 },
    { id: "y", type: "number", label: "Centre down the frame, 0 = top, 1 = bottom", default: effect.at.y, min: 0, max: 1, step: 0.01 },
    { id: "size", type: "number", label: "Size, 1 = the format's default", default: 1, min: 0.3, max: 2.5, step: 0.05 },
    { id: "intensity", type: "number", label: "Strength, 1 = the strongest the template paints", default: 0.85, min: 0.1, max: 1, step: 0.05 },
    { id: "life", type: "number", label: "Seconds one hit lasts", default: effect.life, min: 0.2, max: 3, step: 0.05, unit: "s" },
    { id: "startAt", type: "number", label: "Second of the first hit", default: 0.2, min: 0, max: 10, step: 0.05, unit: "s" },
    { id: "hits", type: "number", label: "How many hits", default: 1, min: 1, max: 16, step: 1 },
    { id: "gap", type: "number", label: "Seconds between hits (with onBeats: the fallback when there is no beat grid)", default: 0.5, min: 0.1, max: 4, step: 0.05, unit: "s" },
    onBeatsVariable("the hits", "startAt"),
  ];
  if (effect.count) variables.splice(5, 0, { id: "count", type: "number", label: "Pieces per hit", default: effect.count.default, min: effect.count.min, max: effect.count.max, step: 1 });
  return variables;
}

/**
 * A transparent overlay of the `fx-*` family (#802): seeded particles or light drawn on one canvas as a pure function of
 * time, so every seek paints the same frame. Hits fall at `startAt`, `gap` apart, or on the music's beats (`onBeats`),
 * pulled in so the last hit has its whole `life` before the clip ends; the canvas is clear at the first frame (unless a
 * hit is at 0) and for the last tenth of a second, so the clip never pops at its cut-out. Colours come from the style
 * guide's accent and ink at scaffold time.
 */
export function fxTemplate(effect: FxEffect): Template {
  return {
    id: effect.id,
    description: effect.description,
    defaultDuration: 2,
    overlay: true,
    variables(input: TemplateInput): TemplateVariable[] {
      return fxVariables(effect, input);
    },
    render(input: TemplateInput): string {
      const { id, width, height, duration } = input;
      const css = "#fx { position: absolute; inset: 0; }";
      return `${pageHead(input, this.variables(input), css)}
  <body>
    <!-- Root: size and length of the render. FrameshellMotion.bind below registers its timeline. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
      <div id="${id}-clip" class="clip">
        <canvas id="fx" width="${width}" height="${height}"></canvas>
      </div>
    </div>
    <script>
      var M = window.FrameshellMotion;
      var P = M.props();
      var S = M.stage();
      ${COLOR_HELPERS}
      ${SEED_HELPERS}
      ${STEP_TIMES}
      // Size per format, as a multiple of the short side: wide, square, tall.
      var L = M.pick({ k: 1 }, { k: 1 }, { k: 1.1 });
      var unit = Math.min(S.width, S.height) * L.k * P.size;
      var D = S.duration || 2;
      // Clear for the last tenth of a second: the last rendered frame is a frame before D.
      var END = Math.min(0.1, 0.4 * D);
      var LIFE = Math.min(P.life, Math.max(0.05, D - END));
      var X = P.x * S.width, Y = P.y * S.height;
      var colors = [P.color, P.color2, mix(P.color, "#ffffff", 0.55)];
      var ctx = document.getElementById("fx").getContext("2d");
      var base = seedOf(P.seed);
      // Every hit decided before the first frame, nothing from a clock.
      var HITS = Math.round(P.hits);
      var hits = stepTimes(P.startAt, P.gap, HITS, P.onBeats, D - END - LIFE, 0.08, true);
      ${effect.setup ?? ""}
      function draw(age, hit, seed) {
        ${effect.draw}
      }

      M.bind("${id}", function (t) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 1;
        ctx.clearRect(0, 0, S.width, S.height);
        var fade = Math.min(1, Math.max(0, (D - END - t) / 0.15));
        if (fade <= 0) return;
        ctx.globalCompositeOperation = "${effect.blend}";
        for (var h = 0; h < hits.length; h++) {
          var age = t - hits[h];
          if (age < 0 || age >= LIFE) continue;
          ctx.save();
          ctx.globalAlpha = fade * P.intensity;
          draw(age, h, base * 31 + h * 977);
          ctx.restore();
        }
      });
    </script>
  </body>
</html>
`;
    },
  };
}
