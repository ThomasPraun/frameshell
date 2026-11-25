import { fxTemplate } from "./fx-kit.js";

/** Glow pulse (#802): a soft light that flares on the hit and dies away; additive light. */
export const fxGlow = fxTemplate({
  id: "fx-glow",
  description: "Glow pulse: a soft round light flares at a point on each hit (40 ms attack) and dies away while it widens; additive light, never opaque, transparent overlay",
  count: null,
  life: 0.8,
  at: { x: 0.5, y: 0.5 },
  blend: "lighter",
  draw: String.raw`
        var u = age / LIFE;
        var env = Math.min(1, age / 0.04) * Math.pow(1 - u, 2);
        var r = unit * 0.38 * (0.8 + 0.45 * u);
        var glow = ctx.createRadialGradient(X, Y, 0, X, Y, r);
        glow.addColorStop(0, alpha(colors[2], 0.75 * env));
        glow.addColorStop(0.3, alpha(colors[0], 0.5 * env));
        glow.addColorStop(1, alpha(colors[0], 0));
        ctx.fillStyle = glow;
        ctx.fillRect(X - r, Y - r, 2 * r, 2 * r);`,
});
