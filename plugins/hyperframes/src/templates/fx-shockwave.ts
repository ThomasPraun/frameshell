import { fxTemplate } from "./fx-kit.js";

/** Shockwave (#802): a ring that leaves the point fast, slows, thins and fades; a second, fainter one follows. */
export const fxShockwave = fxTemplate({
  id: "fx-shockwave",
  description: "Shockwave: on each hit a ring leaves a point fast, slows, thins and fades, a fainter second ring a step behind it; additive light, transparent overlay",
  count: null,
  life: 0.7,
  at: { x: 0.5, y: 0.5 },
  blend: "lighter",
  draw: String.raw`
        for (var ring = 0; ring < 2; ring++) {
          var a = age - ring * 0.08 * LIFE;
          if (a <= 0) continue;
          var u = Math.min(1, a / LIFE);
          var grow = 1 - Math.pow(1 - u, 3);
          ctx.strokeStyle = alpha(ring === 0 ? colors[0] : colors[1], Math.pow(1 - u, 2) * (ring === 0 ? 1 : 0.5));
          ctx.lineWidth = Math.max(1, 0.025 * unit * (1 - u));
          ctx.beginPath(); ctx.arc(X, Y, 0.02 * unit + 0.5 * unit * grow, 0, 2 * Math.PI); ctx.stroke();
        }`,
});
